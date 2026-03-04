/**
 * Pricing Entrypoint — single import for all pricing decisions.
 *
 * Consumer code should import from here rather than directly from
 * `delivered-pricing.ts` or `pricing-compute.ts`.
 *
 * Routing (priority order):
 *   1. PRICING_MODE env var  → 'delivered_v2' | 'legacy'  (authoritative)
 *   2. DELIVERED_PRICING_V2  → back-compat shim            (deprecated)
 *   3. Default               → 'legacy'
 */

import {
  getDeliveredPricing,
  type DeliveredPricingDecision,
  type DeliveredPricingSettings,
} from './delivered-pricing.js';
import { getFinalEbayPrice, getCategoryCap } from './legacy-compute.js';
import type { CompetitorPrice } from './shared-types.js';
// Type-only re-export from price-lookup (erased at runtime — no circular risk)
export type { PriceDecision } from '../../../../src/lib/price-lookup.js';

// ── Re-exports ────────────────────────────────────────────────────────────────
// Type-only exports — shapes used in PricingDecision.delivered and related types.
// App code should ONLY import functions from this module (getPricingDecision, resolveActivePricingMode).
// For raw pricing helpers (computeEbayItemPriceCents etc.) import from ./legacy-compute.ts directly.
export type { DeliveredPricingDecision, DeliveredPricingSettings, CompetitorPrice };

// ── Active pricing mode ───────────────────────────────────────────────────────

/** Controls which pricing pipeline {@link getPricingDecision} uses. */
export type ActivePricingMode = 'legacy' | 'delivered_v2';

// Emit the DELIVERED_PRICING_V2 deprecation warning at most once per process.
let _deprecWarnEmitted = false;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PricingInput {
  brand: string;
  productName: string;
  /** Delivered-pricing settings (v2 path only, ignored on legacy path). */
  settings?: Partial<DeliveredPricingSettings>;
  /** Additional context (SEO terms / category) passed to v2 search. */
  additionalContext?: string;
  /**
   * GPT-sourced retail price in dollars.
   * Required for the legacy path.
   * On the v2 path, used only for the NEEDS_REVIEW fallback suggestion.
   */
  retailPriceDollars?: number;
  /** Category path for price-cap lookup (e.g. 'Books > Fiction'). */
  categoryPath?: string;
}

/**
 * Compact summary of delivered-pricing internal state, promoted into the
 * public PricingDecisionEvidence so callers never need to reach into
 * the (now-internal) DeliveredPricingDecision.
 *
 * Only present when `source === 'delivered-v2'`.
 */
export interface PricingEvidenceSummary {
  /** Whether we can compete on price (canCompete from v2 engine). */
  canCompete: boolean;
  /** True when lowPriceMode=AUTO_SKIP and we would lose money — skip listing. */
  skipListing: boolean;
  /** Confidence in the product-identity match used to find comps. */
  matchConfidence: 'high' | 'medium' | 'low';
  /** True when the shipping fee was zeroed out (subsumed into item price). */
  freeShipApplied: boolean;
  /** Which data source drove the final price (e.g. 'ebay-browse', 'google-shopping'). */
  compsSource: string;
  /** Lowest eBay active delivered price seen, null if no active comps. */
  activeFloorDeliveredCents: number | null;
  /** Number of retail comps gathered (Amazon, Walmart, …). */
  retailCompsCount: number;
  /** Amazon retail price in cents, null if not found. */
  amazonPriceCents: number | null;
  /** Walmart retail price in cents, null if not found. */
  walmartPriceCents: number | null;
  /** Median of sold-listing delivered prices, null if no sold data. */
  soldMedianDeliveredCents: number | null;
  /** Total sold listings found. */
  soldCount: number;
  /** True when soldCount is large enough to trust as anchor (≥ 5). */
  soldStrong: boolean;
  /** How the shipping estimate was derived for this item. */
  shippingEstimateSource: string;
  /** Free-shipping subsidy absorbed into item price, in cents. */
  subsidyCents: number;
  /**
   * Top competitor prices (up to 5 eBay + 3 retail) for candidate building
   * and transparency logs.  Source field distinguishes eBay vs retail entries.
   */
  topComps: Array<{
    source: string;
    deliveredCents: number;
    itemCents: number;
    shipCents: number;
    url: string | null;
    title: string;
    seller: string;
  }>;
}

