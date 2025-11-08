import type { Handler } from '@netlify/functions';
import { schedule } from '@netlify/functions';
import { accessTokenFromRefresh, tokenHosts } from '../../src/lib/_common.js';
import { tokensStore } from '../../src/lib/_blobs.js';
import { putCategory } from '../../src/lib/taxonomy-store.js';
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
  completedAt?: number;
  errors?: any[];
};

/**
 * Background worker that fetches categories from a queue.
 * This runs as a scheduled background function to avoid timeouts.
 */
export const handler: Handler = async (event) => {
  const store = tokensStore();
  
  try {
    // Get the next batch from the queue
    const queueKey = 'category-fetch-queue.json';
    const queue = (await store.get(queueKey, { type: 'json' }).catch(() => null)) as any;
    
    if (!queue || !Array.isArray(queue.categories) || queue.categories.length === 0) {
      console.log('No categories in queue');
      return { statusCode: 200, body: JSON.stringify({ ok: true, message: 'Queue empty' }) };
    }

    // Get job status
    const statusKey = `category-fetch-status-${queue.jobId}.json`;
    let status = (await store.get(statusKey, { type: 'json' }).catch(() => null)) as JobStatus | null;
    
    if (!status) {
      status = {
        jobId: queue.jobId,
        status: 'running',
        total: queue.total || queue.categories.length,
        processed: 0,
        success: 0,
        failed: 0,
        startedAt: Date.now(),
        errors: [],
      };
    }

    status.status = 'running';

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

    for (const cat of batch) {
      try {
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

    // Update queue and status
    await store.set(queueKey, JSON.stringify(queue));
    
    if (queue.categories.length === 0) {
      status.status = 'completed';
      status.completedAt = Date.now();
    }
    
    await store.set(statusKey, JSON.stringify(status));

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        jobId: queue.jobId,
        processed: status.processed,
        remaining: queue.categories.length,
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

// Schedule to run every minute
export const scheduledHandler = schedule('*/1 * * * *', handler);
