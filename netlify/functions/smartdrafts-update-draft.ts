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
    
    // Update the inventory item first (title, description, aspects, images, weight)
    const inventoryPayload: Record<string, unknown> = {
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
    
    // Add weight if provided
    if (draft.weight?.value && draft.weight.value > 0) {
      inventoryPayload.packageWeightAndSize = {
        weight: {
          value: draft.weight.value,
          unit: draft.weight.unit || 'OUNCE',
        },
      };
      console.log(`Setting weight: ${draft.weight.value} ${draft.weight.unit || 'OUNCE'}`);
    }
    
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
    
    // Update the offer (price, promotion settings, and best offer)
    const offerPayload: Record<string, unknown> = {
      ...currentOffer,
      pricingSummary: {
        price: {
          value: draft.price.toString(),
          currency: currentOffer.pricingSummary?.price?.currency || 'USD',
        },
      },
      // Update merchantData with promotion settings if provided
      merchantData: {
        ...(currentOffer.merchantData || {}),
        autoPromote: draft.promotion?.enabled || false,
        autoPromoteAdRate: draft.promotion?.enabled && draft.promotion?.rate 
          ? draft.promotion.rate 
          : null,
      },
    };

    // Add Best Offer settings if provided
    if (draft.bestOffer !== undefined) {
      const existingPolicies = (currentOffer.listingPolicies || {}) as Record<string, unknown>;
      if (draft.bestOffer?.enabled) {
        const price = parseFloat(draft.price);
        const bestOfferTerms: Record<string, unknown> = {
          bestOfferEnabled: true,
        };
        
        // Calculate auto-decline price
        if (draft.bestOffer.autoDeclinePercent) {
          const autoDeclinePrice = (price * draft.bestOffer.autoDeclinePercent / 100);
          bestOfferTerms.autoDeclinePrice = {
            currency: 'USD',
            value: autoDeclinePrice.toFixed(2),
          };
        }
        
        // Calculate auto-accept price
        if (draft.bestOffer.autoAcceptPercent) {
          const autoAcceptPrice = (price * draft.bestOffer.autoAcceptPercent / 100);
          bestOfferTerms.autoAcceptPrice = {
            currency: 'USD',
            value: autoAcceptPrice.toFixed(2),
          };
        }
        
        offerPayload.listingPolicies = {
          ...existingPolicies,
          bestOfferTerms,
        };
        console.log(`[smartdrafts-update-draft] Best Offer enabled for offer ${offerId}:`, bestOfferTerms);
      } else {
        // Explicitly disable Best Offer
        offerPayload.listingPolicies = {
          ...existingPolicies,
          bestOfferTerms: { bestOfferEnabled: false },
        };
        console.log(`[smartdrafts-update-draft] Best Offer disabled for offer ${offerId}`);
      }
    }
    
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
