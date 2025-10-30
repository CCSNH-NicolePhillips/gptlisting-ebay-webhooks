import type { Handler } from '@netlify/functions';
import { tokensStore } from '../../src/lib/_blobs.js';
import { accessTokenFromRefresh, tokenHosts } from '../../src/lib/_common.js';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified, userScopedKey } from '../../src/lib/_auth.js';

export const handler: Handler = async (event) => {
  try {
    const store = tokensStore();
    const bearer = getBearerToken(event);
    let sub = (await requireAuthVerified(event))?.sub || null;
    if (!sub) sub = getJwtSubUnverified(event);
    if (!bearer || !sub) return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized' }) };
    const saved = (await store.get(userScopedKey(sub, 'ebay.json'), { type: 'json' })) as any;
    const refresh = saved?.refresh_token as string | undefined;
    if (!refresh) return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Connect eBay first' }) };

    const { access_token } = await accessTokenFromRefresh(refresh);
    const { apiHost } = tokenHosts(process.env.EBAY_ENV);
    const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || process.env.DEFAULT_MARKETPLACE_ID || 'EBAY_US';

    const url = `${apiHost}/sell/inventory/v1/offer?limit=20`;
    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${access_token}`,
        Accept: 'application/json',
        'Content-Language': 'en-US',
        'Accept-Language': 'en-US',
        'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID,
      },
    });
    const txt = await r.text();
    let json: any; try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
    const offers = Array.isArray(json?.offers) ? json.offers : [];
    const mapped = offers.map((o: any) => ({
      offerId: o?.offerId,
      sku: o?.sku,
      status: o?.status,
      marketplaceId: o?.marketplaceId,
      modified: o?.lastModifiedDate || o?.lastModifiedTime,
    }));
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ env: String(process.env.EBAY_ENV || 'production').toLowerCase(), offers: mapped }),
    };
  } catch (e: any) {
    return { statusCode: 500, body: JSON.stringify({ error: e?.message || 'diag-offers failed' }) };
  }
};
