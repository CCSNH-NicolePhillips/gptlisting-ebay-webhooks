import type { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';

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
    
    // Get eBay token
    const ebayToken = process.env.EBAY_ACCESS_TOKEN;
    if (!ebayToken) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ ok: false, error: 'eBay token not configured' }),
      };
    }
    
    const ebayEnv = process.env.EBAY_ENV || 'production';
    const baseUrl = ebayEnv === 'sandbox' 
      ? 'https://api.sandbox.ebay.com'
      : 'https://api.ebay.com';
    
    // Fetch current offer to get SKU
    const offerRes = await fetch(`${baseUrl}/sell/inventory/v1/offer/${offerId}`, {
      headers: {
        'Authorization': `Bearer ${ebayToken}`,
        'Content-Type': 'application/json',
      },
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
    
    const inventoryRes = await fetch(`${baseUrl}/sell/inventory/v1/inventory_item/${sku}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${ebayToken}`,
        'Content-Type': 'application/json',
      },
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
    
    const updateOfferRes = await fetch(`${baseUrl}/sell/inventory/v1/offer/${offerId}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${ebayToken}`,
        'Content-Type': 'application/json',
      },
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
