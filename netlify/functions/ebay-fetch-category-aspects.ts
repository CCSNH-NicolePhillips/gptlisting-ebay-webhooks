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

/**
 * Fetches category aspects from eBay Taxonomy API and stores them in our taxonomy database.
 * 
 * POST /.netlify/functions/ebay-fetch-category-aspects
 * Body: { categoryId: "177011", marketplaceId: "EBAY_US" }
 * 
 * This uses eBay's Commerce Taxonomy API:
 * GET /commerce/taxonomy/v1/category_tree/{category_tree_id}/get_item_aspects_for_category?category_id={category_id}
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

  if (!isAuthorized(headers)) {
    return jsonResponse(401, { error: 'Unauthorized' }, originHdr, METHODS);
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const categoryId = String(body.categoryId || '').trim();
    const marketplaceId = String(body.marketplaceId || 'EBAY_US').trim();

    if (!categoryId) {
      return jsonResponse(400, { error: 'Missing categoryId' }, originHdr, METHODS);
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
    const saved = (await store.get('ebay.json', { type: 'json' })) as any;
    const refresh = saved?.refresh_token as string | undefined;
    if (!refresh) {
      return jsonResponse(400, { error: 'Connect eBay first' }, originHdr, METHODS);
    }

    const { access_token } = await accessTokenFromRefresh(refresh);
    const ENV = process.env.EBAY_ENV || 'PROD';
    const { apiHost } = tokenHosts(ENV);

    // Fetch category aspects from eBay Taxonomy API
    const url = `${apiHost}/commerce/taxonomy/v1/category_tree/${categoryTreeId}/get_item_aspects_for_category?category_id=${categoryId}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${access_token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return jsonResponse(response.status, {
        error: 'eBay API error',
        status: response.status,
        detail: errorText,
      }, originHdr, METHODS);
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

    // Create slug from category name
    const slug = data.categoryName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    // Create CategoryDef object
    const categoryDef: CategoryDef = {
      id: categoryId,
      slug: `${slug}-${categoryId}`,
      title: data.categoryName,
      marketplaceId,
      itemSpecifics,
      version: 1,
      updatedAt: Date.now(),
    };

    // Store in taxonomy database
    await putCategory(categoryDef);

    return jsonResponse(200, {
      ok: true,
      category: categoryDef,
      aspectCount: itemSpecifics.length,
      requiredCount: itemSpecifics.filter((s) => s.required).length,
    }, originHdr, METHODS);
  } catch (e: any) {
    console.error('Error fetching category aspects:', e);
    return jsonResponse(500, {
      error: 'Failed to fetch category aspects',
      detail: e?.message || String(e),
    }, originHdr, METHODS);
  }
};
