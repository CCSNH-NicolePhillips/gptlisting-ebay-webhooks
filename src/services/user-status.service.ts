/**
 * user-status.service.ts
 *
 * Platform-agnostic service for the /api/status endpoint.
 * Reads eBay + Dropbox connection tokens from Redis and returns
 * the same shape as /.netlify/functions/status.
 */

import { tokensStore } from '../lib/redis-store.js';
import { userScopedKey } from '../lib/_auth.js';
import { getUserStats } from '../lib/user-stats.js';

export interface ConnectionStatus {
  dropbox: { connected: boolean };
  ebay: { connected: boolean };
  stats: Awaited<ReturnType<typeof getUserStats>>;
  user?: {
    name?: string;
    email?: string;
    given_name?: string;
    preferred_username?: string;
  };
}

/**
 * Get the current connection status (Dropbox, eBay) and usage stats for a user.
 * @param sub - Auth0 user ID (sub claim)
 * @param userClaims - Optional JWT claims for name/email enrichment
 */
export async function getConnectionStatus(
  sub: string,
  userClaims?: Record<string, unknown>,
): Promise<ConnectionStatus> {
  const tokens = tokensStore();

  const [dbx, ebay, stats] = await Promise.all([
    tokens.get(userScopedKey(sub, 'dropbox.json'), { type: 'json' }) as Promise<any>,
    tokens.get(userScopedKey(sub, 'ebay.json'), { type: 'json' }) as Promise<any>,
    getUserStats(sub),
  ]);

  const user = userClaims
    ? {
        name:
          typeof userClaims.name === 'string' ? userClaims.name : undefined,
        email:
          typeof userClaims.email === 'string' ? userClaims.email : undefined,
        given_name:
          typeof userClaims.given_name === 'string'
            ? userClaims.given_name
            : undefined,
        preferred_username:
          typeof userClaims.preferred_username === 'string'
            ? userClaims.preferred_username
            : undefined,
      }
    : undefined;

  return {
    dropbox: { connected: !!(dbx as any)?.refresh_token },
    ebay: { connected: !!(ebay as any)?.refresh_token },
    stats,
    user,
  };
}

/**
 * Disconnect a provider (clear its stored token) for a user.
 * @param sub - Auth0 user ID
 * @param provider - 'dropbox' | 'ebay'
 */
export async function disconnectProvider(
  sub: string,
  provider: 'dropbox' | 'ebay',
): Promise<void> {
  const tokens = tokensStore();
  const key = userScopedKey(sub, `${provider}.json`);
  await tokens.setJSON(key, {});
}
