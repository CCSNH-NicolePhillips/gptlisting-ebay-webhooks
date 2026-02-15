import type { Handler } from '../../src/types/api-handler.js';
import { requireUserAuth } from "../../src/lib/auth-user.js";
import { getOrigin, jsonResponse } from "../../src/lib/http.js";
import { pickCategoryForGroup } from "../../src/lib/taxonomy-select.js";
import { listCategories } from "../../src/lib/taxonomy-store.js";
import type { CategoryDef } from "../../src/lib/taxonomy-schema.js";
import { openai } from "../../src/lib/openai.js";
import { getFinalEbayPrice, getCategoryCap } from "../../src/lib/pricing-compute.js";
import { getDeliveredPricing, type DeliveredPricingDecision } from "../../src/lib/delivered-pricing.js";

const METHODS = "POST, OPTIONS";
const MODEL = process.env.GPT_MODEL || "gpt-4o"; // Use gpt-4o for web search capability
const MAX_TOKENS = Number(process.env.GPT_MAX_TOKENS || 700);
const GPT_RETRY_ATTEMPTS = Math.max(1, Number(process.env.GPT_RETRY_ATTEMPTS || 1));
const GPT_RETRY_DELAY_MS = Math.max(250, Number(process.env.GPT_RETRY_DELAY_MS || 1500));
const GPT_TIMEOUT_MS = Math.max(5000, Number(process.env.GPT_TIMEOUT_MS || 30000)); // Longer timeout for web search
const MAX_SEEDS = Math.max(1, Number(process.env.DRAFTS_MAX_SEEDS || 1)); // Process 1 item per request to avoid Netlify timeout

/**
 * Feature flag for delivered-price-first pricing v2
 * Set DELIVERED_PRICING_V2=true to enable new competitive pricing
 */
const DELIVERED_PRICING_ENABLED = process.env.DELIVERED_PRICING_V2 === 'true';

/**
 * Apply pricing formula to base retail price using the ONE centralized pricing function.
 * All pricing logic lives in pricing-compute.ts - this is just a thin wrapper.
 */
function computeEbayPrice(base: number, categoryPath?: string): number {
  return getFinalEbayPrice(base, { categoryCap: getCategoryCap(categoryPath) });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Timeout wrapper for promises
 */
async function withTimeout<T>(p: Promise<T>, ms = GPT_TIMEOUT_MS): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}

type PairedProduct = {
  productId: string;
  brand: string;
  product: string;
  variant?: string | null;
  size?: string | null;
  categoryPath?: string;
  frontUrl: string;
  backUrl: string | null; // Allow null for front-only products
  heroDisplayUrl: string;
  backDisplayUrl: string | null; // Allow null for front-only products
  extras?: string[];
  evidence?: string[];
  extractedText?: string; // Text extracted from product photos (front + back)
};

type CategoryHint = {
  id: string;
  title: string;
  aspects?: Record<string, any>;
};

type Draft = {
  productId: string;
  brand: string;
  product: string;
  title: string;
  description: string;
  bullets: string[];
  aspects: Record<string, string[]>;
  category: CategoryHint;
  images: string[];
  price?: number;
  shippingPrice?: number;  // New: for delivered-pricing v2
  condition?: string;
  pricingEvidence?: {      // New: evidence log for delivered-pricing v2
    mode: string;
    targetDeliveredCents: number;
    finalItemCents: number;
    finalShipCents: number;
    ebayCompsCount: number;
    fallbackUsed: boolean;
    warnings: string[];
  };
};

/**
 * Call OpenAI with retry logic and timeout
 */
