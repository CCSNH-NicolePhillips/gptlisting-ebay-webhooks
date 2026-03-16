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
import { searchAmazonWithFallback } from '../../../../src/lib/amazon-search.js';
// Type-only re-export from price-lookup (erased at runtime — no circular risk)
export type { PriceDecision } from '../../../../src/lib/price-lookup.js';

// ── Re-exports ────────────────────────────────────────────────────────────────
// Type-only exports — shapes used in PricingDecision.delivered and related types.
// App code should ONLY import functions from this module (getPricingDecision, resolveActivePricingMode).
// For raw pricing helpers (computeEbayItemPriceCents etc.) import from ./legacy-compute.ts directly.
export type { DeliveredPricingDecision, DeliveredPricingSettings, CompetitorPrice };

// ── Active pricing mode ───────────────────────────────────────────────────────

/** Controls which pricing pipeline {@link getPricingDecision} uses. */
export type ActivePricingMode = 'legacy' | 'delivered_v2' | 'amazon_anchored';

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
  /**
   * Amazon price ratio for amazon_anchored mode.
   * eBay item price = Amazon price × amazonPricingRatio.
   * Defaults to 0.85 when not provided.
   */
  amazonPricingRatio?: number;
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
  if (explicit === 'delivered_v2' || explicit === 'legacy' || explicit === 'amazon_anchored') {
    return explicit;
  }
  if (explicit !== undefined && explicit !== '') {
    console.warn(`[pricing] Unknown PRICING_MODE="${explicit}" — falling back to "amazon_anchored"`);
    return 'amazon_anchored';
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

  // Default: amazon_anchored — simple, reliable: Amazon price × ratio.
  // Use PRICING_MODE=delivered_v2 for the full eBay-sold comps engine.
  // Use PRICING_MODE=legacy for the old retail-discount formula.
  return 'amazon_anchored';
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

  // ── amazon_anchored path ─────────────────────────────────────────────────
  // Simple, reliable: fetch Amazon price directly, apply ratio, done.
  // When Amazon doesn't carry the product → NEEDS_REVIEW for manual pricing.
  if (activeMode === 'amazon_anchored') {
    const ratio = input.amazonPricingRatio ?? 0.85;
    const shippingCents = settings?.shippingEstimateCents ?? 600;

    console.log(`[pricing] amazon_anchored: looking up "${brand} ${productName}" (ratio=${ratio})`);
    // tryBrandOnly=true: when full brand+product search fails, retry with brand name alone.
    // This finds niche brands whose Amazon title differs from the product label
    // (e.g. Besque's full product title doesn't surface in keyword search).
    //
    // additionalContext (seoContext) is appended to the product search query to improve
    // Amazon search accuracy for niche products (e.g. adds "100ml" which helps find
    // Besque Magic Luxury Body Oil). Conflict checks still use the original productName.
    const amazonProductQuery = [productName, additionalContext].filter(Boolean).join(' ').trim();
    const amazonResult = await searchAmazonWithFallback(brand, amazonProductQuery, true, productName);

    if (amazonResult.price !== null && amazonResult.confidence !== 'low') {
      // Safety: validate that the Amazon result is actually about the product we searched for.
      // If fewer than 25% of the non-trivial search terms appear in the result title, the
      // Amazon search returned a completely unrelated product (e.g. wrong brand/category).
      // Flag NEEDS_REVIEW instead of auto-pricing at a wrong price.
      if (amazonResult.title) {
        const STOP_WORDS = new Set(['the','a','an','and','or','for','in','of','with','by','to','on','at','is','it']);
        const searchTerms = `${brand} ${productName}`.toLowerCase()
          .split(/\s+/).filter(t => t.length > 2 && !STOP_WORDS.has(t));
        if (searchTerms.length >= 3) {
          const resultLower = amazonResult.title.toLowerCase();
          const overlap = searchTerms.filter(t => resultLower.includes(t)).length;
          const overlapRatio = overlap / searchTerms.length;
          if (overlapRatio < 0.25) {
            console.warn(
              `[pricing] amazon_anchored: LOW title overlap ${(overlapRatio * 100).toFixed(0)}% ` +
              `— searched "${brand} ${productName}" but result is "${amazonResult.title?.slice(0, 70)}" ` +
              `— flagging NEEDS_REVIEW (titleMismatch)`,
            );
            return {
              status: 'NEEDS_REVIEW',
              finalItemCents: 0,
              finalShipCents: 0,
              warnings: ['titleMismatch', 'manualReviewRequired'],
              pricingEvidence: {
                source: 'delivered-v2',
                mode: 'amazon-anchored',
                targetDeliveredCents: 0,
                finalItemCents: 0,
                finalShipCents: 0,
                ebayCompsCount: 0,
                fallbackUsed: true,
                warnings: ['titleMismatch', 'manualReviewRequired'],
                manualReviewRequired: true,
              },
            };
          }
        }
      }

      const amazonPriceCents = Math.round(amazonResult.price * 100);
      const itemCents = Math.max(Math.round(amazonPriceCents * ratio), 199);
      console.log(`[pricing] amazon_anchored: Amazon $${amazonResult.price.toFixed(2)} × ${ratio} = item $${(itemCents / 100).toFixed(2)} + ship $${(shippingCents / 100).toFixed(2)}`);
      return {
        status: 'READY',
        finalItemCents: itemCents,
        finalShipCents: shippingCents,
        warnings: [],
        pricingEvidence: {
          source: 'delivered-v2',
          mode: 'amazon-anchored',
          targetDeliveredCents: itemCents + shippingCents,
          finalItemCents: itemCents,
          finalShipCents: shippingCents,
          ebayCompsCount: 0,
          fallbackUsed: false,
          warnings: [],
          manualReviewRequired: false,
          summary: {
            canCompete: true,
            skipListing: false,
            matchConfidence: amazonResult.confidence,
            freeShipApplied: false,
            compsSource: 'amazon-direct',
            activeFloorDeliveredCents: null,
            retailCompsCount: 1,
            amazonPriceCents,
            walmartPriceCents: null,
            soldMedianDeliveredCents: null,
            soldCount: 0,
            soldStrong: false,
            shippingEstimateSource: 'fixed',
            subsidyCents: 0,
            topComps: [{
              source: 'amazon',
              deliveredCents: amazonPriceCents,
              itemCents: amazonPriceCents,
              shipCents: 0,
              url: amazonResult.url ?? null,
              title: amazonResult.title ?? '',
              seller: 'Amazon',
            }],
          },
        },
      };
    }

    // Product not found on Amazon — flag for manual review
    console.log(`[pricing] amazon_anchored: "${brand} ${productName}" not found on Amazon (confidence=${amazonResult.confidence}), flagging NEEDS_REVIEW`);
    const fallbackCents = retailPriceDollars
      ? Math.round(legacyItemDollars(retailPriceDollars, categoryPath) * 100)
      : 0;
    return {
      status: 'NEEDS_REVIEW',
      finalItemCents: fallbackCents,
      finalShipCents: 0,
      warnings: ['notOnAmazon', 'manualReviewRequired'],
      pricingEvidence: {
        source: 'delivered-v2',
        mode: 'amazon-anchored',
        targetDeliveredCents: fallbackCents,
        finalItemCents: fallbackCents,
        finalShipCents: 0,
        ebayCompsCount: 0,
        fallbackUsed: true,
        warnings: ['notOnAmazon', 'manualReviewRequired'],
        manualReviewRequired: true,
        fallbackSuggestion: fallbackCents > 0
          ? { itemCents: fallbackCents, source: 'legacy-retail' }
          : undefined,
      },
    };
  }

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
