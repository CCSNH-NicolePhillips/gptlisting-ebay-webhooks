import type { Handler } from '@netlify/functions';
import { accessTokenFromRefresh, tokenHosts } from '../../src/lib/_common.js';
import { tokensStore } from '../../src/lib/_blobs.js';
import { putCategory } from '../../src/lib/taxonomy-store.js';
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
 * Fetches the entire category tree from eBay and populates all leaf categories.
 * Warning: This can take a LONG time (thousands of categories) and may hit rate limits.
 * 
 * POST /.netlify/functions/ebay-fetch-all-categories
 * Body: { 
 *   marketplaceId: "EBAY_US",
 *   delayMs: 200,  // delay between aspect fetches
 *   maxCategories: 100,  // optional limit for testing
 *   parentCategoryId: "26395"  // optional: only fetch categories under this parent (e.g., "26395" = Health & Beauty)
 * }
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

    const results = {
      success: [] as any[],
      failed: [] as any[],
      total: totalCategories,
      fetching: categoriesToFetch.length,
      maxCategories: maxCategories || 'unlimited',
      parentCategoryId: parentCategoryId || 'root',
      parentCategoryName: startNode.category.categoryName,
    };

    // Step 3: Fetch aspects for each leaf category
    let processed = 0;
    for (const cat of categoriesToFetch) {
      try {
        processed++;
        
        // Fetch category aspects
        const url = `${apiHost}/commerce/taxonomy/v1/category_tree/${categoryTreeId}/get_item_aspects_for_category?category_id=${cat.id}`;
        const response = await fetch(url, { headers: fetchHeaders });

        if (!response.ok) {
          const errorText = await response.text();
          results.failed.push({
            categoryId: cat.id,
            categoryName: cat.name,
            status: response.status,
            error: errorText,
          });
          continue;
        }

        const data = (await response.json()) as EbayCategory;

        // Convert eBay aspects to our ItemSpecific format
        const itemSpecifics: ItemSpecific[] = [];

        for (const aspect of data.aspects || []) {
          const name = aspect.localizedAspectName;
          const isRequired = aspect.aspectConstraint?.aspectRequired || false;
          const hasValues = Array.isArray(aspect.aspectValues) && aspect.aspectValues.length > 0;

          const itemSpecific: ItemSpecific = {
            name,
            type: hasValues ? 'enum' : 'string',
            required: isRequired,
            source: 'group',
          };

          if (hasValues && aspect.aspectValues!.length <= 100) {
            // Only store enum values if there aren't too many
            itemSpecific.enum = aspect.aspectValues!.map((v) => v.localizedValue);
          }

          itemSpecifics.push(itemSpecific);
        }

        // Create slug from category name
        const slug = data.categoryName
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '');

        // Create CategoryDef object
        const categoryDef: CategoryDef = {
          id: cat.id,
          slug: `${slug}-${cat.id}`,
          title: data.categoryName,
          marketplaceId,
          itemSpecifics,
          version: 1,
          updatedAt: Date.now(),
        };

        // Store in taxonomy database
        await putCategory(categoryDef);

        results.success.push({
          categoryId: cat.id,
          categoryName: data.categoryName,
          aspectCount: itemSpecifics.length,
          requiredCount: itemSpecifics.filter((s) => s.required).length,
          progress: `${processed}/${categoriesToFetch.length}`,
        });

        // Delay between requests to avoid rate limits
        if (processed < categoriesToFetch.length && delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      } catch (e: any) {
        results.failed.push({
          categoryId: cat.id,
          categoryName: cat.name,
          error: e?.message || String(e),
        });
      }
    }

    return jsonResponse(200, {
      ok: true,
      results,
      summary: {
        totalLeafCategories: totalCategories,
        fetched: categoriesToFetch.length,
        success: results.success.length,
        failed: results.failed.length,
        parentCategory: parentCategoryId ? `${startNode.category.categoryName} (${parentCategoryId})` : 'All categories',
      },
    }, originHdr, METHODS);
  } catch (e: any) {
    console.error('Error fetching all categories:', e);
    return jsonResponse(500, {
      error: 'Failed to fetch all categories',
      detail: e?.message || String(e),
    }, originHdr, METHODS);
  }
};
