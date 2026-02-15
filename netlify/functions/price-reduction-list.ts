import type { Handler } from '../../src/types/api-handler.js';
import { listAllBindings, type ListingBinding } from "../../src/lib/price-store.js";
import { getOrigin, isAuthorized, isOriginAllowed, jsonResponse } from "../../src/lib/http.js";
import { maybeRequireUserAuth, type UserAuth } from "../../src/lib/auth-user.js";

type HeadersMap = Record<string, string | undefined>;
const METHODS = "GET, OPTIONS";

/**
 * GET /price-reduction-list
 * 
 * Returns all price reduction bindings for the authenticated user.
 * Includes:
 * - Active items with auto price reduction enabled
 * - Price reduction history (from lastTick)
 * - Next scheduled reduction time
 * 
 * Query params:
 *   - status: 'active' | 'all' (default: 'all')
 */

export interface PriceReductionItem {
  jobId: string;
  groupId: string;
  offerId: string | null;
  sku: string | null;
  title?: string;
  
  // Current state
  currentPrice: number;
  originalPrice?: number;
  
  // Auto config
  auto: {
    enabled: boolean;
    reduceBy: number;
    everyDays: number;
    minPrice: number;
  } | null;
  
  // Schedule info
  createdAt: number;
  lastReductionAt: number | null;
  nextReductionAt: number | null;
  reductionCount: number;
  
  // Last tick info
  lastTick: {
    at: number;
    status: string;
    note?: string;
    fromPrice?: number;
    toPrice?: number;
  } | null;
  
  // Status
  status: 'active' | 'paused' | 'at_floor' | 'no_offer';
}

function computeNextReductionAt(binding: ListingBinding): number | null {
  if (!binding.auto) return null;
  
  const last = binding.lastReductionAt ?? binding.createdAt;
  const lastMs = Number.isFinite(last) && last ? last : 0;
  const intervalMs = binding.auto.everyDays * 24 * 60 * 60 * 1000;
  
  return lastMs + intervalMs;
}

function computeReductionCount(binding: ListingBinding): number {
  // Estimate based on price difference from original
  const original = binding.pricing?.ebay ?? binding.pricing?.base ?? binding.currentPrice;
  const current = binding.currentPrice;
  
  if (!binding.auto || binding.auto.reduceBy <= 0) return 0;
  
  const diff = original - current;
  if (diff <= 0) return 0;
  
  return Math.floor(diff / binding.auto.reduceBy);
}

function determineStatus(binding: ListingBinding): 'active' | 'paused' | 'at_floor' | 'no_offer' {
  if (!binding.offerId) return 'no_offer';
  if (!binding.auto) return 'paused';
  
  // Check if at floor
  const current = binding.currentPrice;
  const floor = binding.auto.minPrice ?? 0;
  
  if (current <= floor) return 'at_floor';
  
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
    
    auto: binding.auto ? {
      enabled: true,
      reduceBy: binding.auto.reduceBy,
      everyDays: binding.auto.everyDays,
      minPrice: binding.auto.minPrice,
    } : null,
    
    createdAt: binding.createdAt,
    lastReductionAt: binding.lastReductionAt ?? null,
    nextReductionAt: computeNextReductionAt(binding),
    reductionCount: computeReductionCount(binding),
    
    lastTick: binding.lastTick ? {
      at: binding.lastTick.at,
      status: binding.lastTick.status,
      note: binding.lastTick.note,
      fromPrice: binding.lastTick.fromPrice,
      toPrice: binding.lastTick.toPrice,
    } : null,
    
    status: determineStatus(binding),
  };
}

export const handler: Handler = async (event) => {
  const headers = event.headers as HeadersMap;
  const originHdr = getOrigin(headers);

  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(200, {}, originHdr, METHODS);
  }

  if (event.httpMethod !== "GET") {
    return jsonResponse(405, { error: "Method not allowed" }, originHdr, METHODS);
  }

  if (!isOriginAllowed(originHdr)) {
    return jsonResponse(403, { error: "Forbidden" }, originHdr, METHODS);
  }

  // Auth check - try admin token first, then user auth
  let userAuth: UserAuth | null = null;
  if (!isAuthorized(headers)) {
    try {
      userAuth = await maybeRequireUserAuth(headers.authorization || headers.Authorization);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err ?? "");
      console.warn("[price-reduction-list] user auth failed", reason);
      return jsonResponse(401, { error: "Unauthorized" }, originHdr, METHODS);
    }
    if (!userAuth) {
      return jsonResponse(401, { error: "Unauthorized" }, originHdr, METHODS);
    }
  }

  try {
    const userId = userAuth?.userId;
    if (!userId) {
      return jsonResponse(401, { error: "User ID required" }, originHdr, METHODS);
    }

    // Get query params
    const status = event.queryStringParameters?.status || 'all';
    
    // Get all bindings
    const allBindings = await listAllBindings();
    
    // Filter to user's bindings
    const userBindings = allBindings.filter(b => b.userId === userId);
    
    // Transform to response format
    let items = userBindings.map(transformBinding);
    
    // Filter by status if requested
    if (status === 'active') {
      items = items.filter(item => item.auto !== null && item.status === 'active');
    }
    
    // Sort by next reduction time (soonest first), then by created date
    items.sort((a, b) => {
      // Active items with upcoming reductions first
      if (a.nextReductionAt && b.nextReductionAt) {
        return a.nextReductionAt - b.nextReductionAt;
      }
      if (a.nextReductionAt) return -1;
      if (b.nextReductionAt) return 1;
      
      // Then by created date (newest first)
      return b.createdAt - a.createdAt;
    });
    
    // Compute summary stats
    const summary = {
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

    return jsonResponse(200, {
      items,
      summary,
      timestamp: Date.now(),
    }, originHdr, METHODS);
    
  } catch (err: any) {
    console.error("[price-reduction-list] Error:", err);
    return jsonResponse(500, { error: err.message || "Internal error" }, originHdr, METHODS);
  }
};