async function callOpenAI(prompt: string): Promise<string> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY");
  }
  
  let lastError: unknown;
  for (let attempt = 1; attempt <= GPT_RETRY_ATTEMPTS; attempt++) {
    try {
      const completion = await withTimeout(
        openai.chat.completions.create({
          model: MODEL,
          temperature: 0.7,
          max_tokens: Math.max(100, Math.min(4000, MAX_TOKENS)),
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "You are an expert eBay listing writer with real-time web access.\n" +
                "Return ONLY strict JSON with keys: title, description, bullets, aspects, price, condition.\n" +
                "- title: <=80 chars, SEO-RICH product name with specific details (vitamins, dosages, formulation). NO generic words. NO emojis. Include brand + key ingredients/benefits.\n" +
                "  Examples: 'Nusava Vitamin B12 5000mcg + B6 Liquid Drops Sublingual 2 Fl Oz'\n" +
                "           'Garden of Life Raw Probiotics Women 90 Capsules 32 Strains 85 Billion CFU'\n" +
                "- description: 2-4 sentences with SPECIFIC details from the label. Include ingredients, dosages, benefits. NO vague marketing language.\n" +
                "- bullets: array of 3-5 specific feature/benefit points with numbers and details.\n" +
                "- aspects: object with Brand, Type, Features, Size, Active Ingredients, Formulation, etc. Be SPECIFIC.\n" +
                "- price: CRITICAL - Search Amazon.com for 'Typical Price' or 'List Price' (NOT Black Friday/sale prices, NOT third-party marketplace sellers). Use Amazon's direct price or manufacturer MSRP only. For books, use new hardcover/paperback publisher price (NOT collectible/rare editions). Match EXACT size/variant in photos (30-day vs 90-day supply, 8oz vs 16oz). If you see prices over $50 for common supplements/books, you're looking at wrong variant or marketplace pricing. Return ONLY the number (e.g. 24.99).\n" +
                "- condition: one of 'NEW', 'LIKE_NEW', 'USED_EXCELLENT', 'USED_GOOD', 'USED_ACCEPTABLE'. Assume NEW unless description indicates otherwise.\n",
            },
            { role: "user", content: prompt },
          ],
        }),
        GPT_TIMEOUT_MS
      );
      return completion.choices?.[0]?.message?.content || "{}";
    } catch (err) {
      lastError = err;
      if (attempt >= GPT_RETRY_ATTEMPTS) break;
      const delay = GPT_RETRY_DELAY_MS * attempt;
      console.warn(`[GPT] Attempt ${attempt} failed, retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }
  
  const message = lastError instanceof Error ? lastError.message : String(lastError || "OpenAI error");
  throw new Error(message);
}

/**
 * Get relevant eBay categories for GPT to choose from
 */
async function getRelevantCategories(product: PairedProduct): Promise<string> {
  try {
    const allCategories = await listCategories();
    
    // Filter to relevant categories based on product info
    const searchTerms = [
      product.product,
      product.brand,
      product.variant,
      product.categoryPath
    ].filter(Boolean).join(' ').toLowerCase();
    
    // Get categories that might be relevant (limit to 20 to keep token count low and response fast)
    const relevant = allCategories
      .filter(cat => {
        const catText = `${cat.title} ${cat.slug}`.toLowerCase();
        // Include if category contains any word from search terms
        return searchTerms.split(/\s+/).some(term => 
          term.length > 3 && catText.includes(term)
        );
      })
      .slice(0, 20)
      .map(cat => `${cat.id}: ${cat.title}`)
      .join('\n');
    
    if (relevant) {
      return relevant;
    }
    
    // If no relevant categories found, return a curated list of common categories
    const commonCats = [
      '261186', // Books
      '31411', // Health & Beauty
      '11450', // Clothing, Shoes & Accessories  
      '293', // Consumer Electronics
      '88433', // Vitamins & Dietary Supplements
      '99', // Everything Else
    ];
    
    const fallback = allCategories
      .filter(cat => commonCats.includes(cat.id))
      .map(cat => `${cat.id}: ${cat.title}`)
      .join('\n');
    
    return fallback;
  } catch (err) {
    console.error('[getRelevantCategories] Error:', err);
    return '';
  }
}

/**
 * Build GPT prompt from product data
 */
function buildPrompt(product: PairedProduct, categoryHint: CategoryHint | null, categories: string): string {
  const lines: string[] = [
    `Product: ${product.product}`,
  ];
  
  if (product.brand && product.brand !== "Unknown") {
    lines.push(`Brand: ${product.brand}`);
  }
  
  if (product.variant) {
    lines.push(`Variant: ${product.variant}`);
  }
  
  if (product.size) {
    lines.push(`Size: ${product.size}`);
  }
  
  if (product.categoryPath) {
    lines.push(`Category hint: ${product.categoryPath}`);
  }
  
  // Add extracted text from product photos (CRITICAL for SEO-rich titles)
  if (product.extractedText && product.extractedText.length > 0) {
    lines.push("");
    lines.push("=== TEXT EXTRACTED FROM PRODUCT PHOTOS ===");
    lines.push(product.extractedText);
    lines.push("=== END EXTRACTED TEXT ===");
    lines.push("");
    lines.push("IMPORTANT: Use the extracted text above to create an SEO-rich title and determine formulation:");
    lines.push("- Specific vitamins/ingredients mentioned (e.g., B12, B6, Folate, Niacin)");
    lines.push("- Dosages if visible (e.g., 5000mcg, 2400mcg)");
    lines.push("- Formulation detection rules:");
    lines.push("  * If text mentions 'mix', 'mixing instructions', 'add to water', 'shake', 'stir', 'flavor' (like Berry, Vanilla, etc.) → formulation is 'Powder'");
    lines.push("  * If text mentions 'capsule', 'capsules', 'caps', 'vcaps' → formulation is 'Capsule'");
    lines.push("  * If text mentions 'tablet', 'tablets', 'tabs' → formulation is 'Tablet'");
    lines.push("  * If text mentions 'liquid', 'drops', 'dropper', 'sublingual', 'fl oz' → formulation is 'Liquid'");
    lines.push("  * If text mentions 'gummy', 'gummies', 'chewable' → formulation is 'Gummy'");
    lines.push("- Key benefits/claims from the label");
    lines.push("");
  }
  
  if (categoryHint) {
    lines.push(`eBay category: ${categoryHint.title} (ID: ${categoryHint.id})`);
    
    // Include category aspects as hints
    if (categoryHint.aspects && Object.keys(categoryHint.aspects).length > 0) {
      const aspectHints = Object.entries(categoryHint.aspects)
        .slice(0, 5)
        .map(([key, val]: [string, any]) => {
          const values = Array.isArray(val?.values) ? val.values.slice(0, 3).join(', ') : '';
          return values ? `${key}: ${values}` : key;
        })
        .filter(Boolean);
      if (aspectHints.length > 0) {
        lines.push(`Suggested aspects: ${aspectHints.join('; ')}`);
      }
    }
  }
  
  if (product.evidence && product.evidence.length > 0) {
    lines.push(`Matching evidence: ${product.evidence.join('; ')}`);
  }
  
  lines.push("");
  
  // Add category selection (only if we have relevant categories)
  if (categories && categories.length > 0) {
    lines.push("Choose the most appropriate eBay category ID from this list:");
    lines.push(categories);
    lines.push("");
  }
  
  lines.push("Create a professional eBay listing with accurate details.");
  lines.push("IMPORTANT: Search Amazon.com and Walmart.com for CURRENT regular selling price (NOT sale/clearance/collectible prices). For books, use new hardcover/paperback price.");
  lines.push("Assess condition based on whether it appears to be new/sealed or used.");
  lines.push("");
  lines.push("Response format (JSON):");
  lines.push("{");
  if (categories && categories.length > 0) {
    lines.push('  "categoryId": "12345", // Choose the most appropriate eBay category ID from the list above');
  }
  lines.push('  "title": "...", // 80 chars max');
  lines.push('  "description": "...",');
  lines.push('  "bullets": ["...", "...", "..."], // 3-5 bullet points');
  lines.push('  "aspects": { "Brand": ["..."], "Type": ["..."], ... }, // Item specifics');
  lines.push('  "price": 29.99, // Current retail price from Amazon/Walmart');
  lines.push('  "condition": "NEW" // or "USED"');
  lines.push("}");
  
  return lines.join("\n");
}

/**
 * Pick the best eBay category for a product
 */
async function pickCategory(product: PairedProduct): Promise<CategoryHint | null> {
  try {
    console.log(`[Category] Picking for: ${product.brand} ${product.product}`);
    
    const category = await pickCategoryForGroup({
      brand: product.brand || undefined,
      product: product.product,
      variant: product.variant || undefined,
      size: product.size || undefined,
      claims: [],
      keywords: [],
    });
    
    if (!category) {
      console.warn(`[Category] No category found for: ${product.product}`);
      return null;
    }
    
    console.log(`[Category] Selected: ${category.title} (${category.id})`);
    
    return {
      id: category.id,
      title: category.title,
      aspects: {},
    };
  } catch (err) {
    console.error(`[Category] Error picking category:`, err);
    return null;
  }
}

/**
 * Parse and sanitize GPT response
 */
function parseGptResponse(responseText: string, product: PairedProduct): any {
  try {
    // Strip markdown code blocks if present (```json ... ```)
    let cleanText = responseText.trim();
    if (cleanText.startsWith('```')) {
      // Remove opening ```json and closing ```
      cleanText = cleanText.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }
    
    const parsed = JSON.parse(cleanText);
    return {
      categoryId: typeof parsed.categoryId === 'string' ? parsed.categoryId.trim() : undefined,
      title: typeof parsed.title === 'string' ? parsed.title.slice(0, 80) : `${product.brand} ${product.product}`.slice(0, 80),
      description: typeof parsed.description === 'string' ? parsed.description.slice(0, 1200) : `${product.brand} ${product.product}`,
      bullets: Array.isArray(parsed.bullets) ? parsed.bullets.slice(0, 5).map((b: any) => String(b).slice(0, 200)) : [],
      aspects: typeof parsed.aspects === 'object' && parsed.aspects !== null ? parsed.aspects : {},
      price: typeof parsed.price === 'number' && parsed.price > 0 ? parsed.price : undefined,
      condition: typeof parsed.condition === 'string' ? parsed.condition : 'NEW',
    };
  } catch (err) {
    console.error('[GPT] Failed to parse response:', err);
    return {
      categoryId: undefined,
      title: `${product.brand} ${product.product}`.slice(0, 80),
      description: `${product.brand} ${product.product}`,
      bullets: [],
      aspects: {},
      price: undefined,
      condition: 'NEW',
    };
  }
}

