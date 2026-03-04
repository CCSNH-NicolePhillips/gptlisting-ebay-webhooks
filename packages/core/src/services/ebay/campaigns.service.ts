/**
 * packages/core/src/services/ebay/campaigns.service.ts
 *
 * List eBay promoted-listing campaigns for a user.
 * Route: GET /api/ebay/campaigns
 */

import { tokensStore } from '../../../../../src/lib/redis-store.js';
import { userScopedKey } from '../../../../../src/lib/_auth.js';
import { accessTokenFromRefresh, tokenHosts } from '../../../../../src/lib/_common.js';

// ─── Error classes ────────────────────────────────────────────────────────────

export class CampaignsNotConnectedError extends Error {
  readonly statusCode = 400;
  constructor() { super('Connect eBay first'); this.name = 'CampaignsNotConnectedError'; }
}

export class CampaignsApiError extends Error {
  readonly statusCode: number;
  constructor(msg: string, statusCode: number) { super(msg); this.name = 'CampaignsApiError'; this.statusCode = statusCode; }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Campaign {
  campaignId: string;
  name: string;
  status: string;
  fundingStrategyType: string | null;
}

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * List eBay ad campaigns for the user, alongside their default promo campaign preference.
 */
export async function listCampaigns(userId: string): Promise<{
  ok: true;
  defaultPromoCampaignId: string | null;
  campaigns: Campaign[];
}> {
  const store = tokensStore();
  const saved = (await store.get(userScopedKey(userId, 'ebay.json'), { type: 'json' })) as any;
  const refresh = saved?.refresh_token as string | undefined;
  if (!refresh) throw new CampaignsNotConnectedError();

  // Read the user's default campaign preference from Redis
  let defaultPromoCampaignId: string | null = null;
  try {
    const prefs = (await store.get(userScopedKey(userId, 'marketing-defaults.json'), { type: 'json' })) as any;
    defaultPromoCampaignId = prefs?.defaultPromoCampaignId ?? null;
  } catch {}

  const { access_token } = await accessTokenFromRefresh(refresh, [
    'https://api.ebay.com/oauth/api_scope',
    'https://api.ebay.com/oauth/api_scope/sell.account',
    'https://api.ebay.com/oauth/api_scope/sell.inventory',
    'https://api.ebay.com/oauth/api_scope/sell.marketing',
  ]);
  const { apiHost } = tokenHosts(process.env.EBAY_ENV);
  const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';

  const res = await fetch(`${apiHost}/sell/marketing/v1/ad_campaign?limit=200`, {
    headers: {
      Authorization: `Bearer ${access_token}`,
      'Content-Type': 'application/json',
      'Accept-Language': 'en-US',
      'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID,
    },
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 500);
    throw new CampaignsApiError(`eBay API error: ${res.status} — ${detail}`, res.status);
  }

  const raw = (await res.json()) as any;
  const campaigns: Campaign[] = (raw.campaigns ?? []).map((c: any) => ({
    campaignId: c.campaignId,
    name: c.campaignName,
    status: c.campaignStatus,
    fundingStrategyType: c.fundingStrategy?.fundingModel ?? null,
  }));

  return { ok: true, defaultPromoCampaignId, campaigns };
}
