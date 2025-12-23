import type { Handler } from "@netlify/functions";
import { putJob } from "../../src/lib/job-store.js";
import { k } from "../../src/lib/user-keys.js";
import { recordDraftsCreated } from "../../src/lib/user-stats.js";

// Import the draft creation logic from the existing function
import OpenAI from "openai";
import { pickCategoryForGroup } from "../../src/lib/taxonomy-select.js";
import { listCategories } from "../../src/lib/taxonomy-store.js";
import { lookupPrice, type PriceLookupInput, type PriceDecision } from "../../src/lib/price-lookup.js";
import { getBrandMetadata } from "../../src/lib/brand-map.js";
import { getDefaultPricingSettings, type PricingSettings } from "../../src/lib/pricing-config.js";
import { tokensStore } from "../../src/lib/_blobs.js";

const GPT_TIMEOUT_MS = 30_000;
const GPT_RETRY_ATTEMPTS = 2;
const GPT_RETRY_DELAY_MS = 1000;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });

// Cache categories in memory for the lifetime of this function instance
let categoriesCache: any[] | null = null;
let categoriesLoadingPromise: Promise<any[]> | null = null;

type BackgroundPayload = {
  jobId?: string;
  userId?: string;
  products?: any[];
  promotion?: {
    enabled: boolean;
    rate: number | null;
  };
};

type PairedProduct = {
  productId: string;
  brand: string;
  product: string;
  title?: string; // For books: the actual book title (brand will be null, product is author)
  brandWebsite?: string; // Official brand website URL from Vision API
  variant?: string;
  size?: string;
  categoryPath?: string;
  keyText?: string[]; // Key text snippets from product packaging (from Vision API)
  photoQuantity?: number; // CHUNK 4: How many physical products visible in photo (from vision analysis)
  packCount?: number | null; // Number of units in package (e.g., 24 for 24-pack) - CRITICAL for variant pricing
  heroDisplayUrl?: string;
  backDisplayUrl?: string;
  side1DisplayUrl?: string;  // Optional 3rd image (side panel)
  side2DisplayUrl?: string;  // Optional 4th image (additional angle)
  extras?: string[];
  evidence?: string[];
};

type CategoryHint = {
  id: string;
  title: string;
  aspects: Record<string, any>;
};

type Draft = {
  productId: string;
  groupId: string; // For eBay publishing via create-ebay-draft-user
  brand: string;
  product: string;
  title: string;
  description: string;
  bullets: string[];
  aspects: Record<string, string[]>;
  category: CategoryHint;
  images: string[];
  price: number | null;
  condition: string;
  keyText?: string[]; // Key text from Vision API - helps determine formulation
  pricingStatus?: 'OK' | 'NEEDS_REVIEW';
  priceMeta?: {
    chosenSource?: string;
    basePrice?: number;
    candidates?: any[];
  };
  promotion?: {
    enabled: boolean;
    rate: number | null;
  };
};

function parsePayload(raw: string | null | undefined): BackgroundPayload {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error("[smartdrafts-create-drafts-background] invalid JSON", { preview: raw?.slice(0, 200) });
    return {};
  }
}

async function writeJob(jobId: string, userId: string | undefined, data: Record<string, unknown>) {
  const jobKey = userId ? k.job(userId, jobId) : undefined;
  await putJob(jobId, { jobId, userId, ...data }, { key: jobKey });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function timeoutPromise<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("Timeout")), ms))
  ]);
}

// Phase 3: Removed legacy computeEbayPrice function
// Pricing is now handled by computeEbayItemPrice in price-lookup.ts

