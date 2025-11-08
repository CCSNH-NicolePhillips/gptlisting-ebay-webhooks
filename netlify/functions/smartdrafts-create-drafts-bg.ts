import type { Handler } from '@netlify/functions';
import { tokensStore } from '../../src/lib/_blobs.js';
import { pickCategoryForGroup } from '../../src/lib/taxonomy-select.js';
import type { CategoryDef } from '../../src/lib/taxonomy-schema.js';
import { openai } from '../../src/lib/openai.js';

const MODEL = process.env.GPT_MODEL || "gpt-4o-mini";
const MAX_TOKENS = Number(process.env.GPT_MAX_TOKENS || 1000);
const GPT_RETRY_ATTEMPTS = Math.max(1, Number(process.env.GPT_RETRY_ATTEMPTS || 2));
const GPT_RETRY_DELAY_MS = Math.max(250, Number(process.env.GPT_RETRY_DELAY_MS || 1500));

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

type JobStatus = {
  jobId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  startedAt: number;
  updatedAt?: number;
  completedAt?: number;
  errors?: any[];
};

/**
 * Retry blob storage operations with exponential backoff (for EBUSY errors)
 */
async function retryBlobOperation<T>(
  operation: () => Promise<T>,
  operationName: string,
  maxAttempts = 3
): Promise<T> {
  let lastError: any;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (err: any) {
      lastError = err;
      const isLastAttempt = attempt >= maxAttempts;
      const isBusyError = err?.message?.includes('EBUSY') || err?.cause?.code === 'EBUSY' || err?.code === 'EBUSY';
      
      if (isBusyError && !isLastAttempt) {
        const delayMs = Math.min(2000 * Math.pow(2, attempt - 1), 10000);
        console.warn(`[Blob] ${operationName} attempt ${attempt}/${maxAttempts} failed (EBUSY), retrying in ${delayMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      } else if (!isLastAttempt) {
        const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
        console.warn(`[Blob] ${operationName} attempt ${attempt}/${maxAttempts} failed, retrying in ${delayMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      } else {
        console.error(`[Blob] ${operationName} failed after ${maxAttempts} attempts:`, err?.message || err);
        throw err;
      }
    }
  }
  throw lastError;
}

/**
 * Call OpenAI with retry logic
 */
async function callOpenAI(prompt: string): Promise<string> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY");
  }
  
  let lastError: unknown;
  for (let attempt = 1; attempt <= GPT_RETRY_ATTEMPTS; attempt++) {
    try {
      const completion = await openai.chat.completions.create({
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
      });
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

function buildPrompt(product: PairedProduct, categoryHint: CategoryHint | null): string {
  const lines: string[] = [`Product: ${product.product}`];
  if (product.brand && product.brand !== "Unknown") lines.push(`Brand: ${product.brand}`);
  if (product.variant) lines.push(`Variant: ${product.variant}`);
  if (product.size) lines.push(`Size: ${product.size}`);
  if (product.categoryPath) lines.push(`Category hint: ${product.categoryPath}`);
  if (categoryHint) {
    lines.push(`eBay category: ${categoryHint.title} (ID: ${categoryHint.id})`);
  }
  if (product.evidence && product.evidence.length > 0) {
    lines.push(`Matching evidence: ${product.evidence.join('; ')}`);
  }
  lines.push("", "Create a professional eBay listing with accurate details.");
  return lines.join("\n");
}

async function pickCategory(product: PairedProduct): Promise<CategoryHint | null> {
  try {
    const category = await pickCategoryForGroup({
      brand: product.brand || undefined,
      product: product.product,
      variant: product.variant || undefined,
      size: product.size || undefined,
      claims: [],
      keywords: [],
    });
    if (!category) return null;
    return { id: category.id, title: category.title, aspects: {} };
  } catch (err) {
    console.error(`[Category] Error:`, err);
    return null;
  }
}

function parseGptResponse(responseText: string, product: PairedProduct): any {
  try {
    const parsed = JSON.parse(responseText);
    return {
      title: typeof parsed.title === 'string' ? parsed.title.slice(0, 80) : `${product.brand} ${product.product}`.slice(0, 80),
      description: typeof parsed.description === 'string' ? parsed.description.slice(0, 1200) : `${product.brand} ${product.product}`,
      bullets: Array.isArray(parsed.bullets) ? parsed.bullets.slice(0, 5) : [],
      aspects: typeof parsed.aspects === 'object' && parsed.aspects !== null ? parsed.aspects : {},
      price: typeof parsed.price === 'number' && parsed.price > 0 ? parsed.price : undefined,
      condition: typeof parsed.condition === 'string' ? parsed.condition : 'NEW',
    };
  } catch (err) {
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

function normalizeAspects(aspects: any, product: PairedProduct): Record<string, string[]> {
  const normalized: Record<string, string[]> = {};
  if (typeof aspects === 'object' && aspects !== null) {
    for (const [key, value] of Object.entries(aspects)) {
      if (Array.isArray(value)) {
        const stringValues = value.map(v => String(v).trim()).filter(Boolean);
        if (stringValues.length > 0) normalized[key] = stringValues.slice(0, 10);
      } else if (value !== null && value !== undefined) {
        const stringValue = String(value).trim();
        if (stringValue) normalized[key] = [stringValue];
      }
    }
  }
  if (product.brand && product.brand !== "Unknown" && !normalized.Brand) {
    normalized.Brand = [product.brand];
  }
  if (product.size && !normalized.Size) normalized.Size = [product.size];
  return normalized;
}

async function createDraftForProduct(product: PairedProduct): Promise<Draft> {
  console.log(`[Draft] Creating for: ${product.productId}`);
  const categoryHint = await pickCategory(product);
  const prompt = buildPrompt(product, categoryHint);
  const responseText = await callOpenAI(prompt);
  const parsed = parseGptResponse(responseText, product);
  const aspects = normalizeAspects(parsed.aspects, product);
  const images = [product.heroDisplayUrl, product.backDisplayUrl, ...(product.extras || [])].filter(Boolean);
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
  console.log(`[Draft] ✓ Created for ${product.productId}: "${draft.title}"`);
  return draft;
}

/**
 * Background worker that creates ChatGPT drafts from a queue.
 * Processes a few products at a time to avoid timeouts.
 */
export const handler: Handler = async (event) => {
  const store = tokensStore();
  
  try {
    // Get jobId from request body
    let targetJobId: string | undefined;
    try {
      const body = event.body ? JSON.parse(event.body) : {};
      targetJobId = body.jobId;
    } catch (e) {
      // Check for active jobs in index
    }

    // If no specific jobId, get the first active job from index
    if (!targetJobId) {
      const index = (await store.get('drafts-job-index.json', { type: 'json' }).catch(() => null)) as any;
      const activeJobs = (index?.activeJobs || []) as string[];
      
      if (activeJobs.length === 0) {
        console.log('No active draft jobs to process');
        return { statusCode: 200, body: JSON.stringify({ ok: true, message: 'No active jobs' }) };
      }
      
      targetJobId = activeJobs[0];
    }

    // Get the queue for this job
    const queueKey = `drafts-queue-${targetJobId}.json`;
    const queue = (await store.get(queueKey, { type: 'json' }).catch(() => null)) as any;
    
    if (!queue || !Array.isArray(queue.products) || queue.products.length === 0) {
      console.log(`Queue for job ${targetJobId} is empty or not found`);
      
      // Remove from active jobs
      const index = (await store.get('drafts-job-index.json', { type: 'json' }).catch(() => null)) as any;
      const activeJobs = (index?.activeJobs || []) as string[];
      await store.setJSON('drafts-job-index.json', {
        activeJobs: activeJobs.filter(id => id !== targetJobId),
      });
      
      return { statusCode: 200, body: JSON.stringify({ ok: true, message: 'Queue empty' }) };
    }

    // Get job status
    const statusKey = `drafts-status-${targetJobId}.json`;
    let status = (await store.get(statusKey, { type: 'json' }).catch(() => null)) as JobStatus | null;
    
    if (!status) {
      status = {
        jobId: targetJobId,
        status: 'running',
        total: queue.products.length,
        processed: 0,
        succeeded: 0,
        failed: 0,
        startedAt: Date.now(),
        errors: [],
      };
    }

    status.status = 'running';
    status.updatedAt = Date.now();

    // Process up to 3 products per execution (ChatGPT is slow, ~3-5s each)
    const batchSize = 3;
    const batch = queue.products.splice(0, batchSize);
    
    console.log(`Processing batch of ${batch.length} products. Queue remaining: ${queue.products.length}`);
    
    const drafts: Draft[] = [];

    for (const product of batch) {
      try {
        console.log(`Creating draft for product ${product.productId}...`);
        const draft = await createDraftForProduct(product);
        drafts.push(draft);
        status.succeeded++;
      } catch (err: any) {
        status.failed++;
        const errorMsg = err?.message || String(err);
        console.error(`Failed to create draft for ${product.productId}:`, errorMsg);
        status.errors?.push({ 
          productId: product.productId, 
          error: errorMsg 
        });
      }

      status.processed++;
    }

    // Save drafts to results blob with retry
    if (drafts.length > 0) {
      const resultsKey = `drafts-results-${targetJobId}.json`;
      const existingResults = (await retryBlobOperation(
        () => store.get(resultsKey, { type: 'json' }),
        'Get results',
        3
      ).catch(() => ({ drafts: [] }))) as any;
      existingResults.drafts = [...(existingResults.drafts || []), ...drafts];
      await retryBlobOperation(
        () => store.setJSON(resultsKey, existingResults),
        'Save results',
        5
      );
    }

    // Update status
    status.updatedAt = Date.now();
    
    console.log(`Batch summary - Processed: ${status.processed}/${status.total}, Succeeded: ${status.succeeded}, Failed: ${status.failed}, Queue remaining: ${queue.products.length}`);
    
    // Save status BEFORE triggering next batch with retry
    await retryBlobOperation(
      () => store.setJSON(statusKey, status),
      'Save status',
      5
    );
    
    if (queue.products.length === 0) {
      // Job completed
      status.status = 'completed';
      status.completedAt = Date.now();
      await retryBlobOperation(
        () => store.setJSON(statusKey, status),
        'Save final status',
        5
      );
      
      // Remove from active jobs with retry
      const index = (await retryBlobOperation(
        () => store.get('drafts-job-index.json', { type: 'json' }),
        'Get job index',
        3
      ).catch(() => null)) as any;
      const activeJobs = (index?.activeJobs || []) as string[];
      await retryBlobOperation(
        () => store.setJSON('drafts-job-index.json', {
          activeJobs: activeJobs.filter(id => id !== targetJobId),
        }),
        'Update job index',
        3
      );
      
      console.log(`Job ${targetJobId} completed! Total: ${status.succeeded} succeeded, ${status.failed} failed`);
    } else {
      // Still processing - update queue and trigger next batch
      status.status = 'running';
      
      console.log(`Saving updated queue with ${queue.products.length} products remaining`);
      await retryBlobOperation(
        () => store.setJSON(queueKey, queue),
        'Save queue',
        5
      );
      
      // Re-trigger this function for the next batch with retry logic
      const baseUrl = process.env.APP_URL || process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL || 'https://ebaywebhooks.netlify.app';
      const target = `${baseUrl.replace(/\/$/, '')}/.netlify/functions/smartdrafts-create-drafts-bg`;
      
      console.log(`Triggering next batch for job ${targetJobId}, ${queue.products.length} products remaining`);
      
      // Retry logic with exponential backoff
      const triggerNextBatch = async (attempt = 1, maxAttempts = 3) => {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 5000);
          
          const res = await fetch(target, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobId: targetJobId }),
            signal: controller.signal,
          });
          
          clearTimeout(timeoutId);
          
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
          }
          
          console.log(`✓ Next batch triggered successfully (attempt ${attempt})`);
        } catch (err: any) {
          const isLastAttempt = attempt >= maxAttempts;
          console.error(`✗ Batch trigger attempt ${attempt}/${maxAttempts} failed:`, err?.message);
          
          if (!isLastAttempt) {
            const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
            console.log(`Retrying in ${delayMs}ms...`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
            return triggerNextBatch(attempt + 1, maxAttempts);
          } else {
            // All retries failed - save with retry logic
            const criticalError = {
              productId: 'SYSTEM',
              error: `Chain trigger failed after retries: ${err?.message || String(err)}`,
              timestamp: Date.now(),
            };
            status.errors?.push(criticalError);
            await retryBlobOperation(
              () => store.setJSON(statusKey, status),
              'Save error status',
              5
            ).catch(saveErr => {
              console.error('Failed to save error status even after retries:', saveErr);
            });
            console.error('CRITICAL: Failed to trigger next batch after all retries');
          }
        }
      };
      
      // Don't await - trigger async with retries
      triggerNextBatch().catch(err => {
        console.error('Unexpected error in triggerNextBatch:', err);
      });
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        jobId: targetJobId,
        processed: status.processed,
        total: status.total,
        remaining: queue.products.length,
        status: status.status,
      }),
    };
  } catch (e: any) {
    console.error('Background worker error:', e);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: e?.message || 'Internal error' }),
    };
  }
};
