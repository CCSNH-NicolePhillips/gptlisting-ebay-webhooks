import type { Handler } from '@netlify/functions';
import { accessTokenFromRefresh, tokenHosts } from '../../src/lib/_common.js';
import { tokensStore } from '../../src/lib/_blobs.js';
import { putCategory, getCategoryById } from '../../src/lib/taxonomy-store.js';
import type { CategoryDef, ItemSpecific } from '../../src/lib/taxonomy-schema.js';
import { getOrigin, isAuthorized, isOriginAllowed, jsonResponse } from '../../src/lib/http.js';

const METHODS = 'POST, OPTIONS';

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

type CategoryTreeNode = {
  category: {
    categoryId: string;
    categoryName: string;
  };
  categoryTreeNodeLevel?: number;
  childCategoryTreeNodes?: CategoryTreeNode[];
};

/**
 * Starts a background job to fetch the entire category tree from eBay.
 * Returns immediately with a jobId that can be used to check status.
 * 
 * POST /.netlify/functions/ebay-fetch-all-categories
 * Body: { 
 *   marketplaceId: "EBAY_US",
 *   parentCategoryId: "26395"  // optional: only fetch categories under this parent
 * }
 * 
 * Returns: { ok: true, jobId: "job-12345", totalCategories: 1234 }
 * 
 * Check status at: /.netlify/functions/ebay-fetch-categories-status?jobId=job-12345
 */
