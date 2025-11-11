import type { Handler } from "@netlify/functions";
import { requireUserAuth } from "../../src/lib/auth-user.js";
import { getOrigin, jsonResponse } from "../../src/lib/http.js";
import { pickCategoryForGroup } from "../../src/lib/taxonomy-select.js";
import type { CategoryDef } from "../../src/lib/taxonomy-schema.js";
import { openai } from "../../src/lib/openai.js";

const METHODS = "POST, OPTIONS";
const MODEL = process.env.GPT_MODEL || "gpt-4o-mini";
const MAX_TOKENS = Number(process.env.GPT_MAX_TOKENS || 700);
const GPT_RETRY_ATTEMPTS = Math.max(1, Number(process.env.GPT_RETRY_ATTEMPTS || 1));
const GPT_RETRY_DELAY_MS = Math.max(250, Number(process.env.GPT_RETRY_DELAY_MS || 1500));
const GPT_TIMEOUT_MS = Math.max(5000, Number(process.env.GPT_TIMEOUT_MS || 20000));
const MAX_SEEDS = Math.max(1, Number(process.env.DRAFTS_MAX_SEEDS || 1)); // Process 1 item per request to avoid Netlify timeout

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
  backUrl: string;
  heroDisplayUrl: string;
  backDisplayUrl: string;
  extras?: string[];
  evidence?: string[];
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
  condition?: string;
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
                "You are an expert eBay listing writer.\n" +
                "Return ONLY strict JSON with keys: title, description, bullets, aspects, price, condition.\n" +
                "- title: <=80 chars, high-signal product name, no emojis, no fluff.\n" +
                "- description: 2-4 sentences, neutral factual claims (no medical), highlight key features.\n" +
                "- bullets: array of 3-5 short benefit/feature points.\n" +
                "- aspects: object with Brand, Type, Features, Size, etc. Include all relevant item specifics.\n" +
                "- price: estimated retail price as number (e.g. 29.99)\n" +
                "- condition: one of 'NEW', 'LIKE_NEW', 'USED_EXCELLENT', 'USED_GOOD', 'USED_ACCEPTABLE'\n",
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
 * Build GPT prompt from product data
 */
function buildPrompt(product: PairedProduct, categoryHint: CategoryHint | null): string {
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
  lines.push("Create a professional eBay listing with accurate details.");
  lines.push("Estimate a fair retail price based on the product type.");
  lines.push("Assess condition based on whether it appears to be new/sealed or used.");
  
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
    const parsed = JSON.parse(responseText);
    return {
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
  
  // Step 1: Pick category
  const catStart = Date.now();
  const categoryHint = await pickCategory(product);
  console.log(`[Draft] Category pick took ${Date.now() - catStart}ms for ${product.productId}`);
  
  // Step 2: Build GPT prompt
  const prompt = buildPrompt(product, categoryHint);
  console.log(`[Draft] GPT prompt for ${product.productId}:`, prompt.slice(0, 200) + '...');
  
  // Step 3: Call GPT
  const gptStart = Date.now();
  const responseText = await callOpenAI(prompt);
  console.log(`[Draft] GPT call took ${Date.now() - gptStart}ms for ${product.productId}`);
  console.log(`[Draft] GPT response for ${product.productId}:`, responseText.slice(0, 200) + '...');
  
  // Step 4: Parse response
  const parsed = parseGptResponse(responseText, product);
  
  // Step 5: Normalize aspects
  const aspects = normalizeAspects(parsed.aspects, product);
  
  // Step 6: Collect images
  const images = [product.heroDisplayUrl, product.backDisplayUrl, ...(product.extras || [])].filter(Boolean);
  
  // Step 7: Build final draft
  const draft: Draft = {
    productId: product.productId,
    brand: product.brand,
    product: product.product,
    title: parsed.title,
    description: parsed.description,
    bullets: parsed.bullets,
    aspects,
    category: categoryHint || { id: '', title: product.categoryPath || 'Uncategorized' },
    images,
    price: parsed.price,
    condition: parsed.condition,
  };
  
  console.log(`[Draft] ✓ Created for ${product.productId} in ${Date.now() - startTime}ms: "${draft.title}"`);
  
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
