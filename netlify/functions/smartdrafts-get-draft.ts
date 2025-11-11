import type { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';

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
    
    // Fetch the offer from eBay
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
    
    const offerRes = await fetch(`${baseUrl}/sell/inventory/v1/offer/${offerId}`, {
      headers: {
        'Authorization': `Bearer ${ebayToken}`,
        'Content-Type': 'application/json',
      },
    });
    
    if (!offerRes.ok) {
      const errorText = await offerRes.text();
      console.error('Failed to fetch offer:', errorText);
      return {
        statusCode: offerRes.status,
        headers,
        body: JSON.stringify({ ok: false, error: 'Failed to fetch offer from eBay' }),
      };
    }
    
    const offer = await offerRes.json();
    
    // Build draft-like object from offer data
    const draft = {
      sku: offer.sku,
      title: offer.listing?.title || '',
      description: offer.listing?.description || '',
      price: offer.pricingSummary?.price?.value || 0,
      condition: offer.condition || 'NEW',
      aspects: offer.listing?.aspects || {},
      images: offer.listing?.imageUrls || [],
      categoryId: offer.categoryId || '',
      offerId: offer.offerId,
    };

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
