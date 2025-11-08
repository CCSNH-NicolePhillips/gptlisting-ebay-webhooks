import type { Handler } from '@netlify/functions';
import { accessTokenFromRefresh, tokenHosts } from '../../src/lib/_common.js';
import { tokensStore } from '../../src/lib/_blobs.js';
import { putCategory, getCategoryById } from '../../src/lib/taxonomy-store.js';
import type { CategoryDef, ItemSpecific } from '../../src/lib/taxonomy-schema.js';

type EbayAspect = {
  localizedAspectName: string;
  aspectConstraint: {
    aspectDataType: string;
    aspectRequired: boolean;
    aspectMode?: string;
    itemToAspectCardinality?: string;
  };
  aspectValues?: Array<{
    localizedValue: string;
    valueConstraints?: any[];
  }>;
};

type EbayCategory = {
  categoryId: string;
  categoryName: string;
  categoryTreeId?: string;
  aspects?: EbayAspect[];
};

type JobStatus = {
  jobId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  total: number;
  processed: number;
  success: number;
  failed: number;
  startedAt: number;
  updatedAt?: number;
  completedAt?: number;
  errors?: any[];
};

/**
 * Background worker that fetches categories from a queue.
 * This runs as a background function to avoid timeouts.
 */
export const handler: Handler = async (event) => {
  const store = tokensStore();
  
  try {
    // Check if a specific jobId was passed in the body
    let targetJobId: string | undefined;
    try {
      const body = event.body ? JSON.parse(event.body) : {};
      targetJobId = body.jobId;
    } catch (e) {
      // No body or invalid JSON, will check index for active jobs
    }

    // If no specific jobId, get the first active job from index
    if (!targetJobId) {
      const index = (await store.get('category-fetch-index.json', { type: 'json' }).catch(() => null)) as any;
      const activeJobs = (index?.activeJobs || []) as string[];
      
      if (activeJobs.length === 0) {
        console.log('No active jobs to process');
        return { statusCode: 200, body: JSON.stringify({ ok: true, message: 'No active jobs' }) };
      }
      
      targetJobId = activeJobs[0];
    }

    // Get the queue for this job
    const queueKey = `category-fetch-queue-${targetJobId}.json`;
    const queue = (await store.get(queueKey, { type: 'json' }).catch(() => null)) as any;
    
    if (!queue || !Array.isArray(queue.categories) || queue.categories.length === 0) {
      console.log(`Queue for job ${targetJobId} is empty or not found`);
      
      // Remove from active jobs
      const index = (await store.get('category-fetch-index.json', { type: 'json' }).catch(() => null)) as any;
      const activeJobs = (index?.activeJobs || []) as string[];
      await store.setJSON('category-fetch-index.json', {
        activeJobs: activeJobs.filter(id => id !== targetJobId),
      });
      
      return { statusCode: 200, body: JSON.stringify({ ok: true, message: 'Queue empty' }) };
    }

    // Get job status
    const statusKey = `category-fetch-status-${targetJobId}.json`;
    let status = (await store.get(statusKey, { type: 'json' }).catch(() => null)) as JobStatus | null;
    
    if (!status) {
      status = {
        jobId: targetJobId,
        status: 'running',
        total: queue.categories.length,
        processed: 0,
        success: 0,
        failed: 0,
        startedAt: Date.now(),
        errors: [],
      };
    }

    status.status = 'running';
    status.updatedAt = Date.now();

    // Get eBay credentials
    const saved = (await store.get('ebay.json', { type: 'json' })) as any;
    const refresh = saved?.refresh_token as string | undefined;
    if (!refresh) {
      console.error('No eBay refresh token');
      return { statusCode: 500, body: JSON.stringify({ error: 'No eBay credentials' }) };
    }

    const { access_token } = await accessTokenFromRefresh(refresh);
    const ENV = process.env.EBAY_ENV || 'PROD';
    const { apiHost } = tokenHosts(ENV);

    const fetchHeaders = {
      Authorization: `Bearer ${access_token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    // Process up to 5 categories per execution (to stay under time limits)
    const batchSize = 5;
    const batch = queue.categories.splice(0, batchSize);
    
    console.log(`Processing batch of ${batch.length} categories. Queue remaining: ${queue.categories.length}`);
    
    let skipped = 0;

    for (const cat of batch) {
      try {
        // Check if category already exists in database
        const existing = await getCategoryById(cat.id);
        if (existing) {
          console.log(`Skipping category ${cat.id} - already in database`);
          skipped++;
          status.processed++;
          status.success++;
          continue;
        }

        const url = `${apiHost}/commerce/taxonomy/v1/category_tree/${queue.categoryTreeId}/get_item_aspects_for_category?category_id=${cat.id}`;
        const response = await fetch(url, { headers: fetchHeaders });

        if (!response.ok) {
          status.failed++;
          status.errors?.push({ categoryId: cat.id, categoryName: cat.name, error: `HTTP ${response.status}` });
          continue;
        }

        const data = (await response.json()) as EbayCategory;

        // Convert aspects
        const itemSpecifics: ItemSpecific[] = [];
        for (const aspect of data.aspects || []) {
          const itemSpecific: ItemSpecific = {
            name: aspect.localizedAspectName,
            type: Array.isArray(aspect.aspectValues) && aspect.aspectValues.length > 0 ? 'enum' : 'string',
            required: aspect.aspectConstraint?.aspectRequired || false,
            source: 'group',
          };

          if (itemSpecific.type === 'enum' && aspect.aspectValues!.length <= 100) {
            itemSpecific.enum = aspect.aspectValues!.map((v) => v.localizedValue);
          }

          itemSpecifics.push(itemSpecific);
        }

        const categoryName = data.categoryName || cat.name;
        const slug = categoryName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

        const categoryDef: CategoryDef = {
          id: cat.id,
          slug: `${slug}-${cat.id}`,
          title: categoryName,
          marketplaceId: queue.marketplaceId,
          itemSpecifics,
          version: 1,
          updatedAt: Date.now(),
        };

        await putCategory(categoryDef);
        status.success++;

        // Small delay to avoid rate limits
        await new Promise((resolve) => setTimeout(resolve, 200));
      } catch (e: any) {
        status.failed++;
        status.errors?.push({ categoryId: cat.id, categoryName: cat.name, error: e?.message || String(e) });
      }

      status.processed++;
    }

    // Update status
    status.updatedAt = Date.now();
    
    console.log(`Batch summary - Processed: ${status.processed}/${status.total}, Success: ${status.success}, Failed: ${status.failed}, Queue remaining: ${queue.categories.length}`);
    
    // Save status BEFORE triggering next batch (so we don't lose progress if trigger fails)
    await store.setJSON(statusKey, status);
    
    if (queue.categories.length === 0) {
      // Job completed
      status.status = 'completed';
      status.completedAt = Date.now();
      
      // Remove from active jobs
      const index = (await store.get('category-fetch-index.json', { type: 'json' }).catch(() => null)) as any;
      const activeJobs = (index?.activeJobs || []) as string[];
      await store.setJSON('category-fetch-index.json', {
        activeJobs: activeJobs.filter(id => id !== targetJobId),
      });
    } else {
      // Still processing - update queue and trigger next batch
      status.status = 'running';
      
      console.log(`Saving updated queue with ${queue.categories.length} categories remaining`);
      await store.setJSON(queueKey, queue);
      
      // Re-trigger this function for the next batch with retry logic
      const baseUrl = process.env.APP_URL || process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL || 'https://ebaywebhooks.netlify.app';
      const target = `${baseUrl.replace(/\/$/, '')}/.netlify/functions/ebay-fetch-categories-background`;
      
      console.log(`Triggering next batch for job ${targetJobId}, ${queue.categories.length} categories remaining`);
      
      // Retry logic with exponential backoff
      const triggerNextBatch = async (attempt = 1, maxAttempts = 3) => {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout
          
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
            const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 5000); // 1s, 2s, 4s
            console.log(`Retrying in ${delayMs}ms...`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
            return triggerNextBatch(attempt + 1, maxAttempts);
          } else {
            // All retries failed - save to status
            const criticalError = {
              categoryId: 'SYSTEM',
              categoryName: 'Chain trigger failed after retries',
              error: err?.message || String(err),
              timestamp: Date.now(),
            };
            status.errors?.push(criticalError);
            await store.setJSON(statusKey, status);
            console.error('CRITICAL: Failed to trigger next batch after all retries');
          }
        }
      };
      
      // Don't await - trigger async with retries
      triggerNextBatch().catch(err => {
        console.error('Unexpected error in triggerNextBatch:', err);
      });
    }

    console.log(`Batch complete: ${batch.length} processed, ${skipped} skipped (already in DB)`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        jobId: targetJobId,
        processed: status.processed,
        total: status.total,
        remaining: queue.categories.length,
        skipped,
        status: status.status,
      }),
    };
  } catch (e: any) {
    console.error('Background worker error:', e);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: e?.message || String(e) }),
    };
  }
};

/**
 * Background worker to process category fetch queues.
 * 
 * This function can be called:
 * 1. Manually via POST /.netlify/functions/ebay-fetch-categories-background
 * 2. Via external cron service (e.g., Upstash QStash, cron-job.org)
 * 3. Via Netlify scheduled functions (Pro plan required)
 * 
 * To set up scheduled execution with an external service:
 * - URL: https://your-site.netlify.app/.netlify/functions/ebay-fetch-categories-background
 * - Method: POST
 * - Schedule: Every 1 minute
 * - Headers: (optional) Authorization header if you add auth
 */
