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
 * 
 * SHIPPING TERMINOLOGY (CRITICAL - READ THIS):
 * =============================================
 * shippingChargeCents = what BUYER pays for shipping (0 if free shipping)
 *   - This is displayed on eBay listing as "Shipping: $X.XX"
 *   - Set to 0 when using FREE_SHIPPING mode
 * 
 * shippingCostEstimateCents = what WE expect to pay the carrier
 *   - Used internally for margin calculations
 *   - Does NOT affect buyer's displayed price
 *   - Category/weight-based estimate of our actual shipping cost
 * 
 * targetDeliveredTotalCents = what buyer pays TOTAL (item + shippingCharge)
 *   - This is the ANCHOR for all pricing decisions
 *   - Calculated from comps/Amazon/retail before any split
 *   - NEVER double-count: targetDelivered = itemPrice + shippingCharge (always)
 */

import type { PricingSettings, ShippingStrategy, EbayShippingMode } from './pricing-config.js';
import { getDefaultPricingSettings } from './pricing-config.js';

/**
 * Get category-specific price cap to prevent unrealistic pricing.
 * Returns undefined if no cap applies.
 * 
 * @param categoryPath - eBay category path string (e.g., "Books > Fiction")
 * @returns Max retail price for this category, or undefined for no cap
 */
export function getCategoryCap(categoryPath?: string): number | undefined {
  const lowerCategory = (categoryPath || '').toLowerCase();
  
  // Books: cap at $35 retail (most used books shouldn't exceed this)
  if (lowerCategory.includes('book')) {
    return 35;
  }
  // DVDs/Media: cap at $25 retail  
  if (lowerCategory.includes('dvd') || lowerCategory.includes('movie') || lowerCategory.includes('music')) {
    return 25;
  }
  
  return undefined; // No cap
}

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
    // ALGO: Item price = Target total - Estimated shipping
    ebayItemPrice = roundToCents(targetDeliveredTotal - templateShippingEstimate);
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
 * SIMPLE WRAPPER: Convert base retail price to final eBay price
 * 
 * THIS IS THE ONE FUNCTION ALL CODE SHOULD USE for simple price conversion.
 * It uses the default pricing settings (discountPercent, shippingStrategy, etc.)
 * 
 * @param basePriceDollars - The retail/MSRP price in dollars (e.g., 29.99)
 * @param options - Optional overrides (category caps, custom settings)
 * @returns Final eBay listing price in dollars
 * 
 * @example
 * // Amazon $29.99 → eBay $20.99 (with default 10% discount and $6 shipping)
 * getFinalEbayPrice(29.99) // returns 20.99
 * 
 * // With category cap for books
 * getFinalEbayPrice(50.00, { categoryCap: 35 }) // caps at $35, then applies formula
 */
