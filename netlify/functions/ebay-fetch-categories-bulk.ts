import type { Handler } from '@netlify/functions';
import { accessTokenFromRefresh, tokenHosts } from '../../src/lib/_common.js';
import { tokensStore } from '../../src/lib/redis-store.js';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified, userScopedKey } from '../../src/lib/_auth.js';
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

/**
 * Bulk fetches category aspects from eBay Taxonomy API for multiple categories.
 * 
 * POST /.netlify/functions/ebay-fetch-categories-bulk
 * Body: { 
 *   categoryIds: ["177011", "180959", "261328"],
 *   marketplaceId: "EBAY_US",
 *   delayMs: 100  // optional delay between requests to avoid rate limits
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
    // Auth check
    const bearer = getBearerToken(event);
    let sub = (await requireAuthVerified(event))?.sub || null;
    if (!sub) sub = getJwtSubUnverified(event);
    if (!bearer || !sub) {
      return jsonResponse(401, { error: 'Unauthorized' }, originHdr, METHODS);
    }

    const body = JSON.parse(event.body || '{}');
    const categoryIds = Array.isArray(body.categoryIds) ? body.categoryIds : [];
    const marketplaceId = String(body.marketplaceId || 'EBAY_US').trim();
    const delayMs = Number(body.delayMs || 100);

    if (categoryIds.length === 0) {
      return jsonResponse(400, { error: 'Missing categoryIds array' }, originHdr, METHODS);
    }

    if (categoryIds.length > 100) {
      return jsonResponse(400, { error: 'Maximum 100 categories per request' }, originHdr, METHODS);
    }

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
    const saved = (await store.get(userScopedKey(sub, 'ebay.json'), { type: 'json' })) as any;
    const refresh = saved?.refresh_token as string | undefined;
    if (!refresh) {
      return jsonResponse(400, { error: 'Connect eBay first' }, originHdr, METHODS);
    }

    const { access_token } = await accessTokenFromRefresh(refresh);
    const ENV = process.env.EBAY_ENV || 'PROD';
    const { apiHost } = tokenHosts(ENV);

    const results = {
      success: [] as any[],
      failed: [] as any[],
      total: categoryIds.length,
    };

    // Process categories sequentially to avoid rate limits
    for (const categoryId of categoryIds) {
      const catId = String(categoryId).trim();
      if (!catId) continue;

      try {
        // Fetch category aspects from eBay Taxonomy API
        const url = `${apiHost}/commerce/taxonomy/v1/category_tree/${categoryTreeId}/get_item_aspects_for_category?category_id=${catId}`;
        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${access_token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
        });

        if (!response.ok) {
          const errorText = await response.text();
          results.failed.push({
            categoryId: catId,
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

          if (hasValues) {
            itemSpecific.enum = aspect.aspectValues!.map((v) => v.localizedValue);
          }

          itemSpecifics.push(itemSpecific);
        }

        // Create slug from category name (fallback to "unknown" if missing)
        const categoryName = data.categoryName || `category-${catId}`;
        const slug = categoryName
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '');

        // Create CategoryDef object
        const categoryDef: CategoryDef = {
          id: catId,
          slug: `${slug}-${catId}`,
          title: categoryName,
          marketplaceId,
          itemSpecifics,
          version: 1,
          updatedAt: Date.now(),
        };

        // Store in taxonomy database
        await putCategory(categoryDef);

        results.success.push({
          categoryId: catId,
          categoryName: data.categoryName,
          aspectCount: itemSpecifics.length,
          requiredCount: itemSpecifics.filter((s) => s.required).length,
        });

        // Delay between requests to avoid rate limits
        if (delayMs > 0 && categoryIds.indexOf(categoryId) < categoryIds.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      } catch (e: any) {
        results.failed.push({
          categoryId: catId,
          error: e?.message || String(e),
        });
      }
    }

    return jsonResponse(200, {
      ok: true,
      results,
      summary: {
        total: results.total,
        success: results.success.length,
        failed: results.failed.length,
      },
    }, originHdr, METHODS);
  } catch (e: any) {
    console.error('Error in bulk category fetch:', e);
    return jsonResponse(500, {
      error: 'Failed to fetch categories',
      detail: e?.message || String(e),
    }, originHdr, METHODS);
  }
};
