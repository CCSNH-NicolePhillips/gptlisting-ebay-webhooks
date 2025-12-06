import type { Handler } from '@netlify/functions';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified, userScopedKey } from '../../src/lib/_auth.js';
import { getAds, getCampaigns } from '../../src/lib/ebay-promote.js';
import { tokensStore } from '../../src/lib/_blobs.js';

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

    // Get the user's default campaign ID from policy defaults
    let campaignId: string | null = null;
    
    try {
      const store = tokensStore();
      const policyDefaultsKey = userScopedKey(sub, 'policy-defaults.json');
      const policyDefaults: any = (await store.get(policyDefaultsKey, { type: 'json' })) || {};
      campaignId = policyDefaults.promoCampaignId || null;
    } catch (e) {
      console.log('[get-promoted-listings] No policy defaults found');
    }

    // If no campaign in policy defaults, try to get the first RUNNING campaign
    if (!campaignId) {
      try {
        const campaignsResult = await getCampaigns(sub, { tokenCache, limit: 10 });
        const runningCampaign = campaignsResult.campaigns.find(c => c.campaignStatus === 'RUNNING');
        if (runningCampaign) {
          campaignId = runningCampaign.campaignId;
        }
      } catch (err: any) {
        console.error('[get-promoted-listings] Failed to get campaigns:', err.message);
      }
    }

    if (!campaignId) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          ok: true, 
          ads: [],
          error: 'No active campaign found',
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
