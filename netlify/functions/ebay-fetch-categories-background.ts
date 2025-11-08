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
      await store.setJSON(queueKey, queue);
      
      // Re-trigger this function for the next batch
      const baseUrl = process.env.APP_URL || process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL || 'https://ebaywebhooks.netlify.app';
      const target = `${baseUrl.replace(/\/$/, '')}/.netlify/functions/ebay-fetch-categories-background`;
      
      fetch(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: targetJobId }),
      }).catch(err => {
        console.warn('Failed to trigger next batch:', err?.message);
      });
    }
    
    // Save updated status
    await store.setJSON(statusKey, status);

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
