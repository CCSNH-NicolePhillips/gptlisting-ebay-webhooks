import type { Handler } from "@netlify/functions";
import { putJob } from "../../src/lib/job-store.js";
import { k } from "../../src/lib/user-keys.js";

// Import the draft creation logic from the existing function
import OpenAI from "openai";
import { pickCategoryForGroup } from "../../src/lib/taxonomy-select.js";
import { listCategories } from "../../src/lib/taxonomy-store.js";

const GPT_TIMEOUT_MS = 30_000;
const GPT_RETRY_ATTEMPTS = 2;
const GPT_RETRY_DELAY_MS = 1000;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });

type BackgroundPayload = {
  jobId?: string;
  userId?: string;
  products?: any[];
};

type PairedProduct = {
  productId: string;
  brand: string;
  product: string;
  variant?: string;
  size?: string;
  categoryPath?: string;
  heroDisplayUrl?: string;
  backDisplayUrl?: string;
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
  brand: string;
  product: string;
  title: string;
  description: string;
  bullets: string[];
  aspects: Record<string, string[]>;
  category: CategoryHint;
  images: string[];
  price: number;
  condition: string;
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

/**
 * Compute eBay price with category-specific caps and discount formula
 */
function computeEbayPrice(retailPrice: number, categoryPath: string): number {
  if (!retailPrice || retailPrice <= 0) return 0;
  
  const lowerCat = categoryPath.toLowerCase();
  let cappedPrice = retailPrice;
  
  // Apply category-specific caps
  if (lowerCat.includes('book')) {
    cappedPrice = Math.min(retailPrice, 35);
  } else if (lowerCat.includes('dvd') || lowerCat.includes('media') || lowerCat.includes('cd')) {
    cappedPrice = Math.min(retailPrice, 25);
  }
  
  // Apply 10% discount
  let price = cappedPrice * 0.9;
  
  // Add $5 if over $30
  if (price > 30) {
    price += 5;
  }
  
  return Math.round(price * 100) / 100;
}

async function callOpenAI(prompt: string): Promise<string> {
  let lastError: any;
  for (let attempt = 1; attempt <= GPT_RETRY_ATTEMPTS; attempt++) {
    try {
      const completion = await timeoutPromise(
        openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
            {
              role: "system",
              content: "You are an eBay listing assistant. Respond only with valid JSON matching the requested format.",
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

async function getRelevantCategories(product: PairedProduct): Promise<string> {
  try {
    const allCategories = await listCategories();
    
    const searchTerms = [
      product.product,
      product.brand,
      product.variant,
      product.categoryPath
    ].filter(Boolean).join(' ').toLowerCase();
    
    const relevant = allCategories
      .filter(cat => {
        const catText = `${cat.title} ${cat.slug}`.toLowerCase();
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

function parseGptResponse(responseText: string, product: PairedProduct): any {
  try {
    const parsed = JSON.parse(responseText);
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
  
  if (product.brand && product.brand !== "Unknown" && !normalized.Brand) {
    normalized.Brand = [product.brand];
  }
  
  if (product.size && !normalized.Size) {
    normalized.Size = [product.size];
  }
  
  return normalized;
}

async function createDraftForProduct(product: PairedProduct): Promise<Draft> {
  const startTime = Date.now();
  console.log(`[Draft] Creating for: ${product.productId}`);
  
  const catListStart = Date.now();
  const relevantCategories = await getRelevantCategories(product);
  console.log(`[Draft] Category list generation took ${Date.now() - catListStart}ms`);
  
  const catStart = Date.now();
  const categoryHint = await pickCategory(product);
  console.log(`[Draft] Category fallback pick took ${Date.now() - catStart}ms`);
  
  const prompt = buildPrompt(product, categoryHint, relevantCategories);
  console.log(`[Draft] Prompt length: ${prompt.length} chars`);
  
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
  const images = [product.heroDisplayUrl, product.backDisplayUrl, ...(product.extras || [])].filter((x): x is string => Boolean(x));
  
  const retailPrice = typeof parsed.price === 'number' && parsed.price > 0 ? parsed.price : 0;
  const categoryPath = finalCategory?.title || product.categoryPath || '';
  const ebayPrice = computeEbayPrice(retailPrice, categoryPath);
  
  const draft: Draft = {
    productId: product.productId,
    brand: product.brand,
    product: product.product,
    title: parsed.title,
    description: parsed.description,
    bullets: parsed.bullets,
    aspects,
    category: finalCategory || { id: '', title: product.categoryPath || 'Uncategorized', aspects: {} },
    images,
    price: ebayPrice,
    condition: parsed.condition,
  };
  
  console.log(`[Draft] ✓ Created for ${product.productId} in ${Date.now() - startTime}ms: "${draft.title}"`);
  
  return draft;
}

export const handler: Handler = async (event) => {
  const body = parsePayload(event.body);
  const jobId = typeof body.jobId === "string" ? body.jobId : undefined;
  const userId = typeof body.userId === "string" ? body.userId : undefined;
  const products = Array.isArray(body.products) ? body.products : [];

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

  try {
    await writeJob(jobId, userId, {
      state: "running",
      startedAt: Date.now(),
      totalProducts: products.length,
      processedProducts: 0,
    });

    const drafts: Draft[] = [];
    const errors: any[] = [];
    
    for (let i = 0; i < products.length; i++) {
      const product = products[i];
      
      try {
        const draft = await createDraftForProduct(product);
        drafts.push(draft);
        
        // Update progress
        await writeJob(jobId, userId, {
          state: "running",
          processedProducts: i + 1,
          totalProducts: products.length,
        });
        
      } catch (err: any) {
        console.error(`[Draft] Error creating draft for ${product.productId}:`, err);
        errors.push({
          productId: product.productId,
          error: err.message || String(err),
        });
      }
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
