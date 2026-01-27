import { tokensStore } from './redis-store.js';
import { accessTokenFromRefresh, tokenHosts } from './_common.js';
import { userScopedKey } from './_auth.js';

export async function getUserAccessToken(sub: string, scopes?: string[]): Promise<string> {
  const store = tokensStore();
  const saved = (await store.get(userScopedKey(sub, 'ebay.json'), { type: 'json' })) as any;
  const refresh = saved?.refresh_token as string | undefined;
  if (!refresh) throw Object.assign(new Error('ebay-not-connected'), { code: 'ebay-not-connected' });
  const { access_token } = await accessTokenFromRefresh(refresh, scopes);
  if (!access_token) throw new Error('failed-to-mint-access-token');
  return access_token;
}

export function apiHost(): string {
  const env = process.env.EBAY_ENV || 'PROD';
  const { apiHost } = tokenHosts(env);
  return apiHost;
}

export function headers(token: string): Record<string, string> {
  const MARKETPLACE_ID =
    process.env.DEFAULT_MARKETPLACE_ID || process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Language': 'en-US',
    'Accept-Language': 'en-US',
    'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID,
    'Content-Type': 'application/json',
  };
}