/**
 * Normalize aspects to string arrays
 */
function normalizeAspects(aspects: any, product: PairedProduct): Record<string, string[]> {
  const normalized: Record<string, string[]> = {};
  
  if (typeof aspects === 'object' && aspects !== null) {
    for (const [key, value] of Object.entries(aspects)) {
      if (Array.isArray(value)) {
        const stringValues = value.map(v => String(v).trim()).filter(Boolean);
        if (stringValues.length > 0) {
          normalized[key] = stringValues.slice(0, 10);
        }
      } else if (value !== null && value !== undefined) {
        const stringValue = String(value).trim();
        if (stringValue) {
          normalized[key] = [stringValue];
        }
      }
    }
  }
  
  // Ensure Brand is included
  if (product.brand && product.brand !== "Unknown" && !normalized.Brand) {
    normalized.Brand = [product.brand];
  }
  
  // Ensure Size if available
  if (product.size && !normalized.Size) {
    normalized.Size = [product.size];
  }
  
  return normalized;
}

/**
 * Create a draft for a single product
 */
async function createDraftForProduct(product: PairedProduct): Promise<Draft> {
  const startTime = Date.now();
  console.log(`[Draft] Creating for: ${product.productId}`);
  
  // Step 1: Get relevant categories for GPT to choose from
  const catListStart = Date.now();
  const relevantCategories = await getRelevantCategories(product);
  console.log(`[Draft] Category list generation took ${Date.now() - catListStart}ms for ${product.productId}`);
  
  // Step 2: Pick category as fallback (in case GPT doesn't provide one)
  const catStart = Date.now();
  const categoryHint = await pickCategory(product);
  console.log(`[Draft] Category fallback pick took ${Date.now() - catStart}ms for ${product.productId}`);
  
  // Step 3: Build GPT prompt with category list
  const prompt = buildPrompt(product, categoryHint, relevantCategories);
  console.log(`[Draft] GPT prompt for ${product.productId}:`, prompt.slice(0, 200) + '...');
  
  // Step 4: Call GPT
  const gptStart = Date.now();
  const responseText = await callOpenAI(prompt);
  console.log(`[Draft] GPT call took ${Date.now() - gptStart}ms for ${product.productId}`);
  console.log(`[Draft] GPT response for ${product.productId}:`, responseText.slice(0, 300) + '...');
  
  // Step 5: Parse response
  const parsed = parseGptResponse(responseText, product);
  
  // Step 6: Get category from GPT's response or use fallback
  let finalCategory: CategoryHint | null = categoryHint;
  if (parsed.categoryId) {
    console.log(`[Draft] GPT selected category ID: ${parsed.categoryId}`);
    try {
      const { getCategoryById } = await import("../../src/lib/taxonomy-store.js");
      const gptCategory = await getCategoryById(parsed.categoryId);
      if (gptCategory) {
        finalCategory = {
          id: gptCategory.id,
          title: gptCategory.title || gptCategory.slug || '',
          aspects: {},
        };
        console.log(`[Draft] Using GPT category: ${finalCategory.title} (${finalCategory.id})`);
      } else {
        console.warn(`[Draft] GPT category ${parsed.categoryId} not found, using fallback`);
      }
    } catch (err) {
      console.error(`[Draft] Error loading GPT category:`, err);
    }
  } else {
    console.log(`[Draft] GPT did not provide categoryId, using fallback`);
  }
  
  // Step 7: Normalize aspects
  const aspects = normalizeAspects(parsed.aspects, product);
  
  // Step 8: Collect images (filter removes nulls for front-only products)
  const images = [product.heroDisplayUrl, product.backDisplayUrl, ...(product.extras || [])].filter((url): url is string => Boolean(url));
  
  // 🔍 DEBUG: Log images being added to draft
  console.log(`[Draft] 🖼️ Images for ${product.productId}:`);
  console.log(`[Draft]   heroDisplayUrl: ${product.heroDisplayUrl || 'MISSING'}`);
  console.log(`[Draft]   backDisplayUrl: ${product.backDisplayUrl || 'MISSING'}`);
  console.log(`[Draft]   extras: ${(product.extras || []).length} items`);
  console.log(`[Draft]   Total images after filter: ${images.length}`);
  images.forEach((url, i) => {
    console.log(`[Draft]   [${i}] ${url.substring(0, 100)}...`);
    console.log(`[Draft]       Contains pipe: ${url.includes('|')}, Contains %7C: ${url.includes('%7C')}`);
  });
  
  // Step 9: Build final draft with pricing
  const categoryPath = finalCategory?.title || product.categoryPath || '';
  let ebayPrice: number;
  let shippingPrice: number | undefined;
  let pricingEvidence: Draft['pricingEvidence'];

  if (DELIVERED_PRICING_ENABLED) {
    // NEW: Delivered-price-first competitive pricing v2
    console.log(`[Draft] 💰 Using DELIVERED_PRICING_V2 for ${product.productId}`);
    const pricingStart = Date.now();
    
    try {
      const pricingDecision = await getDeliveredPricing(product.brand, product.product, {
        mode: 'market-match',
      });
      
      ebayPrice = pricingDecision.finalItemCents / 100;
      shippingPrice = pricingDecision.finalShipCents / 100;
      pricingEvidence = {
        mode: pricingDecision.mode,
        targetDeliveredCents: pricingDecision.targetDeliveredCents,
        finalItemCents: pricingDecision.finalItemCents,
        finalShipCents: pricingDecision.finalShipCents,
        ebayCompsCount: pricingDecision.ebayComps.length,
        fallbackUsed: pricingDecision.fallbackUsed,
        warnings: pricingDecision.warnings,
      };
      
      console.log(`[Draft] 💰 Pricing took ${Date.now() - pricingStart}ms: $${ebayPrice} + $${shippingPrice} ship = $${ebayPrice + shippingPrice} delivered`);
      if (pricingDecision.warnings.length > 0) {
        console.log(`[Draft] ⚠️ Pricing warnings: ${pricingDecision.warnings.join(', ')}`);
      }
    } catch (err) {
      // Fallback to legacy pricing on error
      console.error(`[Draft] ❌ Delivered pricing failed, falling back to legacy:`, err);
      const retailPrice = typeof parsed.price === 'number' && parsed.price > 0 ? parsed.price : 0;
      ebayPrice = computeEbayPrice(retailPrice, categoryPath);
      shippingPrice = undefined;
      pricingEvidence = undefined;
    }
  } else {
    // LEGACY: ChatGPT retail price with discount formula
    const retailPrice = typeof parsed.price === 'number' && parsed.price > 0 ? parsed.price : 0;
    ebayPrice = computeEbayPrice(retailPrice, categoryPath);
    shippingPrice = undefined;
    pricingEvidence = undefined;
    console.log(`[Draft] 💰 Legacy pricing: retail $${retailPrice} → eBay $${ebayPrice}`);
  }
  
  const draft: Draft = {
    productId: product.productId,
    brand: product.brand,
    product: product.product,
    title: parsed.title,
    description: parsed.description,
    bullets: parsed.bullets,
    aspects,
    category: finalCategory || { id: '', title: product.categoryPath || 'Uncategorized' },
    images,
    price: ebayPrice,
    shippingPrice,
    condition: parsed.condition,
    pricingEvidence,
  };
  
  const deliveredStr = shippingPrice !== undefined ? ` + $${shippingPrice} ship` : '';
  console.log(`[Draft] ✓ Created for ${product.productId} in ${Date.now() - startTime}ms: "${draft.title}" (price: $${ebayPrice}${deliveredStr}, category: ${categoryPath})`);
  
  return draft;
}

