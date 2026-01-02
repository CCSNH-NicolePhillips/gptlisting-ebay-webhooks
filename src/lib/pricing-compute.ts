/**
 * Competitive Pricing Computation - Phase 2
 * 
 * PURPOSE: Pure function for computing final eBay item price based on Amazon pricing
 * 
 * DESIGN PRINCIPLES:
 * - Pure functions (no side effects)
 * - Deterministic rounding (cents precision)
 * - Strategy-based pricing (ALGO_COMPETITIVE_TOTAL vs DISCOUNT_ITEM_ONLY)
 * - Comprehensive evidence tracking for debugging
 * - Not wired into production yet (Phase 2 is math only)
 */

import type { PricingSettings, ShippingStrategy } from './pricing-config.js';

/**
 * Round to cents (2 decimal places)
 * Uses standard rounding (round half up)
 * 
 * @param value - Dollar amount to round
 * @returns Rounded value to 2 decimal places
 * 
 * @example
 * roundToCents(19.995) // 20.00
 * roundToCents(15.294) // 15.29
 * roundToCents(20.685) // 20.69
 */
export function roundToCents(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Convert cents to dollars
 */
function centsToDollars(cents: number): number {
  return cents / 100;
}

/**
 * Convert dollars to cents
 */
function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100);
}

/**
 * Evidence object for pricing computation transparency
 */
export interface PricingEvidence {
  amazonItemPriceDollars: number;
  amazonShippingDollars: number;
  amazonTotalDollars: number;
  discountPercent: number;
  targetDeliveredTotalDollars: number;
  shippingStrategy: ShippingStrategy;
  templateShippingEstimateDollars: number;
  shippingSubsidyCapDollars: number | null;
  ebayItemPriceDollars: number;
  minItemPriceDollars: number | null;
  minItemPriceApplied: boolean;
}

/**
 * Input parameters for eBay item price computation
 */
export interface ComputeEbayItemPriceInput {
  /** Amazon item price in cents (before shipping) */
  amazonItemPriceCents: number;
  /** Amazon shipping cost in cents (0 if free shipping) */
  amazonShippingCents: number;
  /** Discount percentage (e.g., 10 for 10% off Amazon total) */
  discountPercent: number;
  /** Shipping strategy: 'ALGO_COMPETITIVE_TOTAL' or 'DISCOUNT_ITEM_ONLY' */
  shippingStrategy: ShippingStrategy;
  /** Template shipping estimate in cents (e.g., 600 = $6.00) */
  templateShippingEstimateCents: number;
  /** Optional cap on shipping subsidy in cents (null = no cap) */
  shippingSubsidyCapCents: number | null;
  /** Optional minimum item price in cents (null = no minimum) */
  minItemPriceCents?: number | null;
}

/**
 * Result of eBay item price computation
 */
export interface ComputeEbayItemPriceResult {
  /** Final eBay item price in cents */
  ebayItemPriceCents: number;
  /** Evidence trail showing all calculation steps */
  evidence: PricingEvidence;
}

