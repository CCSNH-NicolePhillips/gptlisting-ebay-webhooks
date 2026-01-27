import type { Handler } from '@netlify/functions';
import { tokensStore } from '../../src/lib/redis-store.js';
import { accessTokenFromRefresh, tokenHosts, resolveEbayEnv } from '../../src/lib/_common.js';
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

    const scopes = [
      'https://api.ebay.com/oauth/api_scope',
      'https://api.ebay.com/oauth/api_scope/sell.account',
    ];
    const { access_token } = await accessTokenFromRefresh(refresh, scopes);
  const ENV = resolveEbayEnv(process.env.EBAY_ENV);
    const { apiHost } = tokenHosts(process.env.EBAY_ENV);
    const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || process.env.DEFAULT_MARKETPLACE_ID || 'EBAY_US';

    const url = `${apiHost}/sell/account/v1/fulfillment_policy?marketplace_id=${encodeURIComponent(MARKETPLACE_ID)}`;
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
    const count = (Array.isArray(json?.fulfillmentPolicies) ? json.fulfillmentPolicies.length : (Number(json?.total) || 0)) as number;
    const samplePolicy = Array.isArray(json?.fulfillmentPolicies) ? json.fulfillmentPolicies[0] : null;
    const www = r.headers.get('www-authenticate') || '';
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ env: ENV, apiHost, marketplaceId: MARKETPLACE_ID, ok: r.ok, status: r.status, count, samplePolicy, wwwAuthenticate: www }),
    };
  } catch (e: any) {
    return { statusCode: 500, body: JSON.stringify({ error: e?.message || 'diag-whoami failed' }) };
  }
};
