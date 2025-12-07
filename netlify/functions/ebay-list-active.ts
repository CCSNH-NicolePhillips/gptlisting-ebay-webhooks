import type { Handler } from '@netlify/functions';
import { accessTokenFromRefresh, tokenHosts } from '../../src/lib/_common.js';
import { tokensStore } from '../../src/lib/_blobs.js';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified, userScopedKey } from '../../src/lib/_auth.js';

interface ActiveOffer {
  offerId: string;
  sku: string;
  title?: string;
  price?: { value: string; currency: string };
  availableQuantity?: number;
  listingId?: string;
  listingStatus?: string;
  marketplaceId?: string;
  condition?: number;
  lastModifiedDate?: string;
  autoPromote?: boolean;
  autoPromoteAdRate?: number;
}

export const handler: Handler = async (event) => {
  console.log('[ebay-list-active] Function invoked');
  try {
    const devBypassEnabled = process.env.DEV_BYPASS_AUTH_FOR_LIST_ACTIVE === 'true';
    const wantBypass =
      devBypassEnabled &&
      ((event.queryStringParameters?.dev || '').toString() === '1' ||
        (event.headers['x-dev-bypass'] || event.headers['X-Dev-Bypass'] || '').toString() === '1');

    let bearer = getBearerToken(event);
    let sub = (await requireAuthVerified(event))?.sub || null;
    if (!sub) sub = getJwtSubUnverified(event);

    if (wantBypass) {
      sub = event.queryStringParameters?.userId || process.env.DEV_USER_ID || 'dev-user';
      bearer = bearer || 'dev-bypass';
    }

    console.log('[ebay-list-active] User ID:', sub, 'Dev bypass:', wantBypass);

    if (!bearer || !sub) {
      return {
        statusCode: 401,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Unauthorized' }),
      };
    }

    // Load refresh token
    const store = tokensStore();
    const saved = (await store.get(userScopedKey(sub, 'ebay.json'), { type: 'json' })) as any;
    const refresh = saved?.refresh_token as string | undefined;
    if (!refresh) return { statusCode: 400, body: JSON.stringify({ error: 'Connect eBay first' }) };

    console.log('[ebay-list-active] Getting eBay access token...');
    const { access_token } = await accessTokenFromRefresh(refresh);
    const { apiHost } = tokenHosts(process.env.EBAY_ENV);
    const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';
    console.log('[ebay-list-active] API Host:', apiHost, 'Marketplace:', MARKETPLACE_ID);

    async function listActiveOffers(): Promise<ActiveOffer[]> {
      const results: ActiveOffer[] = [];
      let offset = 0;
      const limit = 200;
      console.log('[ebay-list-active] Starting to fetch offers...');

      while (true) {
        const params = new URLSearchParams({ 
          limit: String(limit), 
          offset: String(offset)
          // Note: NOT filtering by offer_status here because eBay validates ALL SKUs
          // even in filtered results, and bad SKUs cause the entire request to fail.
          // We'll filter for PUBLISHED status client-side instead.
        });
        const url = `${apiHost}/sell/inventory/v1/offer?${params.toString()}`;
        console.log('[ebay-list-active] Fetching batch at offset', offset, 'URL:', url);
        const res = await fetch(url, {
          headers: {
            Authorization: `Bearer ${access_token}`,
            'Content-Type': 'application/json',
            'Accept-Language': 'en-US',
            'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID,
          },
        });

        const text = await res.text();
        let data: any = {};
        try {
          data = text ? JSON.parse(text) : {};
        } catch {
          throw new Error(`Failed to parse offers response at offset ${offset}`);
        }

        if (!res.ok) {
          const errMsg = data?.errors?.[0]?.message || data?.message || text || 'Unknown error';
          // If it's a validation error, log and continue to next batch
          if (res.status === 400 && errMsg.includes('SKU')) {
            console.warn(`[ebay-list-active] SKU validation error at offset ${offset}, skipping batch:`, errMsg);
            break; // Stop pagination on validation errors
          }
          throw new Error(`Offer list failed ${res.status}: ${errMsg}`);
        }

        const offers = Array.isArray(data.offers) ? data.offers : [];
        console.log('[ebay-list-active] Received', offers.length, 'offers in this batch. Total so far:', results.length);
        
        let publishedCount = 0;
        for (const o of offers) {
          try {
            // Filter for PUBLISHED status only
            const status = o?.status || o?.listing?.status || o?.publication?.status;
            if (status !== 'PUBLISHED') {
              continue; // Skip non-published offers
            }
            publishedCount++;
            
            const adRateRaw = o?.merchantData?.autoPromoteAdRate;
            const adRate = typeof adRateRaw === 'number' ? adRateRaw : parseFloat(adRateRaw);

            results.push({
              offerId: String(o.offerId || ''),
              sku: String(o.sku || ''),
              title: o?.listing?.title || o?.title || o?.sku || '',
              price: o?.pricingSummary?.price,
              availableQuantity: o?.availableQuantity,
              listingId: o?.listing?.listingId || o?.publication?.listingId,
              listingStatus: status,
              marketplaceId: o?.marketplaceId,
              condition: typeof o?.condition === 'number' ? o.condition : undefined,
              lastModifiedDate: o?.listing?.lastModifiedDate || o?.lastModifiedDate,
              autoPromote: o?.merchantData?.autoPromote === true,
              autoPromoteAdRate: Number.isFinite(adRate) ? adRate : undefined,
            });
          } catch (offerErr: any) {
            console.warn(`[ebay-list-active] Error processing offer ${o?.offerId}:`, offerErr?.message);
            // Continue to next offer
          }
        }
        console.log('[ebay-list-active] Found', publishedCount, 'PUBLISHED offers in this batch');

        const next = data?.next;
        if (!next || offers.length < limit) break;
        offset += limit;
      }

      return results;
    }

    const activeOffers = await listActiveOffers();
    console.log('[ebay-list-active] SUCCESS - Found', activeOffers.length, 'total active offers');
    if (activeOffers.length > 0) {
      console.log('[ebay-list-active] Sample offer:', JSON.stringify(activeOffers[0]).substring(0, 200));
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, count: activeOffers.length, offers: activeOffers }),
    };
  } catch (e: any) {
    console.error('[ebay-list-active] Error:', e?.message || e);
    console.error('[ebay-list-active] Stack:', e?.stack);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to list active offers', detail: e?.message || String(e) }),
    };
  }
};
