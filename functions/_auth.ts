import type { HandlerEvent } from '@netlify/functions';
import { tokensStore } from './_blobs.js';

export function getBearerToken(event: HandlerEvent): string | null {
  const h = event.headers || {} as any;
  const auth = (h.authorization || h.Authorization || '') as string;
  if (!auth || !/^Bearer\s+/i.test(auth)) return null;
  return auth.replace(/^Bearer\s+/i, '').trim();
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

export async function createOAuthStateForUser(event: HandlerEvent, provider: string): Promise<string | null> {
  const sub = getJwtSubUnverified(event);
  if (!sub) return null;
  // Random opaque ID
  const nonce = (globalThis as any).crypto?.randomUUID ? (globalThis as any).crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
  const store = tokensStore();
  await store.setJSON(`oauth-state/${nonce}.json`, { sub, provider, createdAt: Date.now() });
  return nonce;
}

export async function consumeOAuthState(state: string | null): Promise<string | null> {
  if (!state) return null;
  try {
    const store = tokensStore();
    const key = `oauth-state/${state}.json`;
    const j = (await store.get(key, { type: 'json' })) as any;
    if (j && j.sub) {
      // best-effort cleanup
      try { await store.delete?.(key as any); } catch {}
      return String(j.sub);
    }
    return null;
  } catch {
    return null;
  }
}

export function userScopedKey(sub: string | null, key: string): string {
  return sub ? `users/${encodeURIComponent(sub)}/${key}` : key;
}
