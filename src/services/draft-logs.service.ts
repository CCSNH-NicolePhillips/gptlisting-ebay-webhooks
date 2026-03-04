/**
 * draft-logs.service.ts — Platform-agnostic service for fetching draft pricing logs.
 *
 * Mirrors the business logic previously inlined in:
 *   netlify/functions/draft-logs-get.ts
 *
 * Reads pricing/AI-reasoning logs from Redis storage.
 * Respects the user's `showPricingLogs` setting — returns a disabled response
 * when the feature is turned off.
 *
 * No HTTP framework dependencies.
 */

import { tokensStore } from '../lib/redis-store.js';
import { userScopedKey } from '../lib/_auth.js';
import { getDraftLogs, getDraftLogsByOfferId } from '../lib/draft-logs.js';
import { getGroupIdBySku } from '../lib/bind-store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FetchDraftLogsParams {
  sku?: string;
  offerId?: string;
}

export interface FetchDraftLogsResult {
  ok: true;
  enabled: boolean;
  logs: unknown | null;
  hasLogs: boolean;
  message?: string;
}

// ---------------------------------------------------------------------------
// fetchDraftLogs
// ---------------------------------------------------------------------------

/**
 * Retrieve pricing/AI-reasoning logs for a specific draft.
 *
 * Returns `{ enabled: false }` when the user has disabled log display in settings.
 *
 * @throws if Redis is unavailable.
 */
export async function fetchDraftLogs(
  userId: string,
  params: FetchDraftLogsParams,
): Promise<FetchDraftLogsResult> {
  const store = tokensStore();

  // Check if user has logs enabled in their settings
  const settingsKey = userScopedKey(userId, 'settings.json');
  let settings: Record<string, unknown> = {};
  try {
    settings = ((await store.get(settingsKey, { type: 'json' })) as Record<string, unknown>) ?? {};
  } catch {
    // Treat missing settings as defaults
  }

  const logsEnabled = (settings?.showPricingLogs ?? false) as boolean;

  if (!logsEnabled) {
    return {
      ok: true,
      enabled: false,
      logs: null,
      hasLogs: false,
      message: 'Pricing logs display is disabled. Enable it in Settings.',
    };
  }

  let logs: unknown = null;

  if (params.sku) {
    // Try direct SKU lookup
    logs = await getDraftLogs(userId, params.sku);

    // Fallback: SKU may be the eBay-generated one — resolve via binding
    if (!logs) {
      const groupId = await getGroupIdBySku(userId, params.sku);
      if (groupId) {
        logs = await getDraftLogs(userId, groupId);
      }
    }
  }

  // Also try offerId lookup if SKU still produced no result
  if (!logs && params.offerId) {
    logs = await getDraftLogsByOfferId(userId, params.offerId);
  }

  return {
    ok: true,
    enabled: true,
    logs: logs ?? null,
    hasLogs: !!logs,
  };
}
