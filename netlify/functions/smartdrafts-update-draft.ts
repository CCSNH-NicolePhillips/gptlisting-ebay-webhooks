import type { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { accessTokenFromRefresh, tokenHosts } from '../../src/lib/_common.js';
import { tokensStore } from '../../src/lib/_blobs.js';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified, userScopedKey } from '../../src/lib/_auth.js';

/**
 * POST /.netlify/functions/smartdrafts-update-draft
 * 
 * Updates an eBay offer with edited draft data.
 * Body: { offerId, draft: { title, description, price, condition, aspects, ... } }
 */
const handler: Handler = async (event: HandlerEvent, context: HandlerContext) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ ok: false, error: 'Method not allowed' }),
    };
  }

  try {
    const { offerId, draft } = JSON.parse(event.body || '{}');
    
    if (!offerId || !draft) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ ok: false, error: 'Missing offerId or draft' }),
      };
    }

    // Validate draft fields
    if (!draft.title || draft.title.length > 80) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ ok: false, error: 'Title is required and must be ≤ 80 characters' }),
      };
    }

    if (!draft.price || draft.price <= 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ ok: false, error: 'Price must be > 0' }),
      };
    }

    console.log('Updating eBay offer:', offerId);
    
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
    
    // Fetch current offer to get SKU
    const offerRes = await fetch(`${apiHost}/sell/inventory/v1/offer/${offerId}`, {
      headers: ebayHeaders,
    });
    
    if (!offerRes.ok) {
      return {
        statusCode: offerRes.status,
        headers,
        body: JSON.stringify({ ok: false, error: 'Failed to fetch offer from eBay' }),
      };
    }
    
    const currentOffer = await offerRes.json();
    const sku = currentOffer.sku;
    
    // Update the inventory item first (title, description, aspects, images)
    const inventoryPayload = {
      product: {
        title: draft.title,
        description: draft.description,
        aspects: draft.aspects || {},
        imageUrls: draft.images || currentOffer.listing?.imageUrls || [],
      },
      condition: draft.condition || 'NEW',
      availability: currentOffer.availability || {
        shipToLocationAvailability: {
          quantity: 1,
        },
      },
    };
    
    const inventoryRes = await fetch(`${apiHost}/sell/inventory/v1/inventory_item/${sku}`, {
      method: 'PUT',
      headers: ebayHeaders,
      body: JSON.stringify(inventoryPayload),
    });
    
    if (!inventoryRes.ok) {
      const errorText = await inventoryRes.text();
      console.error('Failed to update inventory:', errorText);
      return {
        statusCode: inventoryRes.status,
        headers,
        body: JSON.stringify({ ok: false, error: 'Failed to update inventory item' }),
      };
    }
    
    // Update the offer (price)
    const offerPayload = {
      ...currentOffer,
      pricingSummary: {
        price: {
          value: draft.price.toString(),
          currency: currentOffer.pricingSummary?.price?.currency || 'USD',
        },
      },
    };
    
    const updateOfferRes = await fetch(`${apiHost}/sell/inventory/v1/offer/${offerId}`, {
      method: 'PUT',
      headers: ebayHeaders,
      body: JSON.stringify(offerPayload),
    });
    
    if (!updateOfferRes.ok) {
      const errorText = await updateOfferRes.text();
      console.error('Failed to update offer:', errorText);
      return {
        statusCode: updateOfferRes.status,
        headers,
        body: JSON.stringify({ ok: false, error: 'Failed to update offer' }),
      };
    }

    console.log(`✓ Updated offer: ${offerId}`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true }),
    };
  } catch (error: any) {
    console.error('[smartdrafts-update-draft] Error:', error);
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
