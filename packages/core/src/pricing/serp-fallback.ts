/**
 * SERP Fallback for Pricing Identity/Comps
 *
 * Called when SearchAPI active comps are weak (< 5 after identity filtering)
 * and sold data is insufficient (soldCleanCount < 10).
 *
 * Uses SerpAPI (serpapi.com) with SERPAPI_KEY to fetch eBay sold/completed
 * listings as a supplementary comp source.  Quota is enforced via price-quota.ts.
 *
 * Design principle: fail-open and silence-safe.
 * Any error → return empty list. Never throw. Never block pricing.
 */

import { canUseSerp, incSerp } from '../../../../src/lib/price-quota.js';

const SERPAPI_BASE = 'https://serpapi.com/search';
const REQUEST_TIMEOUT_MS = 10_000;

// ─── Public types ─────────────────────────────────────────────────────────────

export interface SerpCandidate {
  title: string;
  priceCents: number;
  /** Shipping cost in cents; 0 = free */
  shipCents: number;
  source: 'serp';
}

export interface SerpFallbackResult {
  candidates: SerpCandidate[];
  /** true when quota was exhausted; no network call was made */
  quotaExceeded: boolean;
  /** true when SERPAPI_KEY is absent; no network call was made */
  skipped: boolean;
}

// ─── Main function ────────────────────────────────────────────────────────────

/**
 * Fetch eBay sold/completed listings from SerpAPI as a fallback comp source.
 *
 * Only called when:
 *   - DP_IDENTITY_FILTER=true
 *   - soldCleanCount < 10  (sold data is insufficient for P35)
 *   - activeCompSamples.length < 5  (active comps are also weak)
 *
 * Callers are responsible for identity-filtering the returned candidates
 * before merging into the comp pool.
 */
export async function serpFallbackLookup(query: string): Promise<SerpFallbackResult> {
  const empty: SerpFallbackResult = { candidates: [], quotaExceeded: false, skipped: false };

  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    console.log('[serp-fallback] No SERPAPI_KEY — skipping');
    return { ...empty, skipped: true };
  }

  // ── Quota check ──────────────────────────────────────────────────────────
  let allowed = true;
  try {
    allowed = await canUseSerp();
  } catch {
    // Quota-check failure → fail-open (allow the call)
    allowed = true;
  }

  if (!allowed) {
    console.log('[serp-fallback] Monthly SERP quota exceeded — skipping');
    return { ...empty, quotaExceeded: true };
  }

  // ── Network call ─────────────────────────────────────────────────────────
  try {
    const url = new URL(SERPAPI_BASE);
    url.searchParams.set('engine', 'ebay');
    url.searchParams.set('ebay_domain', 'ebay.com');
    url.searchParams.set('_nkw', query.trim());
    url.searchParams.set('LH_Complete', '1');   // Completed listings
    url.searchParams.set('LH_Sold', '1');        // Sold listings only
    url.searchParams.set('LH_ItemCondition', '1000'); // New condition
    url.searchParams.set('api_key', apiKey);

    console.log(`[serp-fallback] Querying SerpAPI eBay sold: "${query}"`);

    const response = await fetch(url.toString(), {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      console.warn(`[serp-fallback] HTTP ${response.status} from SerpAPI — skipping`);
      return empty;
    }

    // Count quota after a successful HTTP response
    await incSerp().catch(() => { /* non-fatal */ });

    const data: Record<string, unknown> = await response.json() as Record<string, unknown>;

    const items: unknown[] = (data.organic_results as unknown[] | undefined) ?? [];
    if (items.length === 0) {
      console.log('[serp-fallback] SerpAPI returned 0 results');
      return empty;
    }

    const candidates: SerpCandidate[] = [];

    for (const raw of items) {
      const item = raw as Record<string, unknown>;

      // ── Title ──
      const title = String(item.title ?? item.name ?? '').trim();
      if (!title) continue;

      // ── Price ──
      const price = parsePrice(item);
      if (!price || price <= 0) continue;

      // ── Shipping ──
      const ship = parseShipping(item);

      candidates.push({
        title,
        priceCents: Math.round(price * 100),
        shipCents: Math.round(ship * 100),
        source: 'serp',
      });
    }

    console.log(`[serp-fallback] Parsed ${candidates.length}/${items.length} priced candidates`);
    return { candidates, quotaExceeded: false, skipped: false };

  } catch (err) {
    console.warn('[serp-fallback] Error fetching SerpAPI results:', err);
    return empty;
  }
}

// ─── Price parsing helpers ────────────────────────────────────────────────────

function parsePrice(item: Record<string, unknown>): number | null {
  // SerpAPI returns prices in various shapes
  if (typeof item.extracted_price === 'number') return item.extracted_price;
  if (typeof item.price === 'number') return item.price;

  const priceObj = item.price;
  if (priceObj && typeof priceObj === 'object') {
    const p = priceObj as Record<string, unknown>;
    if (typeof p.extracted_value === 'number') return p.extracted_value;
    if (typeof p.value === 'number') return p.value;
    if (typeof p.raw === 'string') return parseMoneyString(p.raw);
  }

  if (typeof item.price === 'string') return parseMoneyString(item.price);
  return null;
}

function parseShipping(item: Record<string, unknown>): number {
  if (typeof item.extracted_shipping === 'number') return item.extracted_shipping;

  if (typeof item.shipping === 'string') {
    const s = item.shipping.toLowerCase();
    if (s.includes('free') || s.includes('0.00')) return 0;
    const m = s.match(/\$?([\d,]+\.?\d*)/);
    if (m) return parseFloat(m[1].replace(/,/g, '')) || 0;
  }

  return 0;
}

function parseMoneyString(s: string): number | null {
  const m = s.replace(/,/g, '').match(/[\d]+\.?\d*/);
  if (!m) return null;
  const val = parseFloat(m[0]);
  return Number.isFinite(val) && val > 0 ? val : null;
}

// ─── Guard helper (exported for tests) ───────────────────────────────────────

/**
 * Returns true when the SERP fallback should be attempted.
 * Encodes the two conditions checked in getDeliveredPricingV2:
 *   - soldCleanCount < 10  (sold data insufficient for strong P35)
 *   - activeCompCount < 5  (active comps sparse after identity filtering)
 *
 * When soldCleanCount >= 10 the pricing engine has strong sold data and
 * does NOT need SERP supplementation.
 */
export function shouldUseSerpFallback(soldCleanCount: number, activeCompCount: number): boolean {
  return soldCleanCount < 10 && activeCompCount < 5;
}
