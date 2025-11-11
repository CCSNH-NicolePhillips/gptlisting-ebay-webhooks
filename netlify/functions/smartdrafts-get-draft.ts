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
    
    const offerRes = await fetch(`${apiHost}/sell/inventory/v1/offer/${offerId}`, {
      headers: {
        'Authorization': `Bearer ${access_token}`,
        'Content-Type': 'application/json',
      },
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
