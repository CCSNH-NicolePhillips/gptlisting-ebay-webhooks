import type { Handler } from '@netlify/functions';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified, userScopedKey } from '../../src/lib/_auth.js';
import { tokensStore } from '../../src/lib/_blobs.js';
import { getCampaigns, getAds, deleteAd } from '../../src/lib/ebay-promote.js';

export const handler: Handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    const bearer = getBearerToken(event);
    let sub = (await requireAuthVerified(event))?.sub || null;
    if (!sub) sub = getJwtSubUnverified(event);
    if (!bearer || !sub) return { statusCode: 401, body: 'Unauthorized' };

    const body = event.body ? JSON.parse(event.body) : {};
    const { listingId, offerId, sku } = body;

    if (!listingId && !offerId && !sku) {
      return { statusCode: 400, body: JSON.stringify({ error: 'missing listingId/offerId/sku' }) };
    }

    // Ensure user has a connected eBay refresh token
    const store = tokensStore();
    const saved = (await store.get(userScopedKey(sub!, 'ebay.json'), { type: 'json' })) as any;
    const refresh = saved?.refresh_token as string | undefined;
    if (!refresh) return { statusCode: 400, body: JSON.stringify({ error: 'Connect eBay first' }) };

    // Resolve campaign: use policy defaults or first RUNNING
    let campaignId: string | null = null;
    try {
      const policyDefaultsKey = userScopedKey(sub!, 'policy-defaults.json');
      const policyDefaults: any = (await store.get(policyDefaultsKey, { type: 'json' })) || {};
      campaignId = policyDefaults.promoCampaignId || null;
    } catch {
      // ignore
    }

    if (!campaignId) {
      const { campaigns } = await getCampaigns(sub!, { limit: 10 });
      const running = campaigns.find((c) => c.campaignStatus === 'RUNNING');
      if (running) campaignId = running.campaignId;
    }

    if (!campaignId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No active promotion campaign found' }) };
    }

    // Fetch ads in the campaign and find a match by listingId or inventory reference
    const { ads } = await getAds(sub!, campaignId, { limit: 500 });
    const match = (ads as any[]).find((ad: any) => {
      const inv = String(ad.inventoryReferenceId || '').trim();
      const lid = String((ad as any).listingId || '').trim();
      return (
        (listingId && lid && lid === String(listingId)) ||
        (offerId && inv && inv === String(offerId)) ||
        (sku && inv && inv === String(sku))
      );
    });

    if (!match) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Ad not found in campaign' }) };
    }

    // adId is standard; fall back to any loose id property if returned by API
    const matchAny = match as any;
    const adId = matchAny?.adId || matchAny?.id || null;

    if (!adId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Could not determine ad ID' }) };
    }

    // Delete the ad
    await deleteAd(sub!, campaignId, adId);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, adId, campaignId }),
    };
  } catch (e: any) {
    console.error('[ebay-remove-promo] Error:', e?.message || e);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to remove promotion', detail: e?.message || String(e) }),
    };
  }
};