export function getFinalEbayPrice(
  basePriceDollars: number,
  options?: {
    /** Optional category-specific price cap (e.g., 35 for books) */
    categoryCap?: number;
    /** Optional custom settings (otherwise uses defaults) */
    settings?: PricingSettings;
  }
): number {
  // Guard against invalid input
  if (!isFinite(basePriceDollars) || basePriceDollars <= 0) return 0;
  
  // Apply category cap if specified
  let cappedPrice = basePriceDollars;
  if (options?.categoryCap && basePriceDollars > options.categoryCap) {
    cappedPrice = options.categoryCap;
  }
  
  // Get settings (use provided or default)
  const settings = options?.settings ?? getDefaultPricingSettings();
  
  // Convert to cents and compute
  const result = computeEbayItemPrice({
    amazonItemPriceCents: Math.round(cappedPrice * 100),
    amazonShippingCents: 0, // Base retail price has no shipping
    discountPercent: settings.discountPercent,
    shippingStrategy: settings.shippingStrategy,
    templateShippingEstimateCents: settings.templateShippingEstimateCents,
    shippingSubsidyCapCents: settings.shippingSubsidyCapCents,
    minItemPriceCents: settings.minItemPriceCents,
  });
  
  return result.ebayItemPriceCents / 100;
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

// ============================================================================
// NEW: Unified eBay Offer Pricing (Step 2 of DraftPilot pricing fix)
// ============================================================================

/**
 * Result of eBay offer pricing computation
 * 
 * This is the FINAL output used when creating eBay listings.
 * All values are in cents (integers) to avoid float precision issues.
 */
export interface EbayOfferPricingResult {
  /**
   * Target delivered total - what buyer pays in total (item + shipping charge)
   * This is the ANCHOR for all pricing decisions.
   */
  targetDeliveredTotalCents: number;

  /**
   * Item price to set on eBay offer (cents)
   * This is what goes in pricingSummary.price
   */
  itemPriceCents: number;

  /**
   * Shipping charge buyer pays (cents)
   * 0 if FREE_SHIPPING mode, otherwise buyerShippingChargeCents from settings
   * 
   * INVARIANT: itemPriceCents + shippingChargeCents = targetDeliveredTotalCents
   */
  shippingChargeCents: number;

  /**
   * Estimated shipping cost WE pay to carrier (cents)
   * Used for margin calculations, NOT displayed to buyer.
   * This is separate from shippingChargeCents!
   */
  shippingCostEstimateCents: number;

  /**
   * Actual shipping mode used (may differ from settings if auto-switched)
   */
  effectiveShippingMode: EbayShippingMode;

  /**
   * Warnings generated during computation
   * e.g., ["minItemFloorHit", "cannotCompete", "autoSwitchedToFreeShipping"]
   */
  warnings: string[];

  /**
   * Evidence for debugging - all inputs and intermediate values
   */
  evidence: EbayOfferPricingEvidence;
}

/**
 * Evidence object for pricing transparency and debugging
 */
export interface EbayOfferPricingEvidence {
  baseDeliveredTargetCents: number;
  shippingCostEstimateCents: number;
  requestedShippingMode: EbayShippingMode;
  effectiveShippingMode: EbayShippingMode;
  buyerShippingChargeCents: number;
  itemPriceCents: number;
  targetDeliveredTotalCents: number;
  minItemPriceCents: number;
  autoFreeShippingTriggered: boolean;
  warnings: string[];
}

/**
 * Compute final eBay offer pricing (item price + shipping charge)
 * 
 * WHY THIS FUNCTION EXISTS:
 * =========================
 * Previous code was confusing "shipping charge to buyer" with "shipping cost we pay".
 * This led to double-counting shipping or incorrect splits.
 * 
 * This function provides ONE source of truth:
 * - Input: baseDeliveredTargetCents (what buyer should pay total, from comps)
 * - Output: itemPriceCents + shippingChargeCents that sum to targetDeliveredTotalCents
 * 
 * NEVER DOUBLE COUNT:
 * - If mode is FREE_SHIPPING: shippingChargeCents = 0, itemPriceCents = targetDelivered
 * - If mode is BUYER_PAYS: itemPriceCents = targetDelivered - shippingCharge
 * 
 * @param input.baseDeliveredTargetCents - Target total buyer pays (from comps/amazon/retail)
 * @param input.shippingCostEstimateCents - What WE expect to pay carrier (for margin calc)
 * @param input.settings - User pricing settings including ebayShippingMode
 * @returns EbayOfferPricingResult with itemPriceCents, shippingChargeCents, evidence
 */
export function computeEbayOfferPricingCents(input: {
  baseDeliveredTargetCents: number;
  shippingCostEstimateCents: number;
  settings: PricingSettings;
}): EbayOfferPricingResult {
  const { baseDeliveredTargetCents, shippingCostEstimateCents, settings } = input;
  const warnings: string[] = [];

  // Start with target delivered = base (may be updated if we have to clamp)
  let targetDeliveredTotalCents = baseDeliveredTargetCents;

  let itemPriceCents: number;
  let shippingChargeCents: number;
  let effectiveShippingMode: EbayShippingMode = settings.ebayShippingMode;
  let autoFreeShippingTriggered = false;

  /*
   * ========================================================================
   * CORE SPLIT LOGIC
   * ========================================================================
   * 
   * WHY we split differently based on mode:
   * 
   * FREE_SHIPPING:
   *   - Buyer sees "$X.XX + Free Shipping"
   *   - We bake shipping cost into item price
   *   - itemPrice = targetDelivered (shipping already "in there")
   *   - shippingCharge = 0
   * 
   * BUYER_PAYS_SHIPPING:
   *   - Buyer sees "$X.XX + $Y.YY shipping"
   *   - We split: itemPrice + shippingCharge = targetDelivered
   *   - itemPrice = targetDelivered - shippingCharge
   *   - shippingCharge = settings.buyerShippingChargeCents
   * 
   * INVARIANT: itemPriceCents + shippingChargeCents === targetDeliveredTotalCents
   * This is ALWAYS true. No exceptions.
   */

  if (effectiveShippingMode === 'FREE_SHIPPING') {
    // FREE_SHIPPING: buyer pays item price only, shipping baked in
    shippingChargeCents = 0;
    itemPriceCents = targetDeliveredTotalCents;
  } else {
    // BUYER_PAYS_SHIPPING: split into item + shipping
    shippingChargeCents = settings.buyerShippingChargeCents;
    itemPriceCents = targetDeliveredTotalCents - shippingChargeCents;
  }

  /*
   * ========================================================================
   * GUARDRAIL: Minimum item price floor
   * ========================================================================
   * 
   * WHY: Prevents listings like "$0.50 + $8.00 shipping" which:
   * 1. Look scammy to buyers
   * 2. May violate eBay policies
   * 3. Indicate we can't actually compete at this price point
   */

  if (itemPriceCents < settings.minItemPriceCents) {
    // Option A: Auto-switch to FREE_SHIPPING if allowed
    if (settings.allowAutoFreeShippingOnLowPrice && effectiveShippingMode === 'BUYER_PAYS_SHIPPING') {
      // Switch to FREE_SHIPPING mode
      effectiveShippingMode = 'FREE_SHIPPING';
      shippingChargeCents = 0;
      itemPriceCents = baseDeliveredTargetCents; // Use original target, not the split value
      autoFreeShippingTriggered = true;
      warnings.push('autoSwitchedToFreeShipping');

      // Check if even with free shipping we're below floor
      if (itemPriceCents < settings.minItemPriceCents) {
        itemPriceCents = settings.minItemPriceCents;
        warnings.push('minItemFloorHit');
      }
      
      // Update targetDeliveredTotal to maintain invariant
      targetDeliveredTotalCents = itemPriceCents + shippingChargeCents;
    } else {
      // Option B: Clamp to minimum (will be overpriced vs market)
      itemPriceCents = settings.minItemPriceCents;
      warnings.push('minItemFloorHit');
      warnings.push('cannotCompete');
      
      // Update targetDeliveredTotal to maintain invariant
      targetDeliveredTotalCents = itemPriceCents + shippingChargeCents;
    }
  }

  // Ensure no negative values (sanity check)
  if (itemPriceCents < 0) {
    itemPriceCents = 0;
    warnings.push('negativePriceClamped');
  }
  if (shippingChargeCents < 0) {
    shippingChargeCents = 0;
    warnings.push('negativeShippingClamped');
  }

  // Build evidence for debugging
  const evidence: EbayOfferPricingEvidence = {
    baseDeliveredTargetCents,
    shippingCostEstimateCents,
    requestedShippingMode: settings.ebayShippingMode,
    effectiveShippingMode,
    buyerShippingChargeCents: settings.buyerShippingChargeCents,
    itemPriceCents,
    targetDeliveredTotalCents,
    minItemPriceCents: settings.minItemPriceCents,
    autoFreeShippingTriggered,
    warnings: [...warnings],
  };

  return {
    targetDeliveredTotalCents,
    itemPriceCents,
    shippingChargeCents,
    shippingCostEstimateCents,
    effectiveShippingMode,
    warnings,
    evidence,
  };
}

/**
 * Format pricing result for logging (one line per product)
 * 
 * WHY: Easy debugging in logs without scrolling through JSON blobs.
 * Format: [pricing] deliveredTarget=$X.XX mode=FREE shippingCharge=$0.00 item=$X.XX shipCostEst=$Y.YY warnings=[...]
 */
export function formatPricingLogLine(result: EbayOfferPricingResult): string {
  const mode = result.effectiveShippingMode === 'FREE_SHIPPING' ? 'FREE' : 'BUYER_PAYS';
  const warnStr = result.warnings.length > 0 ? result.warnings.join(',') : 'none';
  
  return `[pricing] deliveredTarget=$${(result.targetDeliveredTotalCents / 100).toFixed(2)} ` +
    `mode=${mode} ` +
    `shippingCharge=$${(result.shippingChargeCents / 100).toFixed(2)} ` +
    `item=$${(result.itemPriceCents / 100).toFixed(2)} ` +
    `shipCostEst=$${(result.shippingCostEstimateCents / 100).toFixed(2)} ` +
    `warnings=[${warnStr}]`;
}
