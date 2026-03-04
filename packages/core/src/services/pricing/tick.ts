/**
 * packages/core/src/services/pricing/tick.ts
 *
 * Platform-agnostic price-reduction tick engine.
 * Iterates all auto-reduction bindings and applies due price cuts via the
 * eBay Inventory API.
 */

import {
  listAllBindings,
  updateBinding,
  type ListingBinding,
  type TickSnapshot,
} from '../../../../../src/lib/price-store.js';
import { updateOfferPrice, type EbayTokenCache } from '../../../../../src/lib/ebay-adapter.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TickSource = 'schedule' | 'http';

export type TickResult = {
  jobId: string;
  groupId: string;
  offerId?: string | null;
  sku?: string | null;
  action: 'updated' | 'skipped' | 'error';
  reason?: string;
  previousPrice?: number | null;
  nextPrice?: number;
  dueAt?: number | null;
};

export type TickExecution = {
  startedAt: number;
  finishedAt: number;
  dryRun: boolean;
  source: TickSource;
  totalBindings: number;
  evaluated: number;
  summary: { updated: number; skipped: number; errors: number };
  results: TickResult[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysToMs(days: number): number {
  return days * MS_PER_DAY;
}

function sanitizePrice(value: number | null | undefined): number | null {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

function computeNextPrice(binding: ListingBinding): { nextPrice: number | null; floor: number } {
  const auto = binding.auto;
  if (!auto) return { nextPrice: null, floor: 0 };
  const current = sanitizePrice(binding.currentPrice);
  if (current === null) return { nextPrice: null, floor: 0 };
  const floor = sanitizePrice(auto.minPrice) ?? 0;
  const reduction = Math.round(current * (auto.reduceBy / 100) * 100) / 100;
  const candidate = Math.round((current - reduction) * 100) / 100;
  const next = Math.max(candidate, floor);
  return { nextPrice: next, floor };
}

function intervalDue(binding: ListingBinding, now: number): { due: boolean; dueAt: number } {
  const auto = binding.auto;
  if (!auto?.everyDays) return { due: false, dueAt: 0 };
  const intervalMs = daysToMs(auto.everyDays);
  const lastMs = binding.lastReductionAt ?? binding.createdAt ?? 0;
  const dueAt = lastMs + intervalMs;
  return { due: now >= dueAt, dueAt };
}

function toSnapshot(data: {
  offerId?: string | null;
  sku?: string | null;
  previousPrice: number | null;
  nextPrice: number;
  triggeredAt: number;
}): TickSnapshot {
  return {
    at: data.triggeredAt,
    status: 'updated',
    fromPrice: data.previousPrice ?? undefined,
    toPrice: data.nextPrice,
    note: data.offerId ? `offerId=${data.offerId}` : (data.sku ? `sku=${data.sku}` : undefined),
  };
}

// ---------------------------------------------------------------------------
// Core tick runner
// ---------------------------------------------------------------------------

export async function runPriceTick(opts: {
  dryRun?: boolean;
  source?: TickSource;
  tokenCache?: EbayTokenCache;
}): Promise<TickExecution> {
  const { dryRun = false, source = 'http', tokenCache } = opts;

  const startedAt = Date.now();
  const results: TickResult[] = [];

  let allBindings: ListingBinding[];
  try {
    allBindings = await listAllBindings();
  } catch (err: any) {
    return {
      startedAt,
      finishedAt: Date.now(),
      dryRun,
      source,
      totalBindings: 0,
      evaluated: 0,
      summary: { updated: 0, skipped: 0, errors: 1 },
      results: [
        {
          jobId: '__list__',
          groupId: '__list__',
          action: 'error',
          reason: err?.message || 'failed to list bindings',
        },
      ],
    };
  }

  const now = Date.now();

  for (const binding of allBindings) {
    const { jobId, groupId, offerId, sku, userId, auto } = binding;

    if (!auto || !userId) {
      results.push({ jobId, groupId, offerId, sku, action: 'skipped', reason: 'no auto config' });
      continue;
    }

    const { due, dueAt } = intervalDue(binding, now);
    if (!due) {
      results.push({ jobId, groupId, offerId, sku, action: 'skipped', reason: 'not due yet', dueAt });
      continue;
    }

    const { nextPrice, floor: _ } = computeNextPrice(binding);
    if (nextPrice === null) {
      results.push({ jobId, groupId, offerId, sku, action: 'skipped', reason: 'cannot compute next price' });
      continue;
    }

    const previousPrice = sanitizePrice(binding.currentPrice);
    if (previousPrice !== null && nextPrice >= previousPrice) {
      results.push({
        jobId,
        groupId,
        offerId,
        sku,
        action: 'skipped',
        reason: 'next price >= current price (floor reached)',
        previousPrice,
        nextPrice,
      });
      continue;
    }

    if (!offerId) {
      results.push({ jobId, groupId, sku, action: 'skipped', reason: 'no offerId' });
      continue;
    }

    try {
      if (!dryRun) {
        await updateOfferPrice(userId, offerId, nextPrice, { dryRun: false, tokenCache });
        const snapshot = toSnapshot({
          offerId,
          sku: sku ?? null,
          previousPrice,
          nextPrice,
          triggeredAt: now,
        });
        await updateBinding(jobId, groupId, {
          currentPrice: nextPrice,
          lastReductionAt: now,
          pricing: { lastSnapshot: snapshot } as any,
        });
      }
      results.push({
        jobId,
        groupId,
        offerId,
        sku,
        action: 'updated',
        previousPrice,
        nextPrice,
      });
    } catch (err: any) {
      results.push({
        jobId,
        groupId,
        offerId,
        sku,
        action: 'error',
        reason: err?.message || String(err),
        previousPrice,
        nextPrice,
      });
    }
  }

  const finishedAt = Date.now();
  const summary = {
    updated: results.filter((r) => r.action === 'updated').length,
    skipped: results.filter((r) => r.action === 'skipped').length,
    errors: results.filter((r) => r.action === 'error').length,
  };

  return {
    startedAt,
    finishedAt,
    dryRun,
    source,
    totalBindings: allBindings.length,
    evaluated: results.length,
    summary,
    results,
  };
}