/**
 * Main handler
 */
export const handler: Handler = async (event) => {
  const headers = event.headers as Record<string, string | undefined>;
  const originHdr = getOrigin(headers);
  const methods = METHODS;

  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(204, null, originHdr, methods);
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" }, originHdr, methods);
  }

  try {
    // Authenticate user (skip in test mode)
    const testModeHeader = headers['x-test-mode'] || headers['X-Test-Mode'];
    const isTestMode = testModeHeader === 'true' || process.env.NODE_ENV === 'test';
    
    if (!isTestMode) {
      await requireUserAuth(headers.authorization || headers.Authorization);
      console.log(`[smartdrafts-create-drafts] Authenticated user`);
    } else {
      console.log(`[smartdrafts-create-drafts] Running in test mode - auth bypassed`);
    }

    // Parse request body
    const body = JSON.parse(event.body || "{}");
    const rawProducts = Array.isArray(body.products) ? body.products : [];

    if (rawProducts.length === 0) {
      return jsonResponse(400, { 
        ok: false, 
        error: "No products provided. Expected { products: [...] }" 
      }, originHdr, methods);
    }

    // Cap products to avoid timeout - client will send remainder
    if (rawProducts.length > MAX_SEEDS) {
      console.warn(`[smartdrafts-create-drafts] Received ${rawProducts.length}, processing only ${MAX_SEEDS}`);
    }
    const products = rawProducts.slice(0, MAX_SEEDS);

    const requestStart = Date.now();
    console.log(`[smartdrafts-create-drafts] Creating drafts for ${products.length} product(s) (${rawProducts.length} requested)`);

    // Create drafts for all products
    const drafts: Draft[] = [];
    const errors: Array<{ productId: string; error: string }> = [];

    for (let i = 0; i < products.length; i++) {
      const product = products[i];
      try {
        console.log(`[smartdrafts-create-drafts] Processing ${i + 1}/${products.length}: ${product.productId}`);
        const draft = await createDraftForProduct(product);
        drafts.push(draft);
        console.log(`[smartdrafts-create-drafts] ✓ Completed ${i + 1}/${products.length} (${Date.now() - requestStart}ms elapsed)`);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[smartdrafts-create-drafts] ✗ Failed ${i + 1}/${products.length} (${product.productId}):`, errorMsg);
        errors.push({ 
          productId: product.productId, 
          error: errorMsg 
        });
      }
    }

    const totalTime = Date.now() - requestStart;
    console.log(`[smartdrafts-create-drafts] Created ${drafts.length}/${products.length} drafts in ${totalTime}ms`);

    return jsonResponse(200, {
      ok: true,
      drafts,
      errors: errors.length > 0 ? errors : undefined,
      summary: {
        total: products.length,
        succeeded: drafts.length,
        failed: errors.length,
      },
    }, originHdr, methods, { "x-drafts-processed": String(drafts.length) });

  } catch (error: any) {
    console.error("[smartdrafts-create-drafts] error:", error);
    return jsonResponse(500, {
      ok: false,
      error: error?.message || "Internal server error",
    }, originHdr, methods);
  }
};