/**
 * Compute final eBay item price based on Amazon pricing and strategy
 * 
 * STRATEGIES:
 * 
 * 1. ALGO_COMPETITIVE_TOTAL:
 *    - Target delivered total = (Amazon item + Amazon ship) × (1 - discount%)
 *    - eBay item price = Target total - Template shipping estimate
 *    - Accounts for shipping costs in competitive positioning
 * 
 * 2. DISCOUNT_ITEM_ONLY:
 *    - eBay item price = Amazon item price × (1 - discount%)
 *    - Ignores Amazon shipping in calculation
 *    - Simpler strategy that discounts item only
 * 
 * ROUNDING:
 * - All intermediate calculations use dollar precision
 * - Final result rounded to cents before converting back
 * 
 * MINIMUM PRICE:
 * - If minItemPriceCents is provided and result is lower, floor is applied
 * - Evidence tracks whether minimum was applied
 * 
 * @param input - Pricing parameters
 * @returns Object with ebayItemPriceCents and evidence
 * 
 * @example
 * // Amazon $57.00 free shipping, 10% discount, ALGO strategy with $6 ship
 * computeEbayItemPrice({
 *   amazonItemPriceCents: 5700,
 *   amazonShippingCents: 0,
 *   discountPercent: 10,
 *   shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
 *   templateShippingEstimateCents: 600,
 *   shippingSubsidyCapCents: null,
 * })
 * // Returns: { ebayItemPriceCents: 4530, evidence: {...} }
 * // Calculation: targetTotal = 57.00 * 0.9 = 51.30
 * //              itemPrice = 51.30 - 6.00 = 45.30
 * 
 * @example
 * // Amazon $57.00 + $5.99 shipping, 10% discount, ITEM_ONLY strategy
 * computeEbayItemPrice({
 *   amazonItemPriceCents: 5700,
 *   amazonShippingCents: 599,
 *   discountPercent: 10,
 *   shippingStrategy: 'DISCOUNT_ITEM_ONLY',
 *   templateShippingEstimateCents: 600,
 *   shippingSubsidyCapCents: null,
 * })
 * // Returns: { ebayItemPriceCents: 5130, evidence: {...} }
 * // Calculation: itemPrice = 57.00 * 0.9 = 51.30
 */
export function computeEbayItemPrice(
  input: ComputeEbayItemPriceInput
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

  // Convert to dollars for calculation
  const amazonItemPrice = centsToDollars(amazonItemPriceCents);
  const amazonShipping = centsToDollars(amazonShippingCents);
  const templateShippingEstimate = centsToDollars(templateShippingEstimateCents);
  const minItemPrice = minItemPriceCents !== null ? centsToDollars(minItemPriceCents) : null;
  const shippingSubsidyCap = shippingSubsidyCapCents !== null ? centsToDollars(shippingSubsidyCapCents) : null;

  // Step 1: Calculate Amazon total-to-door
  const amazonTotal = roundToCents(amazonItemPrice + amazonShipping);

  // Step 2: Calculate target delivered total (after discount)
  const discountMultiplier = 1 - (discountPercent / 100);
  const targetDeliveredTotal = roundToCents(amazonTotal * discountMultiplier);

  // Step 3: Apply strategy to determine eBay item price
  let ebayItemPrice: number;

  if (shippingStrategy === 'ALGO_COMPETITIVE_TOTAL') {
    // FIX 7: When discount is 0% (Amazon prices), use item price directly
    // Amazon prices are already competitive - don't subtract shipping!
    if (discountPercent === 0) {
      ebayItemPrice = amazonItemPrice;
    } else {
      // ALGO: Item price = Target total - Estimated shipping
      ebayItemPrice = roundToCents(targetDeliveredTotal - templateShippingEstimate);
    }
  } else {
    // DISCOUNT_ITEM_ONLY: Item price = Amazon item price * discount
    ebayItemPrice = roundToCents(amazonItemPrice * discountMultiplier);
  }

  // Step 4: Apply minimum price floor if specified
  let minItemPriceApplied = false;
  if (minItemPrice !== null && ebayItemPrice < minItemPrice) {
    ebayItemPrice = minItemPrice;
    minItemPriceApplied = true;
  }

  // Step 5: Convert back to cents
  const ebayItemPriceCents = dollarsToCents(ebayItemPrice);

  // Step 6: Build evidence object
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

  return {
    ebayItemPriceCents,
    evidence,
  };
}

/**
 * Phase 2 Evidence object
 */
export interface ComputeEbayItemPriceCentsEvidence {
  amazonDeliveredTotalCents: number;
  discountPercent: number;
  shippingStrategy: string;
  templateShippingEstimateCents: number;
  shippingSubsidyAppliedCents: number;
  minItemPriceCents: number;
}

/**
 * Phase 2 Result object
 */
