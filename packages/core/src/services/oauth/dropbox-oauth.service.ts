/**
 * dropbox-oauth.service.ts — Dropbox OAuth 2.0 flow helpers for Express.
 *
 * Implements:
 *   startDropboxOAuth(sub, returnTo)  → build authorization URL + persist state
 *   callbackDropboxOAuth(code, state) → validate state, exchange code, save tokens
 */

import { tokensStore } from '../../../../../src/lib/redis-store.js';
import { consumeOAuthState, userScopedKey } from '../../../../../src/lib/_auth.js';
import type { OAuthStateRecord } from '../../../../../src/lib/_auth.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const STATE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

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

// ── Dropbox OAuth start ───────────────────────────────────────────────────────

export interface DropboxOAuthStartResult {
  redirectUrl: string;
  state: string;
}

/**
 * Generate the Dropbox authorization URL for a given authenticated user.
 *
 * @param sub      Auth0 sub of the authenticated user.
 * @param returnTo Sanitized return-to path or 'popup'; null = default.
 */
export async function startDropboxOAuth(
  sub: string,
  returnTo: string | null,
): Promise<DropboxOAuthStartResult> {
  const clientId = process.env.DROPBOX_CLIENT_ID;
  const redirectUri = process.env.DROPBOX_REDIRECT_URI;
  if (!clientId) throw new DropboxOAuthConfigError('Missing DROPBOX_CLIENT_ID');
  if (!redirectUri) throw new DropboxOAuthConfigError('Missing DROPBOX_REDIRECT_URI');

  const nonce = await createState(sub, 'dropbox', returnTo);

  const url = new URL('https://www.dropbox.com/oauth2/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('token_access_type', 'offline');
  url.searchParams.set('state', nonce);

  if (returnTo === 'popup') {
    // Force re-auth/consent for popup reconnect flows.
    url.searchParams.set('force_reapprove', 'true');
    url.searchParams.set('force_reauthentication', 'true');
  } else {
    // If this user has never connected, force consent to avoid silently reusing another session.
    try {
      const store = tokensStore();
      const existing = (await store.get(userScopedKey(sub, 'dropbox.json'), { type: 'json' })) as any;
      if (!existing?.refresh_token) {
        url.searchParams.set('force_reapprove', 'true');
        url.searchParams.set('force_reauthentication', 'true');
        url.searchParams.set('disable_signup', 'false');
      }
    } catch {
      // Non-critical — proceed without force_reapprove
    }
  }

  return { redirectUrl: url.toString(), state: nonce };
}

// ── Dropbox OAuth callback ────────────────────────────────────────────────────

export interface DropboxOAuthCallbackResult {
  sub: string;
  returnTo: string | null;
  isPopup: boolean;
}

/**
 * Handle the Dropbox OAuth callback.
 *
 * Validates state, exchanges authorization code for tokens, persists the
 * refresh token in Redis.
 */
export async function callbackDropboxOAuth(
  code: string,
  state: string,
): Promise<DropboxOAuthCallbackResult> {
  const stateInfo = await consumeOAuthState(state);
  if (!stateInfo?.sub) {
    throw new DropboxOAuthStateError('Invalid or expired state. Start connect from the app while signed in.');
  }

  if (stateInfo.createdAt && Date.now() - stateInfo.createdAt > STATE_MAX_AGE_MS) {
    throw new DropboxOAuthStateError('OAuth state has expired');
  }

  const clientId = process.env.DROPBOX_CLIENT_ID!;
  const clientSecret = process.env.DROPBOX_CLIENT_SECRET!;
  const redirectUri = process.env.DROPBOX_REDIRECT_URI!;

  const bodyParams = new URLSearchParams({
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });

  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
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
    throw new DropboxOAuthTokenError(
      `Dropbox token exchange failed (HTTP ${res.status})`,
      res.status,
      data,
    );
  }

  const refreshToken = data.refresh_token as string | undefined;
  if (!refreshToken) {
    throw new DropboxOAuthTokenError('No refresh_token returned', 400, data);
  }

  // Persist refresh token (never log the token value itself)
  const tokens = tokensStore();
  const key = `users/${encodeURIComponent(stateInfo.sub)}/dropbox.json`;
  await tokens.setJSON(key, { refresh_token: refreshToken });

  const isPopup = stateInfo.returnTo === 'popup';
  const returnTo = sanitizeReturnTo(stateInfo.returnTo);

  return { sub: stateInfo.sub, returnTo, isPopup };
}

// ── Error classes ─────────────────────────────────────────────────────────────

export class DropboxOAuthConfigError extends Error {
  readonly statusCode = 500;
  constructor(msg: string) {
    super(msg);
    this.name = 'DropboxOAuthConfigError';
  }
}

export class DropboxOAuthStateError extends Error {
  readonly statusCode = 400;
  constructor(msg: string) {
    super(msg);
    this.name = 'DropboxOAuthStateError';
  }
}

export class DropboxOAuthTokenError extends Error {
  readonly statusCode: number;
  readonly detail: Record<string, unknown>;
  constructor(msg: string, status: number, detail: Record<string, unknown>) {
    super(msg);
    this.name = 'DropboxOAuthTokenError';
    this.statusCode = status;
    this.detail = detail;
  }
}
