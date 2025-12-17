/**
 * Competitive Pricing Configuration - Phase 1
 * 
 * PURPOSE: Define typed configuration for competitive pricing against Amazon "total to door"
 * 
 * DESIGN PRINCIPLES:
 * - Explicit types prevent Copilot from freestyling
 * - Centralized config for easy tuning
 * - No behavior change in Phase 1 (structure only)
 * 
 * PRICING MODEL:
 * 1. Calculate Amazon total: amazonItemPrice + amazonShippingPrice
 * 2. Apply discount: ebayTargetTotal = amazonTotal × (1 - discountPercent/100)
 * 3. Split eBay total using shippingStrategy
 */

/**
 * Shipping strategy for eBay listings
 * 
 * FREE_IF_AMAZON_FREE: Match Amazon's shipping model
 *   - If Amazon has free shipping → eBay free shipping
 *   - If Amazon charges shipping → eBay charges similar shipping
 * 
 * MATCH_AMAZON: Exactly replicate Amazon's shipping cost
 *   - eBay shipping = Amazon shipping
 *   - eBay item price adjusted to hit target total
 * 
 * SELLER_PAYS_UP_TO: Absorb shipping costs up to a threshold
 *   - Seller covers shipping up to sellerPaysUpTo amount
 *   - Buyer pays remainder if Amazon shipping exceeds threshold
 */
export type ShippingStrategy =
  | 'FREE_IF_AMAZON_FREE'
  | 'MATCH_AMAZON'
  | 'SELLER_PAYS_UP_TO';

/**
 * Competitive pricing rules configuration
 */
export interface CompetitivePricingRules {
  /**
   * Discount percentage applied to Amazon total-to-door price
   * Example: 10 means eBay price = Amazon total × 0.90
   */
  discountPercent: number;

  /**
   * Strategy for handling eBay shipping costs
   */
  shippingStrategy: ShippingStrategy;

  /**
   * Maximum shipping cost seller will absorb (cents)
   * Only used when shippingStrategy = 'SELLER_PAYS_UP_TO'
   * Example: 500 = seller covers up to $5.00 shipping
   */
  sellerPaysUpTo?: number;

  /**
   * Safety constraint: never price eBay listing above Amazon total
   * Prevents accidentally pricing higher than competition
   * Default: true (recommended)
   */
  neverExceedAmazonTotal: boolean;
}

/**
 * Get default competitive pricing rules
 * 
 * DEFAULT STRATEGY:
 * - 10% discount vs Amazon total-to-door
 * - Free eBay shipping when Amazon has free shipping
 * - Never exceed Amazon's total price
 * 
 * RATIONALE:
 * - 10% discount: Competitive advantage without race to bottom
 * - FREE_IF_AMAZON_FREE: Matches customer expectations (Prime = free shipping)
 * - neverExceedAmazonTotal: Safety net prevents pricing errors
 */
export function getDefaultCompetitivePricingRules(): CompetitivePricingRules {
  return {
    discountPercent: 10,
    shippingStrategy: 'FREE_IF_AMAZON_FREE',
    neverExceedAmazonTotal: true,
  };
}
