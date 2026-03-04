/**
 * price-reduction.service.ts — Platform-agnostic service for reading auto price-reduction
 * binding data.
 *
 * Mirrors the business logic previously inlined in:
 *   netlify/functions/price-reduction-list.ts
 *
 * No HTTP framework dependencies.
 */

import { listAllBindings, type ListingBinding } from '../lib/price-store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PriceReductionItem {
  jobId: string;
  groupId: string;
  offerId: string | null;
  sku: string | null;
  title?: string;
  currentPrice: number;
  originalPrice?: number;
  auto: {
    enabled: boolean;
    reduceBy: number;
    everyDays: number;
    minPrice: number;
  } | null;
  createdAt: number;
  lastReductionAt: number | null;
  nextReductionAt: number | null;
  reductionCount: number;
  lastTick: {
    at: number;
    status: string;
    note?: string;
    fromPrice?: number;
    toPrice?: number;
  } | null;
  status: 'active' | 'paused' | 'at_floor' | 'no_offer';
}

export interface PriceReductionSummary {
  total: number;
  active: number;
  atFloor: number;
  paused: number;
  noOffer: number;
  totalReductions: number;
  totalSaved: number;
}

export interface ListPriceReductionsResult {
  items: PriceReductionItem[];
  summary: PriceReductionSummary;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeNextReductionAt(binding: ListingBinding): number | null {
  if (!binding.auto) return null;
  const last = binding.lastReductionAt ?? binding.createdAt;
  const lastMs = Number.isFinite(last) && last ? last : 0;
  const intervalMs = binding.auto.everyDays * 24 * 60 * 60 * 1000;
  return lastMs + intervalMs;
}

function computeReductionCount(binding: ListingBinding): number {
  const original =
    binding.pricing?.ebay ?? binding.pricing?.base ?? binding.currentPrice;
  const current = binding.currentPrice;
  if (!binding.auto || binding.auto.reduceBy <= 0) return 0;
  const diff = original - current;
  if (diff <= 0) return 0;
  return Math.floor(diff / binding.auto.reduceBy);
}

function determineStatus(
  binding: ListingBinding,
): 'active' | 'paused' | 'at_floor' | 'no_offer' {
  if (!binding.offerId) return 'no_offer';
  if (!binding.auto) return 'paused';
  const floor = binding.auto.minPrice ?? 0;
  if (binding.currentPrice <= floor) return 'at_floor';
  return 'active';
}

function transformBinding(binding: ListingBinding): PriceReductionItem {
  return {
    jobId: binding.jobId,
    groupId: binding.groupId,
    offerId: binding.offerId ?? null,
    sku: binding.sku ?? null,
    title: binding.metadata?.title as string | undefined,
    currentPrice: binding.currentPrice,
    originalPrice: binding.pricing?.ebay ?? binding.pricing?.base,
    auto: binding.auto
      ? {
          enabled: true,
          reduceBy: binding.auto.reduceBy,
          everyDays: binding.auto.everyDays,
          minPrice: binding.auto.minPrice,
        }
      : null,
    createdAt: binding.createdAt,
    lastReductionAt: binding.lastReductionAt ?? null,
    nextReductionAt: computeNextReductionAt(binding),
    reductionCount: computeReductionCount(binding),
    lastTick: binding.lastTick
      ? {
          at: binding.lastTick.at,
          status: binding.lastTick.status,
          note: binding.lastTick.note,
          fromPrice: binding.lastTick.fromPrice,
          toPrice: binding.lastTick.toPrice,
        }
      : null,
    status: determineStatus(binding),
  };
}

// ---------------------------------------------------------------------------
// listPriceReductions
// ---------------------------------------------------------------------------

/**
 * List auto price-reduction bindings for a user.
 *
 * @param userId  The authenticated user ID.
 * @param status  Optional filter: 'active' returns only active auto-reduction items.
 *                Default 'all' returns everything.
 */
export async function listPriceReductions(
  userId: string,
  status: 'all' | 'active' = 'all',
): Promise<ListPriceReductionsResult> {
  const allBindings = await listAllBindings();
  const userBindings = allBindings.filter(b => b.userId === userId);

  let items = userBindings.map(transformBinding);

  if (status === 'active') {
    items = items.filter(i => i.auto !== null && i.status === 'active');
  }

  // Sort: soonest next-reduction first, then newest creation date
  items.sort((a, b) => {
    if (a.nextReductionAt && b.nextReductionAt) return a.nextReductionAt - b.nextReductionAt;
    if (a.nextReductionAt) return -1;
    if (b.nextReductionAt) return 1;
    return b.createdAt - a.createdAt;
  });

  const summary: PriceReductionSummary = {
    total: items.length,
    active: items.filter(i => i.status === 'active').length,
    atFloor: items.filter(i => i.status === 'at_floor').length,
    paused: items.filter(i => i.status === 'paused').length,
    noOffer: items.filter(i => i.status === 'no_offer').length,
    totalReductions: items.reduce((sum, i) => sum + i.reductionCount, 0),
    totalSaved: items.reduce((sum, i) => {
      const original = i.originalPrice ?? i.currentPrice;
      return sum + (original - i.currentPrice);
    }, 0),
  };

  return { items, summary, timestamp: Date.now() };
}