export interface PricingDecisionEvidence {
  /** Which pricing pipeline produced this result. */
  source: 'delivered-v2' | 'legacy';
  mode: string;
  targetDeliveredCents: number;
  /** Delivered-pricing item cents (stored even on NEEDS_REVIEW for reference). */
  finalItemCents: number;
  finalShipCents: number;
  ebayCompsCount: number;
  fallbackUsed: boolean;
  warnings: string[];
  /** True when the draft was gated due to low-confidence pricing. */
  manualReviewRequired?: boolean;
  /** Legacy-price suggestion computed as safe fallback (NEEDS_REVIEW only). */
  fallbackSuggestion?: { itemCents: number; source: 'legacy-retail' };
  /**
   * Compact delivered-pricing scalar fields.
   * Present when `source === 'delivered-v2'`.  Absent on the legacy path.
   */
  summary?: PricingEvidenceSummary;
}

export interface PricingDecision {
  /**
   * Publish-gate status.
   *   NEEDS_REVIEW — low-confidence pricing; must NOT be auto-published.
   *   READY        — normal path, safe to auto-publish.
   */
  status: 'READY' | 'NEEDS_REVIEW';
  /** Final item price in cents to display / store on the eBay listing. */
  finalItemCents: number;
  /** Buyer-facing shipping charge in cents (0 = free shipping). */
  finalShipCents: number;
  warnings: string[];
  pricingEvidence: PricingDecisionEvidence;
}

// ── Publish-gate helper ───────────────────────────────────────────────────────

/**
 * Returns true when delivered-pricing warnings indicate low confidence,
 * and the draft must NOT be auto-listed without human review.
 *
 * Triggers on:
 *   - 'manualReviewRequired'  (explicit flag from pricing engine)
 *   - 'noPricingData'         (no comps found at all)
 *   - any warning containing the substring 'manual' (defensive catch-all)
 */
