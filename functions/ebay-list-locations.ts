import type { Handler } from '@netlify/functions';
import { accessTokenFromRefresh, tokenHosts } from './_common.js';
import { tokensStore } from './_blobs.js';

export const handler: Handler = async () => {
  try {
    // Prefer stored user token; fallback to env for diagnostics
    const store = tokensStore();
    const saved = (await store.get('ebay.json', { type: 'json' })) as any;
    const refresh =
      (saved?.refresh_token as string | undefined) ||
      (process.env.EBAY_TEST_REFRESH_TOKEN as string | undefined);
    if (!refresh)
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'missing-refresh-token',
          hint: 'Connect eBay or set EBAY_TEST_REFRESH_TOKEN',
        }),
      };

    const { access_token } = await accessTokenFromRefresh(refresh);
    const { apiHost } = tokenHosts(process.env.EBAY_ENV);
    const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';

    const url = `${apiHost}/sell/inventory/v1/location?limit=200`;
    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${access_token}`,
        Accept: 'application/json',
        'Accept-Language': 'en-US',
        'Content-Language': 'en-US',
        'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID,
      },
    });

    const text = await r.text();
    return { statusCode: r.status, headers: { 'Content-Type': 'application/json' }, body: text };
  } catch (e: any) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'list-locations error', detail: e?.message || String(e) }),
    };
  }
};
