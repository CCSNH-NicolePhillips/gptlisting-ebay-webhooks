/**
 * eBay Price Math — dependency-free pure pricing functions.
 *
 * This module contains ONLY functions that have zero imports from other
 * project modules.  It is safe to import from anywhere (price-lookup,
 * delivered-pricing, tests, etc.) without creating circular dependencies.
 *
 * Previously these lived in src/lib/pricing-compute.ts (now a deprecated
 * re-export stub).  Prefer importing from here for new code.
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Round to cents (2 decimal places) — standard half-up rounding.
 */
export function roundToCents(value: number): number {
  return Math.round(value * 100) / 100;
}

function centsToDollars(cents: number): number {
  return cents / 100;
}

function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100);
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PricingEvidence {
  amazonItemPriceDollars: number;
  amazonShippingDollars: number;
  amazonTotalDollars: number;
  discountPercent: number;
  targetDeliveredTotalDollars: number;
  shippingStrategy: string;
  templateShippingEstimateDollars: number;
  shippingSubsidyCapDollars: number | null;
  ebayItemPriceDollars: number;
  minItemPriceDollars: number | null;
  minItemPriceApplied: boolean;
}

export interface ComputeEbayItemPriceInput {
  /** Amazon item price in cents (before shipping) */
  amazonItemPriceCents: number;
  /** Amazon shipping cost in cents (0 if free shipping) */
  amazonShippingCents: number;
  /** Discount percentage (e.g., 10 for 10% off Amazon total) */
  discountPercent: number;
  /** Shipping strategy: 'ALGO_COMPETITIVE_TOTAL' or 'DISCOUNT_ITEM_ONLY' */
  shippingStrategy: string;
  /** Template shipping estimate in cents (e.g., 600 = $6.00) */
  templateShippingEstimateCents: number;
  /** Optional cap on shipping subsidy in cents (null = no cap) */
  shippingSubsidyCapCents: number | null;
  /** Optional minimum item price in cents (null = no minimum) */
  minItemPriceCents?: number | null;
}

export interface ComputeEbayItemPriceResult {
  /** Final eBay item price in cents */
  ebayItemPriceCents: number;
  /** Evidence trail showing all calculation steps */
  evidence: PricingEvidence;
}

// ── Functions ─────────────────────────────────────────────────────────────────

/**
 * Compute final eBay item price based on Amazon pricing and strategy.
 *
 * STRATEGIES:
 *   ALGO_COMPETITIVE_TOTAL  — target delivered = (Amazon item + ship) × (1 − disc%),
 *                             eBay item = target − template shipping estimate
 *   DISCOUNT_ITEM_ONLY      — eBay item = Amazon item × (1 − disc%)
 */
export function computeEbayItemPrice(
  input: ComputeEbayItemPriceInput,
): ComputeEbayItemPriceResult {
  const {
    amazonItemPriceCents,
    amazonShippingCents,
    discountPercent,
    shippingStrategy,
    templateShippingEstimateCents,
    shippingSubsidyCapCents,
    minItemPriceCents = null,
  } = input;

  const amazonItemPrice = centsToDollars(amazonItemPriceCents);
  const amazonShipping = centsToDollars(amazonShippingCents);
  const templateShippingEstimate = centsToDollars(templateShippingEstimateCents);
  const minItemPrice = minItemPriceCents !== null ? centsToDollars(minItemPriceCents) : null;
  const shippingSubsidyCap =
    shippingSubsidyCapCents !== null ? centsToDollars(shippingSubsidyCapCents) : null;

  const amazonTotal = roundToCents(amazonItemPrice + amazonShipping);
  const discountMultiplier = 1 - discountPercent / 100;
  const targetDeliveredTotal = roundToCents(amazonTotal * discountMultiplier);

  let ebayItemPrice: number;
  if (shippingStrategy === 'ALGO_COMPETITIVE_TOTAL') {
    ebayItemPrice = roundToCents(targetDeliveredTotal - templateShippingEstimate);
  } else {
    ebayItemPrice = roundToCents(amazonItemPrice * discountMultiplier);
  }

  let minItemPriceApplied = false;
  if (minItemPrice !== null && ebayItemPrice < minItemPrice) {
    ebayItemPrice = minItemPrice;
    minItemPriceApplied = true;
  }

  const ebayItemPriceCents = dollarsToCents(ebayItemPrice);

  const evidence: PricingEvidence = {
    amazonItemPriceDollars: amazonItemPrice,
    amazonShippingDollars: amazonShipping,
    amazonTotalDollars: amazonTotal,
    discountPercent,
    targetDeliveredTotalDollars: targetDeliveredTotal,
    shippingStrategy,
    templateShippingEstimateDollars: templateShippingEstimate,
    shippingSubsidyCapDollars: shippingSubsidyCap,
    ebayItemPriceDollars: ebayItemPrice,
    minItemPriceDollars: minItemPrice,
    minItemPriceApplied,
  };

  return { ebayItemPriceCents, evidence };
}

/**
 * Compute Amazon delivered total and eBay target total.
 *
 * @deprecated Use computeEbayItemPriceCents from `pricing/legacy-compute.ts` for new code.
 */
export function computeAmazonTotals(input: {
  amazonItemPrice: number;
  amazonShippingPrice: number;
  discountPercent: number;
}): { amazonTotal: number; ebayTargetTotal: number } {
  const { amazonItemPrice, amazonShippingPrice, discountPercent } = input;
  const amazonTotal = roundToCents(amazonItemPrice + amazonShippingPrice);
  const discountMultiplier = 1 - discountPercent / 100;
  const ebayTargetTotal = roundToCents(amazonTotal * discountMultiplier);
  return { amazonTotal, ebayTargetTotal };
}
