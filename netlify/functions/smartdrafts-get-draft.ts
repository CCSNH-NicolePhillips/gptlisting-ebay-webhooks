import type { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { accessTokenFromRefresh, tokenHosts } from '../../src/lib/_common.js';
import { tokensStore } from '../../src/lib/_blobs.js';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified, userScopedKey } from '../../src/lib/_auth.js';

/**
 * GET /.netlify/functions/smartdrafts-get-draft?offerId=xxx
 * 
 * Fetches offer data from eBay for editing.
 */
const handler: Handler = async (event: HandlerEvent, context: HandlerContext) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ ok: false, error: 'Method not allowed' }),
    };
  }

  try {
    const { offerId } = event.queryStringParameters || {};
    
    if (!offerId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ ok: false, error: 'Missing offerId parameter' }),
      };
    }

    console.log('Fetching offer from eBay:', offerId);
    
    // Get authentication
    const store = tokensStore();
    const bearer = getBearerToken(event);
    let sub = (await requireAuthVerified(event))?.sub || null;
    if (!sub) sub = getJwtSubUnverified(event);
    if (!bearer || !sub) {
      return { 
        statusCode: 401, 
        headers,
        body: JSON.stringify({ ok: false, error: 'Unauthorized' })
      };
    }
    
    const saved = (await store.get(userScopedKey(sub, 'ebay.json'), { type: 'json' })) as any;
    const refresh = saved?.refresh_token as string | undefined;
    if (!refresh) {
      return { 
        statusCode: 400, 
        headers,
        body: JSON.stringify({ ok: false, error: 'Connect eBay first' })
      };
    }
    
    const { access_token } = await accessTokenFromRefresh(refresh);
    const { apiHost } = tokenHosts(process.env.EBAY_ENV);
    const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';
    
    const ebayHeaders = {
      'Authorization': `Bearer ${access_token}`,
      'Accept': 'application/json',
      'Accept-Language': 'en-US',
      'Content-Language': 'en-US',
      'Content-Type': 'application/json',
      'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID,
    };
    
    const offerRes = await fetch(`${apiHost}/sell/inventory/v1/offer/${offerId}`, {
      headers: ebayHeaders,
    });
    
    if (!offerRes.ok) {
      const errorText = await offerRes.text();
      console.error('Failed to fetch offer from eBay:', offerRes.status, errorText);
      return {
        statusCode: offerRes.status,
        headers,
        body: JSON.stringify({ 
          ok: false, 
          error: 'Failed to fetch offer from eBay',
          detail: errorText.substring(0, 500),
          status: offerRes.status
        }),
      };
    }
    
    const offer = await offerRes.json();
    
    console.log('Fetched offer from eBay:', JSON.stringify(offer, null, 2));
    
    // Fetch the inventory item to get product details (title, description, aspects, images)
    const sku = offer.sku;
    const inventoryRes = await fetch(`${apiHost}/sell/inventory/v1/inventory_item/${sku}`, {
      headers: ebayHeaders,
    });
    
    let inventory: any = {};
    if (inventoryRes.ok) {
      inventory = await inventoryRes.json();
      console.log('Fetched inventory from eBay:', JSON.stringify(inventory, null, 2));
    } else {
      console.warn('Failed to fetch inventory item:', await inventoryRes.text());
    }
    
    // Fetch category aspects metadata to show what's available/required
    let categoryAspects: any = null;
    if (offer.categoryId) {
      try {
        const categoryRes = await fetch(
          `${apiHost}/commerce/taxonomy/v1/category_tree/0/get_item_aspects_for_category?category_id=${offer.categoryId}`,
          { headers: ebayHeaders }
        );
        if (categoryRes.ok) {
          categoryAspects = await categoryRes.json();
          console.log('Category aspects metadata:', JSON.stringify(categoryAspects, null, 2));
        }
      } catch (e) {
        console.warn('Failed to fetch category aspects:', e);
      }
    }
    
    // Build draft-like object from offer + inventory data
    // Inventory has product.title, product.description, product.aspects, product.imageUrls
    const draft = {
      sku: offer.sku,
      title: inventory.product?.title || offer.title || '',
      description: inventory.product?.description || offer.listingDescription || '',
      price: offer.pricingSummary?.price?.value || 0,
      condition: inventory.condition || offer.condition || 'NEW',
      aspects: inventory.product?.aspects || {},
      images: inventory.product?.imageUrls || [],
      categoryId: offer.categoryId || '',
      offerId: offer.offerId,
      categoryAspects: categoryAspects?.aspects || [], // Available aspects for this category
    };
    
    // Debug: Check cardinality values
    if (categoryAspects?.aspects) {
      const mainPurpose = categoryAspects.aspects.find((a: any) => a.localizedAspectName === 'Main Purpose');
      console.log('[DEBUG] Main Purpose aspect:', JSON.stringify(mainPurpose, null, 2));
    }
    
    console.log('Mapped draft:', JSON.stringify(draft, null, 2));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ 
        ok: true, 
        draft,
      }),
    };
  } catch (error: any) {
    console.error('[smartdrafts-get-draft] Error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        ok: false,
        error: error.message || 'Internal server error',
      }),
    };
  }
};

export { handler };
