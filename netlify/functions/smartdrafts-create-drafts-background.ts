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

// Cache categories in memory for the lifetime of this function instance
let categoriesCache: any[] | null = null;
let categoriesLoadingPromise: Promise<any[]> | null = null;

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
  groupId: string; // For eBay publishing via create-ebay-draft-user
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
              content: "You are an eBay listing assistant. Respond only with valid JSON matching the requested format.",
            },
            { role: "user", content: prompt },
          ],
          max_tokens: 1500, // Ensure enough tokens for complete JSON response with all aspects
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

async function getRelevantCategories(product: PairedProduct): Promise<string> {
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
  lines.push('  "title": "...", // 80 chars max');
  lines.push('  "description": "...",');
  lines.push('  "bullets": ["...", "...", "..."], // 3-5 bullet points');
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

async function createDraftForProduct(product: PairedProduct, retryAttempt: number = 0): Promise<Draft> {
  const startTime = Date.now();
  const retryLabel = retryAttempt > 0 ? ` (retry ${retryAttempt})` : '';
  console.log(`[Draft] Creating for: ${product.productId}${retryLabel}`);
  
  const catListStart = Date.now();
  const relevantCategories = await getRelevantCategories(product);
  console.log(`[Draft] Category list generation took ${Date.now() - catListStart}ms`);
  console.log(`[Draft] Category list preview:\n${relevantCategories.slice(0, 500)}...`);
  
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
    groupId: product.productId, // Add groupId for eBay publishing
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
    return createDraftForProduct(product, retryAttempt + 1);
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

  console.log(`[PERF] Handler started for jobId: ${jobId}, products: ${products.length}`);

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
            const draft = await createDraftForProduct(product);
            
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