export const handler: Handler = async (event) => {
  const headers = event.headers as Record<string, string | undefined>;
  const originHdr = getOrigin(headers);

  if (event.httpMethod === 'OPTIONS') {
    return jsonResponse(200, {}, originHdr, METHODS);
  }

  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' }, originHdr, METHODS);
  }

  if (!isOriginAllowed(originHdr)) {
    return jsonResponse(403, { error: 'Forbidden' }, originHdr, METHODS);
  }

  // Skip admin token check - this endpoint is for logged-in users
  // if (!isAuthorized(headers)) {
  //   return jsonResponse(401, { error: 'Unauthorized' }, originHdr, METHODS);
  // }

  try {
    const body = JSON.parse(event.body || '{}');
    const marketplaceId = String(body.marketplaceId || 'EBAY_US').trim();
    const delayMs = Number(body.delayMs || 200);
    const maxCategories = Number(body.maxCategories || 0); // 0 = no limit
    const parentCategoryId = String(body.parentCategoryId || '').trim(); // optional filter

    // Map marketplace to category tree ID
    const categoryTreeMap: Record<string, string> = {
      EBAY_US: '0',
      EBAY_GB: '3',
      EBAY_DE: '77',
      EBAY_AU: '15',
      EBAY_CA: '2',
      EBAY_FR: '71',
      EBAY_IT: '101',
      EBAY_ES: '186',
    };

    const categoryTreeId = categoryTreeMap[marketplaceId] || '0';

    // Get eBay access token
    const store = tokensStore();
    const saved = (await store.get('ebay.json', { type: 'json' })) as any;
    const refresh = saved?.refresh_token as string | undefined;
    if (!refresh) {
      return jsonResponse(400, { error: 'Connect eBay first' }, originHdr, METHODS);
    }

    const { access_token } = await accessTokenFromRefresh(refresh);
    const ENV = process.env.EBAY_ENV || 'PROD';
    const { apiHost } = tokenHosts(ENV);

    const fetchHeaders = {
      Authorization: `Bearer ${access_token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    // Step 1: Fetch the category tree
    const treeUrl = `${apiHost}/commerce/taxonomy/v1/category_tree/${categoryTreeId}`;
    const treeResponse = await fetch(treeUrl, { headers: fetchHeaders });

    if (!treeResponse.ok) {
      const errorText = await treeResponse.text();
      return jsonResponse(treeResponse.status, {
        error: 'Failed to fetch category tree',
        status: treeResponse.status,
        detail: errorText,
      }, originHdr, METHODS);
    }

    const treeData = await treeResponse.json() as any;
    const rootNode = treeData.rootCategoryNode as CategoryTreeNode;

    // Step 2: Find the starting node (either root or a specific parent category)
    let startNode: CategoryTreeNode = rootNode;
    
    if (parentCategoryId) {
      // Find the parent category node in the tree
      function findNodeById(node: CategoryTreeNode, targetId: string): CategoryTreeNode | null {
        if (node.category.categoryId === targetId) {
          return node;
        }
        if (Array.isArray(node.childCategoryTreeNodes)) {
          for (const child of node.childCategoryTreeNodes) {
            const found = findNodeById(child, targetId);
            if (found) return found;
          }
        }
        return null;
      }
      
      const parentNode = findNodeById(rootNode, parentCategoryId);
      if (!parentNode) {
        return jsonResponse(400, {
          error: `Parent category ${parentCategoryId} not found in tree`,
        }, originHdr, METHODS);
      }
      
      startNode = parentNode;
    }

    // Step 3: Collect all leaf category IDs (categories with no children)
    const leafCategories: Array<{ id: string; name: string }> = [];

    function collectLeafCategories(node: CategoryTreeNode) {
      const hasChildren = Array.isArray(node.childCategoryTreeNodes) && node.childCategoryTreeNodes.length > 0;
      
      if (!hasChildren) {
        // This is a leaf category
        leafCategories.push({
          id: node.category.categoryId,
          name: node.category.categoryName,
        });
      } else {
        // Recurse into children
        for (const child of node.childCategoryTreeNodes!) {
          collectLeafCategories(child);
        }
      }
    }

    collectLeafCategories(startNode);

    const totalCategories = leafCategories.length;
    const categoriesToFetch = maxCategories > 0 
      ? leafCategories.slice(0, maxCategories)
      : leafCategories;

    console.log(`Found ${categoriesToFetch.length} leaf categories total`);

    // Step 2.5: Filter out categories already in Redis
    // BUT limit pre-filtering to avoid timeout on very large sets
    console.log('Filtering out already-cached categories...');
    const uncachedCategories: Array<{ id: string; name: string }> = [];
    let alreadyCached = 0;
    
    // Only pre-filter if checking < 1000 categories (to avoid timeout)
    const shouldPreFilter = categoriesToFetch.length < 1000;
    
    if (shouldPreFilter) {
      console.log(`Pre-filtering ${categoriesToFetch.length} categories against Redis...`);
      for (const cat of categoriesToFetch) {
        const existing = await getCategoryById(cat.id);
        if (existing) {
          alreadyCached++;
        } else {
          uncachedCategories.push({ id: cat.id, name: cat.name });
        }
      }
      console.log(`Already cached: ${alreadyCached}, Need to fetch: ${uncachedCategories.length}`);
    } else {
      // For large sets, skip pre-filtering here and let worker handle duplicates
      console.log(`Large category set (${categoriesToFetch.length}), skipping pre-filter to avoid timeout`);
      uncachedCategories.push(...categoriesToFetch);
    }

    if (uncachedCategories.length === 0) {
      return jsonResponse(200, {
        ok: true,
        message: 'All categories are already cached!',
        totalCategories: categoriesToFetch.length,
        alreadyCached,
        needToFetch: 0,
      }, originHdr, METHODS);
    }

    // Step 3: Create background job instead of processing synchronously
    const jobId = `job-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    // Limit queue size to prevent memory issues (max 100 categories per queue)
    const MAX_QUEUE_SIZE = 100;
    const firstBatch = uncachedCategories.slice(0, MAX_QUEUE_SIZE);
    const remaining = uncachedCategories.slice(MAX_QUEUE_SIZE);
    
    // Create queue with first batch only
    const queue = {
      jobId,
      marketplaceId,
      categoryTreeId,
      categories: firstBatch,
      createdAt: Date.now(),
    };

    // Store remaining categories separately if any
    const backlog = {
      jobId,
      remaining,
    };

    // Create initial job status
    const status = {
      jobId,
      total: uncachedCategories.length,
      totalCategories: uncachedCategories.length, // Keep for backward compat
      processed: 0,
      success: 0,
      failed: 0,
      queued: firstBatch.length, // How many in active queue
      backlog: remaining.length, // How many waiting
      status: 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      parentCategory: parentCategoryId ? `${startNode.category.categoryName} (${parentCategoryId})` : 'All categories',
      alreadyCached, // Track how many we skipped upfront
    };

    // Store queue and status in blob storage
    const blobStore = tokensStore();
    await blobStore.setJSON(`category-fetch-queue-${jobId}.json`, queue);
    await blobStore.setJSON(`category-fetch-status-${jobId}.json`, status);
    
    // Store backlog separately (only if there is one)
    if (remaining.length > 0) {
      await blobStore.setJSON(`category-fetch-backlog-${jobId}.json`, backlog);
    }

    // Add to active jobs index
    const index = (await blobStore.get('category-fetch-index.json', { type: 'json' }).catch(() => null)) as any;
    const activeJobs = index?.activeJobs || [];
    if (!activeJobs.includes(jobId)) {
      activeJobs.push(jobId);
      await blobStore.setJSON('category-fetch-index.json', { activeJobs });
    }

    // Trigger background worker to start processing
    const baseUrl = process.env.APP_URL || process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL || 'https://ebaywebhooks.netlify.app';
    const target = `${baseUrl.replace(/\/$/, '')}/.netlify/functions/ebay-fetch-categories-background`;

    try {
      const resp = await fetch(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId }),
      });

      if (!resp.ok) {
        console.warn(`Background worker invoke failed: ${resp.status} ${resp.statusText}`);
        // Continue anyway - worker can be triggered manually or via external cron
      }
    } catch (err: any) {
      console.warn('Background worker fetch exception:', err?.message);
      // Continue anyway - worker can be triggered manually or via external cron
    }

    return jsonResponse(200, {
      ok: true,
      jobId,
      totalCategories: uncachedCategories.length,
      alreadyCached,
      message: `Background job created. Skipped ${alreadyCached} already-cached categories. Fetching ${uncachedCategories.length} new ones.`,
      parentCategory: parentCategoryId ? `${startNode.category.categoryName} (${parentCategoryId})` : 'All categories',
    }, originHdr, METHODS);
  } catch (e: any) {
    console.error('Error fetching all categories:', e);
    return jsonResponse(500, {
      error: 'Failed to fetch all categories',
      detail: e?.message || String(e),
    }, originHdr, METHODS);
  }
};
