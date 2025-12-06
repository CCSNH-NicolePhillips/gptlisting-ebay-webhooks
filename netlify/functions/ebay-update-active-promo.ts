import type { Handler } from '@netlify/functions';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified, userScopedKey } from '../../src/lib/_auth.js';
import { tokensStore } from '../../src/lib/_blobs.js';
import { getCampaigns, getAds, createAds, updateAdRate } from '../../src/lib/ebay-promote.js';

function normalizeRate(input: any): number | null {
  const num = typeof input === 'number' ? input : parseFloat(input);
  if (!Number.isFinite(num)) return null;
  const clamped = Math.max(0.1, Math.min(num, 100));
  return Math.round(clamped * 10) / 10;
}

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
    const { listingId, offerId, sku, adRate } = body;
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

    // adId is standard; fall back to any loose id property if returned by API
    const matchAny = match as any;
    let adId = matchAny?.adId || matchAny?.id || null;
    let action: 'updated' | 'created' = 'updated';

    if (adId) {
      await updateAdRate(sub!, campaignId, adId, normalizedRate);
    } else {
      // Create a new ad using listingId if available
      if (!listingId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'listingId required to create promotion' }) };
      }
      const createPayload = {
        requests: [
          {
            listingId,
            listingType: 'OFFER',
            bidPercentage: normalizedRate,
          },
        ],
      };
      const created = await createAds(sub!, campaignId, createPayload);
      const firstAd: any = (created as any).ads?.[0];
      adId = firstAd?.adId || firstAd?.id || null;
      action = 'created';
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, campaignId, adId, adRate: normalizedRate, action }),
    };
  } catch (e: any) {
    console.error('[ebay-update-active-promo] Error:', e);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to update promotion', detail: e?.message || String(e) }),
    };
  }
};