async function callOpenAI(prompt: string): Promise<string> {
  if (!process.env.OPENAI_API_KEY) {
    console.error("[GPT] OPENAI_API_KEY not configured");
    throw new Error("OpenAI API key not configured");
  }

  let lastError: any;
  for (let attempt = 1; attempt <= GPT_RETRY_ATTEMPTS; attempt++) {
    try {
      console.log(`[GPT] Attempt ${attempt}/${GPT_RETRY_ATTEMPTS} - calling OpenAI...`);
      const completion = await timeoutPromise(
        openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
            {
              role: "system",
              content: "You are an eBay listing expert. Create SEO-optimized, conversion-focused listings with detailed descriptions and complete item specifics. Respond only with valid JSON matching the requested format.",
            },
            { role: "user", content: prompt },
          ],
          max_tokens: 2500, // Increased to allow for detailed 200-500 word descriptions + all aspects
        }),
        GPT_TIMEOUT_MS
      );
      console.log(`[GPT] Attempt ${attempt} succeeded`);
      return completion.choices?.[0]?.message?.content || "{}";
    } catch (err) {
      lastError = err;
      console.error(`[GPT] Attempt ${attempt} failed:`, err instanceof Error ? err.message : String(err));
      if (attempt >= GPT_RETRY_ATTEMPTS) break;
      const delay = GPT_RETRY_DELAY_MS * attempt;
      console.warn(`[GPT] Retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }
  
  const message = lastError instanceof Error ? lastError.message : String(lastError || "OpenAI error");
  throw new Error(message);
}

async function getRelevantCategories(product: PairedProduct, marketplaceProductType?: string): Promise<string> {
  try {
    // Use cached categories to avoid repeated Redis calls (15+ seconds each!)
    // Ensure only ONE concurrent load happens even when multiple products start simultaneously
    if (!categoriesCache) {
      if (!categoriesLoadingPromise) {
        const start = Date.now();
        console.log('[Cache] Starting category load...');
        categoriesLoadingPromise = listCategories();
        
        try {
          categoriesCache = await categoriesLoadingPromise;
          console.log(`[Cache] Loaded ${categoriesCache.length} categories in ${Date.now() - start}ms`);
        } finally {
          categoriesLoadingPromise = null; // Clear promise after load completes
        }
      } else {
        // Another product is already loading - wait for it
        console.log('[Cache] Waiting for concurrent category load...');
        categoriesCache = await categoriesLoadingPromise;
        console.log('[Cache] Category load completed (from concurrent request)');
      }
    }
    const allCategories = categoriesCache;
    
    // For books (where brand is null), search by title instead of author/product name
    // This prevents "Bobbi Brown" (author) from matching food categories like "Brown Sauce"
    const isBook = !product.brand || product.brand === 'null';
    
    // Build semantic search terms based on product TYPE, not brand/product names
    // This prevents "Root" from matching "Lobe Pumps & Root Blowers" or "Fish Oil" matching "Fish Sauce"
    const productName = (product.product || '').toLowerCase();
    const brandName = (product.brand || '').toLowerCase();
    
    // Detect product type - PREFER marketplace type from Amazon/Walmart (most reliable)
    // Then check brand metadata database, then fallback to keyword detection
    let productType = '';
    if (marketplaceProductType) {
      // Use marketplace-detected type (from Amazon/Walmart JSON-LD)
      productType = marketplaceProductType.toLowerCase();
      console.log(`[Category] Using marketplace product type: "${productType}"`);
    } else if (isBook) {
      productType = 'book';
    } else {
      // Check brand metadata database first
      if (brandName) {
        const brandMeta = await getBrandMetadata(brandName);
        if (brandMeta) {
          // Check if product name matches any specific patterns
          if (brandMeta.productPatterns) {
            for (const pattern of brandMeta.productPatterns) {
              const matches = pattern.keywords.some(keyword => 
                productName.includes(keyword.toLowerCase())
              );
              if (matches) {
                productType = pattern.productType;
                console.log(`[Category] Brand "${brandName}" product matched pattern "${pattern.keywords.join(', ')}" → "${productType}"`);
                break;
              }
            }
          }
          
          // Fall back to default product type if no pattern matched
          if (!productType && brandMeta.defaultProductType) {
            productType = brandMeta.defaultProductType;
            console.log(`[Category] Using default product type for brand "${brandName}": "${productType}"`);
          }
        }
      }
      
      // Fallback to keyword detection if no database entry
      if (!productType) {
        if (productName.includes('vitamin') || productName.includes('supplement') || productName.includes('capsule') || productName.includes('pill')) {
          productType = 'vitamin supplement';
        } else if (productName.includes('oil') && (productName.includes('fish') || productName.includes('omega'))) {
          productType = 'fish oil supplement';
        } else if (productName.includes('collagen') || productName.includes('protein') || productName.includes('creatine') || productName.includes('pre workout') || productName.includes('pre ') || productName.includes(' pre')) {
          productType = 'sports nutrition supplement';
        } else if (productName.includes('serum') || productName.includes('cleanser') || productName.includes('cream') || productName.includes('lotion') || productName.includes('moisturizer')) {
          productType = 'skincare beauty';
        } else if (productName.includes('bath') || productName.includes('soak') || productName.includes('salt')) {
          productType = 'bath body';
        } else if (productName.includes('detox') || productName.includes('cleanse') || productName.includes('clean slate')) {
          productType = 'detox supplement';
        } else if (productName.includes('inositol') || productName.includes('hormonal')) {
          productType = 'vitamin supplement';
        }
      }
    }
    
    // Use product type + category path instead of brand/product names
    const searchTerms = [
      productType,
      product.categoryPath
    ].filter(Boolean).join(' ').toLowerCase();
    
    const relevant = allCategories
      .filter(cat => {
        const catText = `${cat.title} ${cat.slug}`.toLowerCase();
        // Split search terms and require at least one significant match
        const terms = searchTerms.split(/\s+/).filter(t => t.length > 2);
        return terms.some(term => catText.includes(term));
      })
      .slice(0, 20)
      .map(cat => {
        // Include key item specifics for each category
        const aspects = cat.itemSpecifics
          ?.filter((spec: any) => !spec.required && spec.name !== 'Brand') // Skip required fields that are auto-filled
          .slice(0, 8) // Limit to top 8 aspects to keep prompt reasonable
          .map((spec: any) => spec.name)
          .join(', ') || '';
        
        return aspects 
          ? `${cat.id}: ${cat.title} (aspects: ${aspects})`
          : `${cat.id}: ${cat.title}`;
      })
      .join('\n');
    
    if (relevant) {
      console.log(`[Category] Found ${relevant.split('\n').length} categories matching type: "${productType}"`);
      return relevant;
    }
    
    // Fallback to common categories if no match found
    console.log(`[Category] No type match for "${productType}", using fallback categories`);
    const commonCats = [
      '261186', // Books
      '180959', // Vitamins & Lifestyle Supplements
      '181034', // Dietary Supplements & Nutrition
      '11450', // Clothing, Shoes & Accessories  
      '293', // Consumer Electronics
      '88433', // Everything Else
    ];
    
    const fallback = allCategories
      .filter(cat => commonCats.includes(cat.id))
      .map(cat => {
        const aspects = cat.itemSpecifics
          ?.filter((spec: any) => !spec.required && spec.name !== 'Brand')
          .slice(0, 8)
          .map((spec: any) => spec.name)
          .join(', ') || '';
        
        return aspects 
          ? `${cat.id}: ${cat.title} (aspects: ${aspects})`
          : `${cat.id}: ${cat.title}`;
      })
      .join('\n');
    
    return fallback;
  } catch (err) {
    console.error('[getRelevantCategories] Error:', err);
    return '';
  }
}

function buildPrompt(
  product: PairedProduct, 
  categoryHint: CategoryHint | null, 
  categories: string,
  competitorPrices?: { amazon: number | null; walmart: number | null; brand: number | null; avg: number }
): string {
  const lines: string[] = [];
  
  // VALIDATION: If product has title but also has supplement/health product indicators, it's NOT a book
  // This is a safety check in case vision classification was wrong
  if (product.title) {
    const categoryLower = (product.categoryPath || '').toLowerCase();
    const productLower = (product.product || '').toLowerCase();
    const keyTextLower = (product.keyText || []).join(' ').toLowerCase();
    
    const isActuallySupplementNotBook = 
      categoryLower.includes('health') ||
      categoryLower.includes('vitamin') ||
      categoryLower.includes('supplement') ||
      categoryLower.includes('dietary') ||
      keyTextLower.includes('capsule') ||
      keyTextLower.includes('tablet') ||
      keyTextLower.includes('supplement facts') ||
      productLower.includes('capsule') ||
      productLower.includes('tablet');
    
    if (isActuallySupplementNotBook) {
      console.warn(`[buildPrompt] ⚠️ Product has title="${product.title}" but appears to be supplement, not book`);
      console.warn(`[buildPrompt] Category: ${product.categoryPath}, Product: ${product.product}`);
      console.warn(`[buildPrompt] Treating as supplement, ignoring book title field`);
      // Don't use the title - treat as regular product
      lines.push(`Product: ${product.product}`);
      if (product.brand && product.brand !== "Unknown") {
        lines.push(`Brand: ${product.brand}`);
      }
      
      // Include key text from product packaging (Vision API extraction)
      if (product.keyText && product.keyText.length > 0) {
        lines.push(`Product Label Text (visible on packaging): ${product.keyText.join(', ')}`);
        lines.push('👉 Use this label text to determine the correct formulation, size, and quantity.');
      }
    } else {
      // Actually a book
      lines.push(`Book Title: ${product.title}`);
      lines.push(`Author: ${product.product}`);
    }
  } else {
    lines.push(`Product: ${product.product}`);
    if (product.brand && product.brand !== "Unknown") {
      lines.push(`Brand: ${product.brand}`);
    }
    
    // Include key text from product packaging (Vision API extraction)
    if (product.keyText && product.keyText.length > 0) {
      lines.push(`Product Label Text (visible on packaging): ${product.keyText.join(', ')}`);
      lines.push('👉 Use this label text to determine the correct formulation, size, and quantity.');
    }
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
  
  if (categoryHint) {
    lines.push(`eBay category: ${categoryHint.title} (ID: ${categoryHint.id})`);
    
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
  
  if (categories && categories.length > 0) {
    lines.push("Choose the most appropriate eBay category ID from this list:");
    lines.push(categories);
    lines.push("");
  }
  
  lines.push("Create a professional eBay listing with accurate, SEO-optimized details.");
  
  // Add competitor pricing data if available
  if (competitorPrices && (competitorPrices.amazon || competitorPrices.walmart || competitorPrices.brand)) {
    lines.push("");
    lines.push("COMPETITOR PRICING DATA (USE THESE EXACT VALUES):");
    if (competitorPrices.amazon) {
      lines.push(`- Amazon current price: $${competitorPrices.amazon.toFixed(2)}`);
    }
    if (competitorPrices.walmart) {
      lines.push(`- Walmart current price: $${competitorPrices.walmart.toFixed(2)}`);
    }
    if (competitorPrices.brand) {
      lines.push(`- Brand direct price: $${competitorPrices.brand.toFixed(2)}`);
    }
    if (competitorPrices.avg > 0) {
      lines.push(`- Market average: $${competitorPrices.avg.toFixed(2)}`);
    }
    lines.push("");
    lines.push("PRICING RULES:");
    lines.push("- You MUST use the lowest competitor price from above as your 'price' field");
    lines.push("- DO NOT search for prices - the data above is authoritative and current");
    lines.push("- DO NOT invent or hallucinate prices");
    lines.push("- Return ONLY the number in the 'price' field (e.g., 16.00)");
  } else {
    lines.push("IMPORTANT PRICING RULES:");
    lines.push("- Search Amazon.com for the product's 'Typical Price' or 'List Price' (NOT sale/deal prices, NOT marketplace seller prices)");
    lines.push("- IGNORE third-party marketplace sellers with inflated prices - use ONLY Amazon's direct price or manufacturer MSRP");
    lines.push("- For books: use new hardcover/paperback price from publisher, NOT collectible/used/rare edition pricing");
    lines.push("⚠️ CRITICAL: Match the EXACT quantity shown in photos - if photos show 1 bottle, use SINGLE bottle price, NOT 2-pack/3-pack/bundle pricing!");
    lines.push("- Match the EXACT size/variant shown in photos (30-day supply vs 90-day, 8oz vs 16oz, etc.)");
    lines.push("- Common mistake: Using '2 Pack' or 'Twin Pack' prices when photos show only 1 unit");
    lines.push("- Typical range: supplements $15-45, books $10-35, cosmetics $10-50");
    lines.push("- If you see prices over $50 for common items, you're likely looking at wrong variant or marketplace pricing");
  }
  
  lines.push("Assess condition based on whether it appears to be new/sealed or used.");
  lines.push("");
  lines.push("FORMULATION DETECTION (CRITICAL):");
  lines.push("⚠️ ALWAYS use 'Product Label Text' provided above - do NOT guess or make assumptions!");
  lines.push("Look at the extracted text from product photos to determine formulation:");
  lines.push("- If label text mentions 'mix', 'mixing instructions', 'add to water', 'shake', 'stir', 'scoop', 'flavor' (Berry, Vanilla, etc.) → formulation is 'Powder'");
  lines.push("- If label text mentions 'capsule', 'capsules', 'caps', 'vcaps', '60 count', '90 count' → formulation is 'Capsule'");
  lines.push("- If label text mentions 'tablet', 'tablets', 'tabs' → formulation is 'Tablet'");
  lines.push("- If label text mentions 'liquid', 'drops', 'dropper', 'sublingual', 'fl oz', 'ml' → formulation is 'Liquid'");
  lines.push("- If label text mentions 'gummy', 'gummies', 'chewable' → formulation is 'Gummy'");
  lines.push("Common mistake: Products with flavors (Natural Berry, Vanilla) are usually POWDER drinks, NOT capsules!");
  lines.push("Common mistake: If label says 'Liquid Drops', do NOT output 'Capsule' - use the actual label text!");
  lines.push("");
  lines.push("TITLE REQUIREMENTS (SEO-CRITICAL):");
  lines.push("- Must be 60-80 characters (use ALL available space for SEO)");
  lines.push("- Include: Brand + Product Name + Key Features + Size/Type + FORMULATION");
  lines.push("- Use keywords buyers search for (e.g., 'Supplement', 'Powder', 'Capsules', 'Support', 'Health')");
  lines.push("- Example: 'Natural Stacks Dopamine Brain Food 60 Capsules Focus Memory Supplement NEW'");
  lines.push("- Example: 'MyBrainCo Gut Repair Powder Supplement 310g Natural Berry Flavor NEW'");
  lines.push("- For books: 'Title by Author - Edition/Format (Hardcover/Paperback) ISBN - Condition'");
  lines.push("- NO generic titles like 'Natural Stacks Dopamine Brain Food' - add DESCRIPTIVE KEYWORDS!");
  lines.push("");
  lines.push("DESCRIPTION REQUIREMENTS (CONVERSION-CRITICAL):");
  lines.push("- Must be 200-500 words (detailed paragraph format, NOT one sentence!)");
  lines.push("- Structure: Opening hook → Key benefits → Features → Specifications → Call to action");
  lines.push("- Include WHY someone would want this product (benefits, use cases)");
  lines.push("- List ALL ingredients, features, certifications visible on packaging");
  lines.push("- Use engaging, professional language that sells the product");
  lines.push("- Example structure:");
  lines.push("  'Discover [Product Name], the premium [category] designed to [main benefit]...'");
  lines.push("  '[Key features paragraph with specific benefits]...'");
  lines.push("  'Perfect for [target audience/use cases]...'");
  lines.push("  'Specifications: [size, count, ingredients, certifications]...'");
  lines.push("- DO NOT write one-sentence descriptions! Expand with details, benefits, and selling points.");
  lines.push("");
  lines.push("CRITICAL REQUIREMENT: You MUST fill out ALL relevant item specifics (aspects) shown in parentheses for your chosen category above.");
  lines.push("Example: If category shows (aspects: Formulation, Main Purpose, Ingredients, Features, Active Ingredients)");
  lines.push("then your aspects object MUST include those fields with appropriate values.");
  lines.push("The more complete and accurate the aspects, the better the eBay search ranking.");
  lines.push("DO NOT just fill Brand and Type - include ALL relevant aspects listed for the category!");
  lines.push("");
  lines.push("Response format (JSON):");
  lines.push("{");
  if (categories && categories.length > 0) {
    lines.push('  "categoryId": "12345", // Choose the most appropriate eBay category ID from the list above');
  }
  lines.push('  "title": "...", // 60-80 chars, SEO-optimized with keywords (Brand + Product + Features + Size)');
  lines.push('  "description": "...", // 200-500 word detailed description (NOT one sentence!)');
  lines.push('  "bullets": ["...", "...", "..."], // 3-5 benefit-focused bullet points');
  lines.push('  "aspects": {');
  lines.push('    // REQUIRED: Include ALL aspects shown for your chosen category above');
  lines.push('    "Brand": ["..."],');
  lines.push('    "Type": ["..."],');
  lines.push('    "Formulation": ["Capsule"], // Example - fill based on product');
  lines.push('    "Main Purpose": ["Brain Health"], // Example - fill based on product');
  lines.push('    "Ingredients": ["L-Tyrosine", "..."], // Example - list key ingredients');
  lines.push('    "Features": ["Non-GMO", "Gluten-Free"], // Example - list all features');
  lines.push('    "Active Ingredients": ["..."], // Include if shown in category aspects');
  lines.push('    // ... include EVERY aspect listed for the chosen category');
  lines.push('  },');
  lines.push('  "price": 29.99, // Current retail price from Amazon/Walmart');
  lines.push('  "condition": "NEW" // or "USED"');
  lines.push("}");
  
  return lines.join("\n");
}

async function pickCategory(product: PairedProduct): Promise<CategoryHint | null> {
  try {
    console.log(`[Category] Picking for: ${product.brand} ${product.product}`);
    
    // Skip the expensive pickCategoryForGroup lookup - we already have GPT choosing the category
    // pickCategoryForGroup calls listCategories() again (12+ seconds!) which we already cached above
    // Instead, just return null and let GPT pick from the relevant categories list
    console.log(`[Category] Skipping fallback category lookup - will use GPT selection only`);
    return null;
  } catch (err) {
    console.error(`[Category] Error picking category:`, err);
    return null;
  }
}

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
      description: typeof parsed.description === 'string' ? parsed.description.slice(0, 4000) : `${product.brand} ${product.product}`, // Allow up to 4000 chars for eBay
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

function normalizeAspects(aspects: any, product: PairedProduct): Record<string, string[]> {
  const normalized: Record<string, string[]> = {};
  
  // Placeholder values to filter out (GPT sometimes returns these)
  const placeholders = [
    'select', 'choose', '...', 'value', 'not applicable', 'n/a', 
    'does not apply', 'unknown', 'other', 'see description'
  ];
  
  const isPlaceholder = (val: string): boolean => {
    const lower = val.toLowerCase().trim();
    if (lower.length === 0) return true;
    if (lower.length > 50) return false; // Long values are likely real
    return placeholders.some(p => lower.includes(p) && lower.length < 30);
  };
  
  if (typeof aspects === 'object' && aspects !== null) {
    for (const [key, value] of Object.entries(aspects)) {
      if (Array.isArray(value)) {
        const stringValues = value
          .map(v => String(v).trim())
          .filter(v => v && !isPlaceholder(v)); // Filter out empty and placeholders
        if (stringValues.length > 0) {
          normalized[key] = stringValues.slice(0, 10);
        }
      } else if (value !== null && value !== undefined) {
        const stringValue = String(value).trim();
        if (stringValue && !isPlaceholder(stringValue)) {
          normalized[key] = [stringValue];
        }
      }
    }
  }
  
  // CRITICAL: Always ensure Brand is present from product data if missing or invalid
  if (product.brand && product.brand !== "Unknown" && (!normalized.Brand || normalized.Brand.length === 0)) {
    normalized.Brand = [product.brand];
    console.log(`[normalizeAspects] ✓ Brand set from product.brand: "${product.brand}"`);
  }
  
  if (product.size && !normalized.Size) {
    normalized.Size = [product.size];
  }
  
  return normalized;
}

async function createDraftForProduct(
  product: PairedProduct, 
  promotion: { enabled: boolean; rate: number | null }, 
  pricingSettings: PricingSettings,
  retryAttempt: number = 0
): Promise<Draft> {
  const startTime = Date.now();
  const retryLabel = retryAttempt > 0 ? ` (retry ${retryAttempt})` : '';
  console.log(`[Draft] Creating for: ${product.productId}${retryLabel}`);
  console.log(`[Draft] Product data:`, JSON.stringify({ 
    brand: product.brand, 
    product: product.product, 
    title: product.title,
    brandWebsite: product.brandWebsite
  }));
  console.log(`[Draft-debug] keyText:`, product.keyText);
  console.log(`[Draft-debug] categoryPath:`, product.categoryPath);
  console.log(`[Draft-debug] Full product keys:`, Object.keys(product));
  
  // ========================================
  // TIERED PRICING ENGINE (Phase 4)
  // ========================================
  // 1. eBay sold prices (primary)
  // 2. Brand MSRP (secondary)
  // 3. AI arbitration (decision)
  // ========================================
  
  let pricingDecision: PriceDecision | null = null;
  let finalPrice: number | null = null;
  let pricingStatus: 'OK' | 'NEEDS_REVIEW' = 'NEEDS_REVIEW';
  let priceMeta: any = undefined;

  try {
    const priceStart = Date.now();
    
    // Build price lookup title - fallback to keyText if product name is missing
    // This handles cases where Vision API didn't extract productName but did get keyText
    let priceLookupTitle = [product.product, product.variant].filter(Boolean).join(' ').trim();
    if (!priceLookupTitle && product.keyText && product.keyText.length > 0) {
      // Use first 4 keyText terms as fallback (e.g., "Hydrolyzed Collagen Protein Powder")
      priceLookupTitle = product.keyText.slice(0, 4).join(' ').trim();
      console.log(`[smartdrafts-price] Using keyText fallback for title: "${priceLookupTitle}"`);
    }
    
    console.log(`[smartdrafts-price] Looking up price for: ${product.brand || '(no brand)'} ${priceLookupTitle || '(no product name)'}`);
    
    const priceInput: PriceLookupInput = {
      title: priceLookupTitle,
      brand: product.brand || undefined,
      brandWebsite: product.brandWebsite || undefined, // Pass Vision API brand website
      upc: undefined, // TODO: Add UPC to PairedProduct type if available from pairing
      condition: 'NEW', // TODO: Detect condition from product data if available
      quantity: undefined, // TODO: Add quantity to PairedProduct type if available
      keyText: product.keyText, // Pass extracted text from packaging (e.g., "DIETARY SUPPLEMENT")
      categoryPath: product.categoryPath, // Pass Vision API category
      photoQuantity: product.photoQuantity || 1, // CHUNK 4: Pass photo quantity from vision analysis
      packCount: product.packCount, // CRITICAL: Pass pack count for variant matching (e.g., 24-pack → $48)
      amazonPackSize: undefined, // TODO: Extract from Amazon product detection in extractPriceFromHtml
      pricingSettings, // Phase 3: Pass user pricing settings
    };

    pricingDecision = await lookupPrice(priceInput);
    console.log(`[smartdrafts-price] Price lookup took ${Date.now() - priceStart}ms`);

    if (!pricingDecision.ok || !pricingDecision.recommendedListingPrice) {
      console.warn(`[smartdrafts-price] ⚠️ No price found for "${priceInput.title}"`);
      pricingStatus = 'NEEDS_REVIEW';
      finalPrice = null;
    } else {
      finalPrice = pricingDecision.recommendedListingPrice;
      pricingStatus = 'OK';
      priceMeta = {
        chosenSource: pricingDecision.chosen?.source,
        basePrice: pricingDecision.chosen?.price,
        candidates: pricingDecision.candidates.map(c => ({
          source: c.source,
          price: c.price,
          notes: c.notes,
        })),
      };
      
      console.log(
        `[smartdrafts-price] ✓ title="${priceInput.title}" ` +
        `final=$${finalPrice.toFixed(2)} ` +
        `source=${pricingDecision.chosen?.source} ` +
        `base=$${pricingDecision.chosen?.price.toFixed(2)}`
      );
    }
  } catch (err) {
    console.error(`[smartdrafts-price] Price lookup failed:`, err);
    pricingStatus = 'NEEDS_REVIEW';
    finalPrice = null;
  }
  
  const catListStart = Date.now();
  const relevantCategories = await getRelevantCategories(product, undefined);
  console.log(`[Draft] Category list generation took ${Date.now() - catListStart}ms`);
  console.log(`[Draft] Category list preview:\n${relevantCategories.slice(0, 500)}...`);
  
  const catStart = Date.now();
  const categoryHint = await pickCategory(product);
  console.log(`[Draft] Category fallback pick took ${Date.now() - catStart}ms`);
  
  const prompt = buildPrompt(product, categoryHint, relevantCategories, undefined);
  console.log(`[Draft] Prompt length: ${prompt.length} chars`);
  console.log(`[Draft] Prompt preview:`, prompt.slice(0, 500));
  
  const gptStart = Date.now();
  const responseText = await callOpenAI(prompt);
  console.log(`[Draft] GPT call took ${Date.now() - gptStart}ms`);
  console.log(`[Draft] GPT response:`, responseText.slice(0, 500));
  
  const parsed = parseGptResponse(responseText, product);
  console.log(`[Draft] Parsed response:`, JSON.stringify(parsed, null, 2));
  
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
  }
  
  const aspects = normalizeAspects(parsed.aspects, product);
  // Collect all product images: front (hero), back, side1, side2, then extras
  const images = [
    product.heroDisplayUrl,
    product.backDisplayUrl,
    product.side1DisplayUrl,
    product.side2DisplayUrl,
    ...(product.extras || [])
  ].filter((x): x is string => Boolean(x));
  
  // Use AI-powered pricing decision (already computed above)
  const draft: Draft = {
    productId: product.productId,
    groupId: product.productId, // Add groupId for eBay publishing
    brand: product.brand,
    product: product.product,
    title: parsed.title,
    description: parsed.description,
    bullets: parsed.bullets,
    aspects,
    category: finalCategory || { id: '', title: product.categoryPath || 'Uncategorized', aspects: {} },
    images,
    price: finalPrice,
    condition: parsed.condition,
    keyText: product.keyText, // Pass through Vision API key text for formulation detection
    pricingStatus,
    priceMeta,
    promotion, // Include promotion settings in draft
  };
  
  console.log(`[Draft] ✓ Created for ${product.productId} in ${Date.now() - startTime}ms: "${draft.title}"`);
  console.log(`[Draft] Final draft data for ${product.productId}:`, JSON.stringify({
    productId: draft.productId,
    brand: draft.brand,
    product: draft.product,
    title: draft.title,
    aspectsCount: Object.keys(draft.aspects || {}).length,
    aspectsKeys: Object.keys(draft.aspects || {}),
    categoryId: draft.category?.id,
    categoryTitle: draft.category?.title,
    imagesCount: draft.images?.length || 0,
    price: draft.price,
    condition: draft.condition
  }, null, 2));
  
  // Validate draft completeness - check for minimum required data
  const aspectsCount = Object.keys(draft.aspects || {}).length;
  const hasCategory = draft.category && draft.category.id && draft.category.id !== '';
  const hasBrand = draft.aspects?.Brand && draft.aspects.Brand.length > 0;
  const hasType = draft.aspects?.Type && draft.aspects.Type.length > 0;
  
  // Consider draft incomplete if it's missing critical fields
  const isIncomplete = !hasCategory || !hasBrand || aspectsCount < 3;
  
  if (isIncomplete && retryAttempt < 2) {
    console.warn(`[Draft] ⚠️ Incomplete draft for ${product.productId}: category=${hasCategory}, brand=${hasBrand}, aspectsCount=${aspectsCount}`);
    console.warn(`[Draft] 🔄 Retrying draft creation (attempt ${retryAttempt + 1}/2)...`);
    await sleep(1000); // Brief delay before retry
    return createDraftForProduct(product, promotion, pricingSettings, retryAttempt + 1);
  }
  
  if (isIncomplete && retryAttempt >= 2) {
    console.error(`[Draft] ❌ Failed to create complete draft after ${retryAttempt + 1} attempts for ${product.productId}`);
  }
  
  return draft;
}

export const handler: Handler = async (event) => {
  const handlerStartTime = Date.now();
  const body = parsePayload(event.body);
  const jobId = typeof body.jobId === "string" ? body.jobId : undefined;
  const userId = typeof body.userId === "string" ? body.userId : undefined;
  const products = Array.isArray(body.products) ? body.products : [];
  const promotion = body.promotion || { enabled: false, rate: null };

  console.log(`[PERF] Handler started for jobId: ${jobId}, products: ${products.length}`);
  
  // Hard limit to prevent timeouts
  const MAX_PRODUCTS_PER_JOB = 50;
  if (products.length > MAX_PRODUCTS_PER_JOB) {
    console.error(`[smartdrafts] Job rejected: ${products.length} products exceeds limit of ${MAX_PRODUCTS_PER_JOB}`);
    if (jobId && userId) {
      await writeJob(jobId, userId, {
        state: "error",
        error: `Too many products (${products.length}). Maximum is ${MAX_PRODUCTS_PER_JOB} per batch. Please process in smaller chunks.`,
        finishedAt: Date.now(),
      }).catch(() => {});
    }
    return { 
      statusCode: 400,
      body: JSON.stringify({
        error: `Too many products. Maximum is ${MAX_PRODUCTS_PER_JOB} per batch. Please select fewer products or process in smaller chunks.`
      })
    };
  }

  if (!jobId || !userId) {
    if (jobId) {
      await writeJob(jobId, userId, {
        state: "error",
        error: "Missing job metadata",
        finishedAt: Date.now(),
      }).catch(() => {});
    }
    return { statusCode: 200 };
  }

  if (products.length === 0) {
    await writeJob(jobId, userId, {
      state: "error",
      error: "No products provided",
      finishedAt: Date.now(),
    });
    return { statusCode: 200 };
  }

  // Phase 3: Load user pricing settings
  let pricingSettings: PricingSettings = getDefaultPricingSettings();
  if (userId) {
    try {
      const store = tokensStore();
      // CRITICAL: Use encodeURIComponent to match userScopedKey() used in user-settings-save
      const settingsKey = `users/${encodeURIComponent(userId)}/settings.json`;
      const settingsBlob = await store.get(settingsKey);
      if (settingsBlob) {
        const settingsData = JSON.parse(settingsBlob);
        if (settingsData.pricing) {
          pricingSettings = {
            ...getDefaultPricingSettings(),
            ...settingsData.pricing,
          };
          console.log(`[pricing] ✓ Loaded user settings: discount=${pricingSettings.discountPercent}%, strategy=${pricingSettings.shippingStrategy}, shippingCents=${pricingSettings.templateShippingEstimateCents}`);
        }
      } else {
        console.log(`[pricing] No user settings found at ${settingsKey}, using defaults`);
      }
    } catch (err) {
      console.warn(`[pricing] Failed to load user settings, using defaults:`, err);
    }

    // Phase 3.5: Check default fulfillment policy for free shipping
    try {
      const store = tokensStore();
      const { hasFreeShipping, extractShippingCost } = await import("../../src/lib/policy-helpers.js");
      const { getUserAccessToken, apiHost, headers: ebayHeaders } = await import("../../src/lib/_ebay.js");
      const { userScopedKey } = await import("../../src/lib/_auth.js");

      // Load policy defaults
      const policyDefaultsKey = userScopedKey(userId, 'policy-defaults.json');
      const policyDefaults = await store.get(policyDefaultsKey, { type: 'json' }) as any;

      if (policyDefaults?.fulfillment) {
        const fulfillmentPolicyId = policyDefaults.fulfillment;
        console.log(`[pricing] Checking fulfillment policy ${fulfillmentPolicyId} for free shipping...`);

        // Fetch the policy from eBay
        const token = await getUserAccessToken(userId);
        const host = apiHost();
        const h = ebayHeaders(token);
        const policyUrl = `${host}/sell/account/v1/fulfillment_policy/${encodeURIComponent(fulfillmentPolicyId)}`;
        const policyRes = await fetch(policyUrl, { headers: h });

        if (policyRes.ok) {
          const policy = await policyRes.json();

          if (hasFreeShipping(policy)) {
            pricingSettings.templateShippingEstimateCents = 0;
            console.log(`[pricing] ✓ Free shipping policy detected - setting templateShippingEstimateCents to 0`);
          } else {
            const extractedCost = extractShippingCost(policy);
            if (extractedCost !== null && extractedCost !== pricingSettings.templateShippingEstimateCents) {
              pricingSettings.templateShippingEstimateCents = extractedCost;
              console.log(`[pricing] ✓ Extracted shipping cost from policy: ${extractedCost} cents`);
            }
          }
        } else {
          console.warn(`[pricing] Failed to fetch fulfillment policy ${fulfillmentPolicyId}: ${policyRes.status}`);
        }
      }
    } catch (err) {
      console.warn(`[pricing] Failed to check fulfillment policy for free shipping:`, err);
    }
  }

  try {
    const writeJobStart = Date.now();
    await writeJob(jobId, userId, {
      state: "running",
      startedAt: Date.now(),
      totalProducts: products.length,
      processedProducts: 0,
    });
    console.log(`[PERF] Initial writeJob took ${Date.now() - writeJobStart}ms`);

    const drafts: Draft[] = [];
    const errors: any[] = [];
    
    // Track completed count for progress updates
    let completedCount = 0;
    
    const loopStartTime = Date.now();
    console.log(`[PERF] Starting BATCHED processing of ${products.length} products...`);
    
    // Process products in batches to avoid overwhelming connections
    // CONCURRENCY_LIMIT controls how many products process simultaneously
    const CONCURRENCY_LIMIT = 3; // Conservative: 3 products at a time
    const batches: typeof products[] = [];
    
    for (let i = 0; i < products.length; i += CONCURRENCY_LIMIT) {
      batches.push(products.slice(i, i + CONCURRENCY_LIMIT));
    }
    
    console.log(`[PERF] Processing ${batches.length} batches with concurrency limit of ${CONCURRENCY_LIMIT}`);
    
    const results: PromiseSettledResult<any>[] = [];
    
    // Process each batch sequentially, but products within batch run in parallel
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      const batchStartTime = Date.now();
      console.log(`[PERF] === Starting batch ${batchIndex + 1}/${batches.length} (${batch.length} products) ===`);
      
      const batchResults = await Promise.allSettled(
        batch.map(async (product, i) => {
          const absoluteIndex = batchIndex * CONCURRENCY_LIMIT + i;
          const productStartTime = Date.now();
          console.log(`\n[PERF] ========== PRODUCT ${absoluteIndex + 1}/${products.length} START (Batch ${batchIndex + 1}) ==========`);
          console.log(`[PERF] Product ID: ${product.productId}`);
          
          try {
            const draft = await createDraftForProduct(product, promotion, pricingSettings);
            
            const productTotalTime = Date.now() - productStartTime;
            console.log(`[PERF] Product ${absoluteIndex + 1}/${products.length} TOTAL time: ${productTotalTime}ms`);
            console.log(`[PERF] ========== PRODUCT ${absoluteIndex + 1}/${products.length} END ==========\n`);
            
            // Update progress (increment completed count)
            completedCount++;
            const progressStart = Date.now();
            await writeJob(jobId, userId, {
              state: "running",
              processedProducts: completedCount,
              totalProducts: products.length,
            });
            console.log(`[PERF] Progress update (${completedCount}/${products.length}) took ${Date.now() - progressStart}ms`);
            
            return { success: true, draft };
          } catch (err: any) {
            console.error(`[Draft] Error creating draft for ${product.productId}:`, err);
            completedCount++;
            return {
              success: false,
              error: {
                productId: product.productId,
                error: err.message || String(err),
              }
            };
          }
        })
      );
      
      results.push(...batchResults);
      
      const batchTotalTime = Date.now() - batchStartTime;
      console.log(`[PERF] === Batch ${batchIndex + 1}/${batches.length} completed in ${batchTotalTime}ms ===\n`);
    }
    
    // Collect results
    for (const result of results) {
      if (result.status === 'fulfilled') {
        if (result.value.success && result.value.draft) {
          drafts.push(result.value.draft);
        } else if (!result.value.success) {
          errors.push(result.value.error);
        }
      } else {
        errors.push({
          productId: 'unknown',
          error: result.reason?.message || String(result.reason),
        });
      }
    }
    
    const loopTotalTime = Date.now() - loopStartTime;
    console.log(`[PERF] BATCHED PROCESSING COMPLETE: ${loopTotalTime}ms for ${products.length} products`);
    console.log(`[PERF] Wall-clock time per product: ${Math.round(loopTotalTime / products.length)}ms (batched with concurrency ${CONCURRENCY_LIMIT})`);
    console.log(`[PERF] Speed improvement vs sequential: ~${Math.round(products.length * 45000 / loopTotalTime)}x faster`);
    
    // Track user stats (drafts created this week)
    if (drafts.length > 0) {
      await recordDraftsCreated(userId, drafts.length);
    }
    
    await writeJob(jobId, userId, {
      state: "completed",
      finishedAt: Date.now(),
      totalProducts: products.length,
      processedProducts: products.length,
      drafts,
      errors: errors.length > 0 ? errors : undefined,
    });

    console.log(JSON.stringify({ 
      evt: "smartdrafts-create-drafts.completed", 
      userId, 
      jobId, 
      draftCount: drafts.length,
      errorCount: errors.length,
    }));

  } catch (err: any) {
    console.error("[smartdrafts-create-drafts-background] error", err);
    await writeJob(jobId, userId, {
      state: "error",
      finishedAt: Date.now(),
      error: err.message || String(err),
    });
  }

  return { statusCode: 200 };
};
