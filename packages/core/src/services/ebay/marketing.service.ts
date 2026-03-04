/**
 * packages/core/src/services/ebay/marketing.service.ts
 *
 * Per-user eBay marketing defaults (promoted campaign preference).
 *   getMarketingDefaults  — GET  /api/ebay/marketing/defaults
 *   setMarketingDefault   — POST /api/ebay/marketing/defaults
 */

import { tokensStore } from '../../../../../src/lib/redis-store.js';
import { userScopedKey } from '../../../../../src/lib/_auth.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MarketingDefaults {
  defaultPromoCampaignId: string | null;
}

// ─── Services ─────────────────────────────────────────────────────────────────

/** Read the user's eBay marketing defaults from Redis. */
export async function getMarketingDefaults(userId: string): Promise<{ ok: true; defaults: MarketingDefaults }> {
  const store = tokensStore();
  let prefs: any = {};
  try {
    prefs = (await store.get(userScopedKey(userId, 'marketing-defaults.json'), { type: 'json' })) as any;
  } catch {}
  if (!prefs || typeof prefs !== 'object') prefs = {};

  return {
    ok: true,
    defaults: { defaultPromoCampaignId: prefs.defaultPromoCampaignId ?? null },
  };
}

/**
 * Save the user's default promo campaign ID to Redis.
 * Pass null to clear the preference.
 */
export async function setMarketingDefault(
  userId: string,
  defaultPromoCampaignId: string | null,
): Promise<{ ok: true; defaultPromoCampaignId: string | null }> {
  const store = tokensStore();
  const key = userScopedKey(userId, 'marketing-defaults.json');

  let prefs: any = {};
  try {
    prefs = (await store.get(key, { type: 'json' })) as any;
  } catch {}
  if (!prefs || typeof prefs !== 'object') prefs = {};

  prefs.defaultPromoCampaignId = defaultPromoCampaignId;
  await store.set(key, JSON.stringify(prefs));

  return { ok: true, defaultPromoCampaignId };
}
