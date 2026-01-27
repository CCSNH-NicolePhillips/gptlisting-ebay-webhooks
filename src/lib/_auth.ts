import type { HandlerEvent } from '@netlify/functions';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { tokensStore } from './redis-store.js';

const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN;
const AUTH0_CLIENT_ID = process.env.AUTH0_CLIENT_ID;
const AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE;
const ISSUER = AUTH0_DOMAIN ? `https://${AUTH0_DOMAIN}/` : undefined;
const JWKS = AUTH0_DOMAIN ? createRemoteJWKSet(new URL(`${ISSUER}.well-known/jwks.json`)) : (null as any);

export interface OAuthStateRecord {
  sub: string;
  provider?: string;
  createdAt?: number;
  returnTo?: string | null;
}

/**
 * Get bearer token from Authorization header or query param (for popup OAuth flows)
 */
export function getBearerToken(event: HandlerEvent): string | null {
  const h = (event.headers || {}) as any;
  const auth = (h.authorization || h.Authorization || '') as string;
  if (auth && /^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, '').trim();
  }
  // Fallback: check for token in query params (used by popup OAuth flows)
  const queryToken = event.queryStringParameters?.token;
  if (queryToken && typeof queryToken === 'string' && queryToken.trim()) {
    return queryToken.trim();
  }
  return null;
}

export function getJwtSubUnverified(event: HandlerEvent): string | null {
  try {
    const token = getBearerToken(event);
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return typeof payload?.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

export async function requireAuthVerified(event: HandlerEvent): Promise<{ sub: string; claims: Record<string, any> } | null> {
  try {
    if (!JWKS || !ISSUER || !AUTH0_CLIENT_ID) {
      console.error('[Auth] Missing Auth0 configuration:', {
        hasJWKS: !!JWKS,
        hasISSUER: !!ISSUER,
        hasClientId: !!AUTH0_CLIENT_ID,
      });
      return null;
    }
    const token = getBearerToken(event);
    if (!token) {
      console.log('[Auth] No bearer token found in request');
      return null;
    }
    const audiences = AUTH0_AUDIENCE ? [AUTH0_CLIENT_ID, AUTH0_AUDIENCE] : [AUTH0_CLIENT_ID];
    const { payload } = await jwtVerify(token, JWKS, { issuer: ISSUER, audience: audiences as any });
    const sub = typeof payload?.sub === 'string' ? payload.sub : null;
    if (!sub) {
      console.error('[Auth] Token verified but no sub claim found');
      return null;
    }
    return { sub, claims: payload as any };
  } catch (err) {
    console.error('[Auth] Token verification failed:', {
      error: err instanceof Error ? err.message : String(err),
      hasAudience: !!AUTH0_AUDIENCE,
      audiences: AUTH0_AUDIENCE ? [AUTH0_CLIENT_ID, AUTH0_AUDIENCE] : [AUTH0_CLIENT_ID],
    });
    return null;
  }
}

// Verifies ID token against Auth0 and returns basic identity
export async function requireAuth(event: HandlerEvent): Promise<{ sub: string; email?: string; name?: string } | null> {
  const v = await requireAuthVerified(event);
  if (!v) return null;
  const email = typeof v.claims?.email === 'string' ? v.claims.email : undefined;
  const name = typeof v.claims?.name === 'string' ? v.claims.name : undefined;
  return { sub: v.sub, email, name };
}

// JSON response helper
export function json(body: any, status: number = 200) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export function userScopedKey(sub: string | null, key: string): string {
  return sub ? `users/${encodeURIComponent(sub)}/${key}` : key;
}

export async function createOAuthStateForUser(
  event: HandlerEvent,
  provider: string,
  extras: Partial<OAuthStateRecord> = {}
): Promise<string | null> {
  const sub = getJwtSubUnverified(event);
  if (!sub) return null;
  const nonce = (globalThis as any).crypto?.randomUUID
    ? (globalThis as any).crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
  const store = tokensStore();
  const record: OAuthStateRecord = {
    sub,
    provider,
    createdAt: Date.now(),
    ...extras,
  };
  await store.setJSON(`oauth-state/${nonce}.json`, record);
  return nonce;
}

export async function consumeOAuthState(state: string | null): Promise<OAuthStateRecord | null> {
  if (!state) return null;
  try {
    const store = tokensStore();
    const key = `oauth-state/${state}.json`;
    const j = (await store.get(key, { type: 'json' })) as OAuthStateRecord | null;
    if (j && j.sub) {
      try {
        await store.delete?.(key as any);
      } catch {}
      return { ...j, sub: String(j.sub) };
    }
    return null;
  } catch {
    return null;
  }
}
