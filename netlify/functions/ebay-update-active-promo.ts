import type { Handler } from '@netlify/functions';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified, userScopedKey } from '../../src/lib/_auth.js';
import { tokensStore } from '../../src/lib/_blobs.js';
import { getCampaigns, getAds, createAds, updateAdRate, createCampaign } from '../../src/lib/ebay-promote.js';

function normalizeRate(input: any): number | null {
  const num = typeof input === 'number' ? input : parseFloat(input);
  if (!Number.isFinite(num)) return null;
  const clamped = Math.max(0.1, Math.min(num, 100));
  return Math.round(clamped * 10) / 10;
}

export const handler: Handler = async (event) => {
  console.log('[ebay-update-active-promo] Request received');
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    const bearer = getBearerToken(event);
    let sub = (await requireAuthVerified(event))?.sub || null;
    if (!sub) sub = getJwtSubUnverified(event);
    if (!bearer || !sub) return { statusCode: 401, body: 'Unauthorized' };

    const body = event.body ? JSON.parse(event.body) : {};
    const { listingId, offerId, sku, adRate, campaignId: userCampaignId } = body;
    console.log('[ebay-update-active-promo] Input:', { listingId, offerId, sku, adRate, campaignId: userCampaignId });
    const normalizedRate = normalizeRate(adRate);

    if (!listingId && !offerId && !sku) {
      return { statusCode: 400, body: JSON.stringify({ error: 'missing listingId/offerId/sku' }) };
    }
    if (normalizedRate === null) {
      return { statusCode: 400, body: JSON.stringify({ error: 'invalid adRate' }) };
    }

    // Ensure user has a connected eBay refresh token
    const store = tokensStore();
    const saved = (await store.get(userScopedKey(sub!, 'ebay.json'), { type: 'json' })) as any;
    const refresh = saved?.refresh_token as string | undefined;
    if (!refresh) return { statusCode: 400, body: JSON.stringify({ error: 'Connect eBay first' }) };

    // Resolve campaign: use explicit campaignId if provided, otherwise use policy defaults or first RUNNING
    let campaignId: string | null = userCampaignId || null;
    
    if (!campaignId) {
      try {
        const policyDefaultsKey = userScopedKey(sub!, 'policy-defaults.json');
        const policyDefaults: any = (await store.get(policyDefaultsKey, { type: 'json' })) || {};
        campaignId = policyDefaults.promoCampaignId || null;
      } catch {
        // ignore
      }
    }

    if (!campaignId) {
      console.log('[ebay-update-active-promo] No campaign in policy defaults, searching for RUNNING campaign');
      const { campaigns } = await getCampaigns(sub!, { limit: 50 });
      console.log('[ebay-update-active-promo] Found campaigns:', campaigns.length);
      const running = campaigns.find((c) => c.campaignStatus === 'RUNNING');
      if (running) campaignId = running.campaignId;
    }

    if (!campaignId) {
      console.log('[ebay-update-active-promo] No active campaign found, creating new one');
      const now = new Date();
      const campaignName = `DraftPilot Auto ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      
      const newCampaign = await createCampaign(sub!, {
        campaignName,
        marketplaceId: 'EBAY_US',
        fundingStrategy: {
          fundingModel: 'COST_PER_SALE'
        },
        startDate: now.toISOString(),
        campaignStatus: 'RUNNING'
      });
      
      campaignId = newCampaign.campaignId;
      console.log('[ebay-update-active-promo] Created new campaign:', { campaignId, campaignName });
    }

    console.log('[ebay-update-active-promo] Using campaign:', campaignId);
    
    // Fetch ads in the campaign and find a match by listingId or inventory reference
    let { ads } = await getAds(sub!, campaignId, { limit: 500 });
    console.log('[ebay-update-active-promo] Fetched ads in primary campaign:', ads.length);
    
    // Debug: log first few ads to see what we're working with
    if (ads.length > 0) {
      console.log('[ebay-update-active-promo] Sample ad structure:', JSON.stringify(ads[0]));
    }
    
    // Log all listing IDs to see if our target is in there
    if (listingId) {
      const adListingIds = (ads as any[]).map(ad => ad.listingId).filter(Boolean);
      console.log('[ebay-update-active-promo] All ad listingIds in primary campaign:', adListingIds);
      console.log('[ebay-update-active-promo] Looking for listingId:', listingId);
    }
    
    let match = (ads as any[]).find((ad: any) => {
      // eBay API returns listingId directly in the ad response
      const adListingId = String((ad as any).listingId || '').trim();
      const inv = String(ad.inventoryReferenceId || '').trim();
      return (
        (listingId && adListingId && adListingId === String(listingId)) ||
        (listingId && inv && inv === String(listingId)) ||
        (offerId && inv && inv === String(offerId)) ||
        (sku && inv && inv === String(sku))
      );
    });

    // If not found in primary campaign, search ALL campaigns
    if (!match && listingId) {
      console.log('[ebay-update-active-promo] Ad not found in primary campaign, searching all campaigns...');
      const { campaigns } = await getCampaigns(sub!, { limit: 50 });
      console.log('[ebay-update-active-promo] Total campaigns to search:', campaigns.length);
      
      for (const camp of campaigns) {
        if (camp.campaignId === campaignId) continue; // Already searched
        
        const { ads: campAds } = await getAds(sub!, camp.campaignId, { limit: 500 });
        const foundInCamp = (campAds as any[]).find((ad: any) => {
          const adListingId = String((ad as any).listingId || '').trim();
          return adListingId === String(listingId);
        });
        
        if (foundInCamp) {
          console.log('[ebay-update-active-promo] Found ad in different campaign:', {
            campaignId: camp.campaignId,
            campaignName: camp.campaignName,
            adId: foundInCamp.adId
          });
          match = foundInCamp;
          campaignId = camp.campaignId; // Update to use the correct campaign
          break;
        }
      }
    }

    // adId is standard; fall back to any loose id property if returned by API
    const matchAny = match as any;
    let adId = matchAny?.adId || matchAny?.id || null;
    let action: 'updated' | 'created' = 'updated';

    if (adId) {
      console.log('[ebay-update-active-promo] Found existing ad:', { adId, inventoryReferenceId: matchAny?.inventoryReferenceId });
      console.log('[ebay-update-active-promo] Calling updateAdRate with:', { campaignId, adId, rate: normalizedRate });
      await updateAdRate(sub!, campaignId, adId, normalizedRate);
    } else {
      // Create a new ad using listingId
      console.log('[ebay-update-active-promo] Creating new ad for listing:', { listingId, offerId, sku });
      if (!listingId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'listingId required to create promotion' }) };
      }
      
      // eBay Marketing API expects BOTH listingId and bidPercentage
      // DO NOT use inventoryReferenceId/inventoryReferenceType for single ad creation
      const createPayload = {
        listingId: String(listingId),
        bidPercentage: String(normalizedRate),
      };
      
      console.log('[ebay-update-active-promo] Create payload:', JSON.stringify(createPayload));
      try {
        const created = await createAds(sub!, campaignId, createPayload);
        console.log('[ebay-update-active-promo] Create result:', JSON.stringify(created));
        const firstAd: any = (created as any).ads?.[0];
        adId = firstAd?.adId || firstAd?.id || null;
        action = 'created';
      } catch (createError: any) {
        // Check if it's error 35048 (listing invalid/ended)
        if (createError.message?.includes('35048') || createError.message?.includes('invalid or has ended')) {
          console.error('[ebay-update-active-promo] Listing not eligible for promotion:', listingId);
          return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              error: 'This listing cannot be promoted. It may have ended, be ineligible, or eBay\'s systems may need time to sync. Try again in a few minutes or promote it directly on eBay.',
              ebayError: createError.message 
            }),
          };
        }
        // Re-throw other errors
        throw createError;
      }
    }

    console.log('[ebay-update-active-promo] Success:', { action, campaignId, adId, rate: normalizedRate });
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, campaignId, adId, adRate: normalizedRate, action }),
    };
  } catch (e: any) {
    console.error('[ebay-update-active-promo] Error:', e);
    console.error('[ebay-update-active-promo] Stack:', e?.stack);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to update promotion', detail: e?.message || String(e) }),
    };
  }
};
