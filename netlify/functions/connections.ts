import type { Handler } from '@netlify/functions';
import { requireAuth, getBearerToken, getJwtSubUnverified, requireAuthVerified, userScopedKey } from '../../src/lib/_auth.js';
import { tokensStore } from '../../src/lib/_blobs.js';
import { tokenHosts, accessTokenFromRefresh } from '../../src/lib/_common.js';

function json(status: number, body: any) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function dropboxAccessToken(refresh: string) {
  const clientId = process.env.DROPBOX_CLIENT_ID!;
  const clientSecret = process.env.DROPBOX_CLIENT_SECRET!;
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh });
  const r = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!r.ok) throw new Error(`dropbox refresh failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
  return j.access_token as string;
}

export const handler: Handler = async (event) => {
  try {
    const auth = await requireAuth(event);
    if (!auth?.sub) return json(401, { ok: false, error: 'Unauthorized' });

    const store = tokensStore();
    // eBay connection info
    let ebay: any = { connected: false };
    try {
      const saved = (await store.get(userScopedKey(auth.sub, 'ebay.json'), { type: 'json' })) as any;
      const refresh = saved?.refresh_token as string | undefined;
      if (refresh) {
        const { apiHost } = tokenHosts(process.env.EBAY_ENV);
        const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';
        const { access_token } = await accessTokenFromRefresh(refresh, [
          'https://api.ebay.com/oauth/api_scope',
          'https://api.ebay.com/oauth/api_scope/sell.account',
        ]);
        // Light probe: list payment policies to verify token works
        const url = `${apiHost}/sell/account/v1/payment_policy?marketplace_id=${MARKETPLACE_ID}`;
        const r = await fetch(url, {
          headers: {
            Authorization: `Bearer ${access_token}`,
            Accept: 'application/json',
            'Accept-Language': 'en-US',
            'Content-Language': 'en-US',
            'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID,
          },
        });
        let count = 0; try { const jj = await r.json(); count = Array.isArray(jj?.paymentPolicies) ? jj.paymentPolicies.length : 0; } catch {}
        ebay = { connected: true, apiHost, marketplaceId: MARKETPLACE_ID, ok: r.ok, policyCount: count };
      }
    } catch (e: any) {
      ebay = { connected: false, error: e?.message || String(e) };
    }

    // Dropbox connection info
    let dropbox: any = { connected: false };
    try {
      const saved = (await store.get(userScopedKey(auth.sub, 'dropbox.json'), { type: 'json' })) as any;
      const refresh = saved?.refresh_token as string | undefined;
      if (refresh) {
        const access = await dropboxAccessToken(refresh);
        const r = await fetch('https://api.dropboxapi.com/2/users/get_current_account', {
          method: 'POST',
          headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
        });
        const jj = await r.json().catch(() => ({}));
        dropbox = {
          connected: true,
          ok: r.ok,
          accountId: jj?.account_id || null,
          email: jj?.email || jj?.email_verified || null,
          name: jj?.name?.display_name || null,
        };
      }
    } catch (e: any) {
      dropbox = { connected: false, error: e?.message || String(e) };
    }

    return json(200, {
      ok: true,
      user: { sub: auth.sub, email: auth.email || null, name: auth.name || null },
      ebay,
      dropbox,
    });
  } catch (e: any) {
    return json(500, { ok: false, error: e?.message || String(e) });
  }
};
