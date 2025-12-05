import type { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified } from '../../src/lib/_auth.js';
import { promoteSkusForUser } from '../../src/lib/ebay-promote.js';

/**
 * POST /.netlify/functions/promote-drafts
 * 
 * Promotes multiple SKUs (inventory references) to eBay Promoted Listings
 * for the logged-in user.
 * 
 * Body: { skus: string[], adRate?: number }
 * 
 * Returns: { ok: true, campaignId: string, promotedCount: number, results: [...] }
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
    // Parse request body
    const body = JSON.parse(event.body || '{}');
    const { skus, adRate } = body;

    // Validate skus array
    if (!skus || !Array.isArray(skus) || skus.length === 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ 
          ok: false, 
          error: 'skus array is required and must not be empty' 
        }),
      };
    }

    // Validate adRate if provided
    if (adRate !== undefined && (typeof adRate !== 'number' || adRate < 1 || adRate > 20)) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ 
          ok: false, 
          error: 'adRate must be a number between 1 and 20' 
        }),
      };
    }

    // Get authenticated user
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

    console.log(`[promote-drafts] User ${sub} promoting ${skus.length} SKUs at ${adRate || 'default'}% ad rate`);

    // Call the promotion helper
    const result = await promoteSkusForUser(
      sub,
      skus,
      adRate || 5, // Default to 5% if not provided
      {} // No token cache for now
    );

    // Count successes and failures
    const successful = result.results.filter(r => r.status.enabled);
    const failed = result.results.filter(r => !r.status.enabled);

    console.log(`[promote-drafts] Promoted ${successful.length}/${skus.length} SKUs successfully`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        campaignId: result.campaignId,
        promotedCount: successful.length,
        totalCount: skus.length,
        failures: failed.map(f => ({
          sku: f.sku,
          reason: 'Promotion failed - check logs for details',
        })),
        results: result.results,
      }),
    };

  } catch (error: any) {
    console.error('[promote-drafts] Error promoting listings:', error);
    
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        ok: false, 
        error: 'Failed to promote listings',
        details: error.message || String(error),
      }),
    };
  }
};

export { handler };
