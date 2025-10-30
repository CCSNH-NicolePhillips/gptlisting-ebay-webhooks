import type { Handler } from '@netlify/functions';
import { tokensStore } from '../src/lib/_blobs.js';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified, userScopedKey } from '../src/lib/_auth.js';
import { accessTokenFromRefresh, tokenHosts } from '../src/lib/_common.js';

function json(body: unknown, status = 200) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}

async function dropboxAccessToken(refreshToken: string) {
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: process.env.DROPBOX_CLIENT_ID || '',
    client_secret: process.env.DROPBOX_CLIENT_SECRET || '',
  });
  const r = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`dbx token: ${r.status} ${JSON.stringify(j)}`);
  return j.access_token as string;
}

export const handler: Handler = async (event) => {
  try {
    const bearer = getBearerToken(event);
    let sub = (await requireAuthVerified(event))?.sub || null;
    if (!sub) sub = getJwtSubUnverified(event);
    if (!bearer || !sub) return json({ ok: false, error: 'unauthorized' }, 401);

    const store = tokensStore();
    const [dbxSaved, ebaySaved] = await Promise.all([
      store.get(userScopedKey(sub, 'dropbox.json'), { type: 'json' }) as Promise<any>,
      store.get(userScopedKey(sub, 'ebay.json'), { type: 'json' }) as Promise<any>,
    ]);

    // Base user info from Auth0 claims
    const meRes = await requireAuthVerified(event).catch(() => null);
    const user = meRes ? { sub: meRes.sub, name: meRes.claims?.name, email: meRes.claims?.email } : null;

    // Dropbox account info (best effort)
    let dropbox: any = { connected: !!dbxSaved?.refresh_token };
    if (dbxSaved?.refresh_token) {
      try {
        const access = await dropboxAccessToken(dbxSaved.refresh_token as string);
        const r = await fetch('https://api.dropboxapi.com/2/users/get_current_account', {
          method: 'POST',
          headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
        });
        const acct: any = await r.json().catch(() => ({}));
        if (r.ok) dropbox.account = acct;
      } catch {}
    }

    // eBay info (best effort)
    let ebay: any = { connected: !!ebaySaved?.refresh_token };
    if (ebaySaved?.refresh_token) {
      const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';
      const { apiHost } = tokenHosts(process.env.EBAY_ENV);
      ebay.marketplaceId = MARKETPLACE_ID;
      ebay.apiHost = apiHost;
      try {
        // Try to mint an access token including commerce.identity.readonly for username lookup
        const scopes = [
          'https://api.ebay.com/oauth/api_scope',
          'https://api.ebay.com/oauth/api_scope/sell.account',
          // Optional: identity username (may not be enabled for all apps)
          'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
        ];
        const { access_token } = await accessTokenFromRefresh(ebaySaved.refresh_token as string, scopes);
        const headers = {
          Authorization: `Bearer ${access_token}`,
          Accept: 'application/json',
          'Content-Language': 'en-US',
          'Accept-Language': 'en-US',
          'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID,
        } as Record<string, string>;
        // Identity endpoint for username (ignore failures gracefully)
        try {
          const ur = await fetch(`${apiHost}/commerce/identity/v1/user/`, { headers });
          const ujTxt = await ur.text();
          let uj: any; try { uj = JSON.parse(ujTxt); } catch { uj = ujTxt; }
          if (ur.ok && uj) {
            // Common shapes: {username, userId} or {userId, email} depending on program
            ebay.username = uj.username || uj.userId || null;
            ebay.userId = uj.userId || null;
            ebay.identity = uj;
          }
        } catch {}
        // Privilege check to include sellerRegistrationCompleted, helpful context
        try {
          const pr = await fetch(`${apiHost}/sell/account/v1/privilege`, { headers });
          const pjTxt = await pr.text();
          let pj: any; try { pj = JSON.parse(pjTxt); } catch { pj = pjTxt; }
          if (pr.ok && pj) ebay.privilege = pj;
        } catch {}
      } catch {}
    }

    return json({ ok: true, user, dropbox, ebay });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || String(e) }, 500);
  }
};
