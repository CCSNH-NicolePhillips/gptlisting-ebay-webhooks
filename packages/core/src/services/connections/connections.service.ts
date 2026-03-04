/**
 * packages/core/src/services/connections/connections.service.ts
 *
 * Probe eBay + Dropbox connections for a user and return their status.
 * Route: GET /api/connections
 */

import { tokensStore } from '../../../../../src/lib/redis-store.js';
import { userScopedKey } from '../../../../../src/lib/_auth.js';
import { accessTokenFromRefresh, tokenHosts } from '../../../../../src/lib/_common.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EbayConnectionStatus {
  connected: boolean;
  ok?: boolean;
  apiHost?: string;
  marketplaceId?: string;
  policies?: Array<{ id: string; name: string }>;
  policyCount?: number;
  locations?: Array<{ key: string; name: string }>;
  locationCount?: number;
  error?: string;
}

export interface DropboxConnectionStatus {
  connected: boolean;
  ok?: boolean;
  accountId?: string | null;
  email?: string | null;
  name?: string | null;
  error?: string;
}

export interface UserConnections {
  ok: boolean;
  ebay: EbayConnectionStatus;
  dropbox: DropboxConnectionStatus;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function refreshDropboxToken(refreshToken: string): Promise<string> {
  const clientId = process.env.DROPBOX_CLIENT_ID!;
  const clientSecret = process.env.DROPBOX_CLIENT_SECRET!;
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
  const r = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!r.ok) throw new Error(`Dropbox refresh failed: ${r.status}`);
  const j = (await r.json()) as any;
  return j.access_token as string;
}

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * Return eBay + Dropbox connection status for the given userId.
 * Probes both APIs with a lightweight request; errors are captured per-service.
 */
export async function getUserConnections(userId: string): Promise<UserConnections> {
  const store = tokensStore();
  const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';

  // ── eBay ──────────────────────────────────────────────────────────────────
  let ebay: EbayConnectionStatus = { connected: false };
  try {
    const saved = (await store.get(userScopedKey(userId, 'ebay.json'), { type: 'json' })) as any;
    const refresh = saved?.refresh_token as string | undefined;
    if (refresh) {
      const { apiHost } = tokenHosts(process.env.EBAY_ENV);
      const { access_token } = await accessTokenFromRefresh(refresh, [
        'https://api.ebay.com/oauth/api_scope',
        'https://api.ebay.com/oauth/api_scope/sell.account',
        'https://api.ebay.com/oauth/api_scope/sell.inventory',
        'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
        'https://api.ebay.com/oauth/api_scope/sell.marketing',
      ]);
      const ebayHeaders = {
        Authorization: `Bearer ${access_token}`,
        Accept: 'application/json',
        'Accept-Language': 'en-US',
        'Content-Language': 'en-US',
        'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID,
      };

      const [polRes, locRes] = await Promise.all([
        fetch(`${apiHost}/sell/account/v1/payment_policy?marketplace_id=${MARKETPLACE_ID}`, { headers: ebayHeaders }),
        fetch(`${apiHost}/sell/inventory/v1/location?limit=200`, { headers: ebayHeaders }),
      ]);

      let policies: Array<{ id: string; name: string }> = [];
      try {
        const jj = (await polRes.json()) as any;
        const arr = Array.isArray(jj?.paymentPolicies) ? jj.paymentPolicies : [];
        policies = arr.map((p: any) => ({ id: String(p?.paymentPolicyId || ''), name: String(p?.name || '') }));
      } catch {}

      let locations: Array<{ key: string; name: string }> = [];
      try {
        const jj = (await locRes.json()) as any;
        const list = Array.isArray(jj?.locations) ? jj.locations
          : Array.isArray(jj?.locationResponses) ? jj.locationResponses : [];
        locations = list.map((l: any) => ({ key: String(l?.merchantLocationKey || ''), name: String(l?.name || '') }));
      } catch {}

      ebay = {
        connected: true,
        ok: polRes.ok && locRes.ok,
        apiHost,
        marketplaceId: MARKETPLACE_ID,
        policies,
        policyCount: policies.length,
        locations,
        locationCount: locations.length,
      };
    }
  } catch (e: any) {
    ebay = { connected: false, error: e?.message || String(e) };
  }

  // ── Dropbox ───────────────────────────────────────────────────────────────
  let dropbox: DropboxConnectionStatus = { connected: false };
  try {
    const saved = (await store.get(userScopedKey(userId, 'dropbox.json'), { type: 'json' })) as any;
    const refresh = saved?.refresh_token as string | undefined;
    if (refresh) {
      const access = await refreshDropboxToken(refresh);
      const r = await fetch('https://api.dropboxapi.com/2/users/get_current_account', {
        method: 'POST',
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
      });
      const jj = (await r.json().catch(() => ({}))) as any;
      dropbox = {
        connected: true,
        ok: r.ok,
        accountId: jj?.account_id || null,
        email: jj?.email || null,
        name: jj?.name?.display_name || null,
      };
    }
  } catch (e: any) {
    dropbox = { connected: false, error: e?.message || String(e) };
  }

  return { ok: true, ebay, dropbox };
}