export function needsManualReview(warnings: string[]): boolean {
  return warnings.some(
    (w) =>
      w === 'manualReviewRequired' ||
      w === 'noPricingData' ||
      w.toLowerCase().includes('manual'),
  );
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Resolves the active pricing mode from environment variables.
 *
 * Priority:
 *   1. `PRICING_MODE` ('delivered_v2' | 'legacy')  — authoritative
 *   2. `DELIVERED_PRICING_V2` ('true' | 'false')   — deprecated back-compat
 *   3. Default: 'legacy'
 *
 * Exported for unit testing.
 */
export function resolveActivePricingMode(): ActivePricingMode {
  const explicit = process.env.PRICING_MODE;
  if (explicit === 'delivered_v2' || explicit === 'legacy') {
    return explicit;
  }
  if (explicit !== undefined && explicit !== '') {
    console.warn(`[pricing] Unknown PRICING_MODE="${explicit}" — falling back to "legacy"`);
    return 'legacy';
  }

  // Back-compat: DELIVERED_PRICING_V2
  if (process.env.DELIVERED_PRICING_V2 !== undefined) {
    if (!_deprecWarnEmitted) {
      console.warn(
        '[pricing] DELIVERED_PRICING_V2 is deprecated; set PRICING_MODE=delivered_v2 or PRICING_MODE=legacy instead',
      );
      _deprecWarnEmitted = true;
    }
    return process.env.DELIVERED_PRICING_V2 === 'true' ? 'delivered_v2' : 'legacy';
  }

  return 'legacy';
}

/**
 * Apply legacy pricing formula to a retail price.
 * Thin wrapper that keeps getCategoryCap + getFinalEbayPrice co-located.
 */
function legacyItemDollars(retailDollars: number, categoryPath?: string): number {
  return getFinalEbayPrice(retailDollars, {
    categoryCap: getCategoryCap(categoryPath),
  });
}

// ── Public entrypoint ─────────────────────────────────────────────────────────

/**
 * Unified pricing entrypoint.
 *
 * Routes to the delivered-price-first v2 engine (`getDeliveredPricing`) when
 * `PRICING_MODE=delivered_v2` (or the deprecated `DELIVERED_PRICING_V2=true`),
 * and falls back to the legacy retail-discount formula (`getFinalEbayPrice`)
 * when `PRICING_MODE=legacy` or neither env var is set.
 *
 * @param input - Pricing parameters
 * @returns PricingDecision with status, final prices, warnings, evidence, and raw decision
 */
export async function getPricingDecision(input: PricingInput): Promise<PricingDecision> {
  const {
    brand,
    productName,
    settings,
    additionalContext,
    retailPriceDollars,
    categoryPath,
  } = input;

  const activeMode = resolveActivePricingMode();

  // ── delivered_v2 path ─────────────────────────────────────────────────────
  if (activeMode === 'delivered_v2') {
    const decision = await getDeliveredPricing(
      brand,
      productName,
      settings,
      additionalContext,
    );

    // Build the compact summary so callers never need the raw decision object.
    const summary: PricingEvidenceSummary = {
      canCompete: decision.canCompete,
      skipListing: decision.skipListing,
      matchConfidence: decision.matchConfidence,
      freeShipApplied: decision.freeShipApplied,
      compsSource: decision.compsSource,
      activeFloorDeliveredCents: decision.activeFloorDeliveredCents,
      retailCompsCount: decision.retailComps.length,
      amazonPriceCents: decision.amazonPriceCents,
      walmartPriceCents: decision.walmartPriceCents,
      soldMedianDeliveredCents: decision.soldMedianDeliveredCents,
      soldCount: decision.soldCount,
      soldStrong: decision.soldStrong,
      shippingEstimateSource: decision.shippingEstimateSource,
      subsidyCents: decision.subsidyCents,
      topComps: [
        ...decision.ebayComps.slice(0, 5).map((c) => ({
          source: c.source,
          deliveredCents: c.deliveredCents,
          itemCents: c.itemCents ?? 0,
          shipCents: c.shipCents ?? 0,
          url: c.url ?? null,
          title: c.title ?? '',
          seller: c.seller ?? '',
        })),
        ...decision.retailComps.slice(0, 3).map((c) => ({
          source: c.source,
          deliveredCents: c.deliveredCents,
          itemCents: c.itemCents ?? 0,
          shipCents: c.shipCents ?? 0,
          url: c.url ?? null,
          title: c.title ?? '',
          seller: c.seller ?? '',
        })),
      ],
    };

    const manualReview = needsManualReview(decision.warnings);

    if (manualReview) {
      // Safety gate: compute a legacy fallback for display purposes only.
      // The NEEDS_REVIEW status blocks any auto-publish downstream.
      const retailDollars = retailPriceDollars ?? 0;
      const fallbackItemCents =
        retailDollars > 0
          ? Math.round(legacyItemDollars(retailDollars, categoryPath) * 100)
          : decision.finalItemCents; // best-effort fallback when no retail price supplied

      return {
        status: 'NEEDS_REVIEW',
        finalItemCents: fallbackItemCents,
        finalShipCents: 0,
        warnings: decision.warnings,
        pricingEvidence: {
          source: 'delivered-v2',
          mode: decision.mode,
          targetDeliveredCents: decision.targetDeliveredCents,
          finalItemCents: decision.finalItemCents,
          finalShipCents: decision.finalShipCents,
          ebayCompsCount: decision.ebayComps.length,
          fallbackUsed: true,
          warnings: decision.warnings,
          manualReviewRequired: true,
          fallbackSuggestion: { itemCents: fallbackItemCents, source: 'legacy-retail' },
          summary,
        },
      };
    }

    return {
      status: 'READY',
      finalItemCents: decision.finalItemCents,
      finalShipCents: decision.finalShipCents,
      warnings: decision.warnings,
      pricingEvidence: {
        source: 'delivered-v2',
        mode: decision.mode,
        targetDeliveredCents: decision.targetDeliveredCents,
        finalItemCents: decision.finalItemCents,
        finalShipCents: decision.finalShipCents,
        ebayCompsCount: decision.ebayComps.length,
        fallbackUsed: decision.fallbackUsed,
        warnings: decision.warnings,
        manualReviewRequired: false,
        summary,
      },
    };
  }

  // ── legacy path ───────────────────────────────────────────────────────────
  const retailDollars = retailPriceDollars ?? 0;
  const legacyCents =
    retailDollars > 0
      ? Math.round(legacyItemDollars(retailDollars, categoryPath) * 100)
      : 0;

  return {
    status: 'READY',
    finalItemCents: legacyCents,
    finalShipCents: 0,
    warnings: [],
    pricingEvidence: {
      source: 'legacy',
      mode: 'retail-discount',
      targetDeliveredCents: legacyCents,
      finalItemCents: legacyCents,
      finalShipCents: 0,
      ebayCompsCount: 0,
      fallbackUsed: false,
      warnings: [],
    },
  };
}
