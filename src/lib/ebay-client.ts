/**
 * ebay-client.ts — Shared helper that resolves a live eBay access token for
 * a given authenticated user.
 *
 * Every eBay route needs to:
 *   1. Load the user's refresh-token from Redis.
 *   2. Exchange it for a short-lived access token.
 *   3. Know the correct API host (sandbox vs prod).
 *
 * This module centralises that pattern so services don't repeat it.
 */

import { tokensStore } from './redis-store.js';
import { accessTokenFromRefresh, tokenHosts } from './_common.js';
import { userScopedKey } from './_auth.js';

export interface EbayClient {
  /** Live eBay OAuth access token */
  access_token: string;
  /** e.g. "https://api.ebay.com" | "https://api.sandbox.ebay.com" */
  apiHost: string;
  /** Pre-built headers to include in every eBay Inventory API call */
  headers: Record<string, string>;
}

/** Thrown when the user has not connected their eBay account. */
export class EbayNotConnectedError extends Error {
  readonly statusCode = 400;
  constructor() {
    super('Connect eBay first');
    this.name = 'EbayNotConnectedError';
  }
}

/**
 * Build an `EbayClient` for the given authenticated user.
 *
 * @throws {EbayNotConnectedError} if the user has no stored eBay refresh token.
 */
export async function getEbayClient(userId: string): Promise<EbayClient> {
  const store = tokensStore();
  const saved = (await store.get(userScopedKey(userId, 'ebay.json'), {
    type: 'json',
  })) as any;

  const refresh = saved?.refresh_token as string | undefined;
  if (!refresh) throw new EbayNotConnectedError();

  const { access_token } = await accessTokenFromRefresh(refresh);
  const { apiHost } = tokenHosts(process.env.EBAY_ENV);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${access_token}`,
    'Content-Language': 'en-US',
    Accept: 'application/json',
  };

  return { access_token, apiHost, headers };
}
