/**
 * ebay-oauth.service.ts — eBay OAuth 2.0 flow helpers for Express.
 *
 * Implements:
 *   startEbayOAuth(sub, returnTo)  → build authorization URL + persist state
 *   callbackEbayOAuth(code, state) → validate state, exchange code, save tokens
 *
 * State is stored in Redis under oauth-state/{nonce}.json using the same key
 * scheme as the legacy Netlify `_auth.ts` helpers so the two can coexist
 * during the migration window.
 */

import { tokensStore } from '../../../../../src/lib/redis-store.js';
import { consumeOAuthState } from '../../../../../src/lib/_auth.js';
import type { OAuthStateRecord } from '../../../../../src/lib/_auth.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const STATE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

const EBAY_SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.account',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
  'https://api.ebay.com/oauth/api_scope/sell.marketing',
  'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
].join(' ');

// ── Shared helpers ─────────────────────────────────────────────────────────────

export function sanitizeReturnTo(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let candidate = value.trim();
  if (!candidate) return null;
  if (candidate === 'popup') return 'popup';
  if (/^https?:\/\//i.test(candidate)) {
    try {
      const url = new URL(candidate);
      candidate = `${url.pathname || '/'}`;
      if (url.search) candidate += url.search;
      if (url.hash) candidate += url.hash;
    } catch {
      return null;
    }
  }
  if (!candidate.startsWith('/')) return null;
  return candidate;
}

/** Generate a cryptographically random nonce and persist state in Redis. */
async function createState(sub: string, provider: string, returnTo: string | null): Promise<string> {
  const nonce =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

  const record: OAuthStateRecord = {
    sub,
    provider,
    createdAt: Date.now(),
    ...(returnTo != null ? { returnTo } : {}),
  };

  const store = tokensStore();
  await store.setJSON(`oauth-state/${nonce}.json`, record);
  return nonce;
}

// ── eBay OAuth start ──────────────────────────────────────────────────────────

export interface EbayOAuthStartResult {
  redirectUrl: string;
  state: string;
}

/**
 * Generate the eBay authorization URL for a given authenticated user.
 *
 * @param sub      Auth0 sub of the authenticated user.
 * @param returnTo Sanitized return-to path or 'popup'; null = default.
 */
export async function startEbayOAuth(
  sub: string,
  returnTo: string | null,
): Promise<EbayOAuthStartResult> {
  const clientId = process.env.EBAY_CLIENT_ID;
  const runame = process.env.EBAY_RUNAME || process.env.EBAY_RU_NAME;
  if (!clientId) throw new EbayOAuthConfigError('Missing EBAY_CLIENT_ID');
  if (!runame) throw new EbayOAuthConfigError('Missing EBAY_RUNAME/EBAY_RU_NAME');

  const env = process.env.EBAY_ENV || 'PROD';
  const host =
    env === 'SANDBOX' ? 'https://auth.sandbox.ebay.com' : 'https://auth.ebay.com';

  const nonce = await createState(sub, 'ebay', returnTo);
  const state = encodeURIComponent(nonce);

  let url =
    `${host}/oauth2/authorize?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(runame)}` +
    `&response_type=code&state=${state}&scope=${encodeURIComponent(EBAY_SCOPES)}`;

  // Force fresh login for popup reconnect flows.
  if (returnTo === 'popup') {
    url += `&prompt=${encodeURIComponent('login')}`;
  }

  return { redirectUrl: url, state: nonce };
}

// ── eBay OAuth callback ───────────────────────────────────────────────────────

export interface EbayOAuthCallbackResult {
  sub: string;
  returnTo: string | null;
  isPopup: boolean;
}

/**
 * Handle the eBay OAuth callback.
 *
 * Validates state, exchanges authorization code for tokens, persists the
 * refresh token in Redis, and issues an auto-opt-in to Business Policies.
 */
export async function callbackEbayOAuth(
  code: string,
  state: string,
): Promise<EbayOAuthCallbackResult> {
  const stateInfo = await consumeOAuthState(state);
  if (!stateInfo?.sub) throw new EbayOAuthStateError('Invalid or expired state');

  // Guard against replayed / stale states
  if (stateInfo.createdAt && Date.now() - stateInfo.createdAt > STATE_MAX_AGE_MS) {
    throw new EbayOAuthStateError('OAuth state has expired');
  }

  const env = process.env.EBAY_ENV || 'PROD';
  const tokenHost =
    env === 'SANDBOX' ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com';
  const runame = (process.env.EBAY_RUNAME || process.env.EBAY_RU_NAME)!;

  const basic = Buffer.from(
    `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`,
  ).toString('base64');

  const bodyParams = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: runame,
  });

  const res = await fetch(`${tokenHost}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: bodyParams,
  });

  let data: Record<string, unknown> = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }

  if (!res.ok) {
    throw new EbayOAuthTokenError(
      `eBay token exchange failed (HTTP ${res.status})`,
      res.status,
      data,
    );
  }

  const refreshToken = data.refresh_token as string | undefined;
  const accessToken = data.access_token as string | undefined;
  if (!refreshToken) {
    throw new EbayOAuthTokenError(
      'No refresh_token returned — check EBAY_RUNAME, EBAY_ENV, and scopes',
      400,
      data,
    );
  }

  // Persist refresh token (never log the token value itself)
  const tokens = tokensStore();
  const key = `users/${encodeURIComponent(stateInfo.sub)}/ebay.json`;
  await tokens.setJSON(key, { refresh_token: refreshToken });

  // Auto opt-in to Business Policies (non-critical)
  if (accessToken) {
    try {
      const apiHost =
        env === 'SANDBOX' ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com';
      await fetch(`${apiHost}/sell/account/v1/program/opt_in`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ programType: 'SELLING_POLICY_MANAGEMENT' }),
      });
    } catch {
      // Ignore — user can opt-in manually if needed
    }
  }

  const isPopup = stateInfo.returnTo === 'popup';
  const returnTo = sanitizeReturnTo(stateInfo.returnTo);

  return { sub: stateInfo.sub, returnTo, isPopup };
}

// ── Error classes ─────────────────────────────────────────────────────────────

export class EbayOAuthConfigError extends Error {
  readonly statusCode = 500;
  constructor(msg: string) {
    super(msg);
    this.name = 'EbayOAuthConfigError';
  }
}

export class EbayOAuthStateError extends Error {
  readonly statusCode = 400;
  constructor(msg: string) {
    super(msg);
    this.name = 'EbayOAuthStateError';
  }
}

export class EbayOAuthTokenError extends Error {
  readonly statusCode: number;
  readonly detail: Record<string, unknown>;
  constructor(msg: string, status: number, detail: Record<string, unknown>) {
    super(msg);
    this.name = 'EbayOAuthTokenError';
    this.statusCode = status;
    this.detail = detail;
  }
}
