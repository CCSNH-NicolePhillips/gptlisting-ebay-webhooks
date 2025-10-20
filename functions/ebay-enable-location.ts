import type { Handler } from '@netlify/functions';
import { accessTokenFromRefresh, tokenHosts } from './_common.js';
import { tokensStore } from './_blobs.js';

export const handler: Handler = async (event) => {
  try {
    const store = tokensStore();
    const saved = (await store.get('ebay.json', { type: 'json' })) as any;
    const refresh = saved?.refresh_token as string | undefined;
    if (!refresh)
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Connect eBay first' }),
      };
    const { access_token } = await accessTokenFromRefresh(refresh);
    const { apiHost } = tokenHosts(process.env.EBAY_ENV);

    const qs = (event?.queryStringParameters || {}) as Record<string, string>;
    const key = (qs['key'] || process.env.EBAY_MERCHANT_LOCATION_KEY || 'default-loc').toString();

    const url = `${apiHost}/sell/inventory/v1/location/${encodeURIComponent(key)}/enable`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const text = await r.text();
    return { statusCode: r.status, headers: { 'Content-Type': 'application/json' }, body: text };
  } catch (e: any) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'enable-location error', detail: e?.message || String(e) }),
    };
  }
};