export interface ComputeEbayItemPriceCentsResult {
  ebayItemPriceCents: number;
  targetDeliveredTotalCents: number;
  evidence: ComputeEbayItemPriceCentsEvidence;
}

/**
 * Phase 2: Compute eBay item price from Amazon pricing + PricingSettings
 * 
 * IMPORTANT: This function ONLY computes item price in cents.
 * It does NOT modify eBay shipping templates/policies.
 * Buyer always pays shipping via template - we only adjust item price.
 * 
 * @param args.amazonItemPriceCents - Amazon item price in cents
 * @param args.amazonShippingCents - Amazon shipping cost in cents (0 if free)
 * @param args.settings - User pricing settings
 * @returns Object with ebayItemPriceCents, targetDeliveredTotalCents, and evidence
 */
export function computeEbayItemPriceCents(args: {
  amazonItemPriceCents: number;
  amazonShippingCents: number;
  settings: PricingSettings;
}): ComputeEbayItemPriceCentsResult {
  const { amazonItemPriceCents, amazonShippingCents, settings } = args;

  // Step 1: Calculate Amazon delivered total
  const amazonDeliveredTotalCents = amazonItemPriceCents + amazonShippingCents;

  // Step 2: Apply discount to get target delivered total
  const discountMultiplier = 1 - (settings.discountPercent / 100);
  const targetDeliveredTotalCents = Math.round(amazonDeliveredTotalCents * discountMultiplier);

  // Step 3: Compute eBay item price based on strategy
  let ebayItemPriceCents: number;
  let shippingSubsidyAppliedCents: number;

  if (settings.shippingStrategy === 'ALGO_COMPETITIVE_TOTAL') {
    // ALGO: Subtract shipping estimate from target total
    // Apply cap if specified
    let subsidy = settings.templateShippingEstimateCents;
    if (settings.shippingSubsidyCapCents !== null) {
      subsidy = Math.min(subsidy, settings.shippingSubsidyCapCents);
    }
    shippingSubsidyAppliedCents = subsidy;
    ebayItemPriceCents = targetDeliveredTotalCents - subsidy;
  } else {
    // DISCOUNT_ITEM_ONLY: Discount item price only, ignore shipping
    ebayItemPriceCents = Math.round(amazonItemPriceCents * discountMultiplier);
    shippingSubsidyAppliedCents = 0;
  }

  // Step 4: Apply minimum price floor
  if (ebayItemPriceCents < settings.minItemPriceCents) {
    ebayItemPriceCents = settings.minItemPriceCents;
  }

  // Step 5: Build evidence
  const evidence: ComputeEbayItemPriceCentsEvidence = {
    amazonDeliveredTotalCents,
    discountPercent: settings.discountPercent,
    shippingStrategy: settings.shippingStrategy,
    templateShippingEstimateCents: settings.templateShippingEstimateCents,
    shippingSubsidyAppliedCents,
    minItemPriceCents: settings.minItemPriceCents,
  };

  return {
    ebayItemPriceCents,
    targetDeliveredTotalCents,
    evidence,
  };
}

/**
 * Legacy function - kept for backward compatibility
 * Use computeEbayItemPriceCents() for new code (Phase 2+)
 * 
 * @deprecated Use computeEbayItemPriceCents instead
 */
export function computeAmazonTotals(input: {
  amazonItemPrice: number;
  amazonShippingPrice: number;
  discountPercent: number;
}): {
  amazonTotal: number;
  ebayTargetTotal: number;
} {
  const { amazonItemPrice, amazonShippingPrice, discountPercent } = input;

  // Step 1: Calculate Amazon total-to-door price
  const amazonTotal = roundToCents(amazonItemPrice + amazonShippingPrice);

  // Step 2: Apply discount to get eBay target total
  const discountMultiplier = 1 - (discountPercent / 100);
  const ebayTargetTotal = roundToCents(amazonTotal * discountMultiplier);

  return {
    amazonTotal,
    ebayTargetTotal,
  };
}
