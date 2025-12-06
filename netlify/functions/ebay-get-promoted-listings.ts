import type { Handler } from '@netlify/functions';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified } from '../../src/lib/_auth.js';
import { getAds } from '../../src/lib/ebay-promote.js';
import { getOrCreateDefaultCampaignId } from '../../src/lib/ebay-promote.js';

/**
 * Get all promoted listings (ads) for the current user
 * This endpoint fetches ads from the user's default promotion campaign
 * Used by the frontend to check which items are already promoted
 */
export const handler: Handler = async (event) => {
  try {
    const bearer = getBearerToken(event);
    let sub = (await requireAuthVerified(event))?.sub || null;
    if (!sub) sub = getJwtSubUnverified(event);
    if (!bearer || !sub) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    // Create a simple token cache for this request
    const tokenCache: any = {
      get: async () => null,
      set: async () => {},
    };

    // Get the user's default campaign ID
    let campaignId: string;
    try {
      const ctx = {
        userId: sub,
        apiHost: process.env.EBAY_ENV === 'PROD' 
          ? 'https://api.ebay.com' 
          : 'https://api.sandbox.ebay.com',
        accessToken: '', // Not needed for getOrCreateDefaultCampaignId
      };
      
      campaignId = await getOrCreateDefaultCampaignId(ctx as any, { adRate: 5 });
    } catch (err: any) {
      console.error('[get-promoted-listings] Failed to get campaign:', err.message);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          ok: true, 
          ads: [],
          error: 'Could not find or create campaign',
        }),
      };
    }

    // Fetch all ads from the campaign
    try {
      const adsResult = await getAds(sub, campaignId, { 
        tokenCache,
        limit: 500, // Get many ads to ensure we check all promoted items
      });

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ok: true,
          campaignId,
          ads: adsResult.ads || [],
          total: adsResult.total || 0,
        }),
      };
    } catch (err: any) {
      console.error('[get-promoted-listings] Failed to get ads:', err.message);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ok: true,
          campaignId,
          ads: [],
          error: err.message,
        }),
      };
    }
  } catch (e: any) {
    console.error('[get-promoted-listings] Error:', e);
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: 'Failed to get promoted listings', 
        detail: e?.message || String(e),
      }),
    };
  }
};
