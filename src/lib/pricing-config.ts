/**
 * Competitive Pricing Configuration - Phase 1
 * 
 * PURPOSE: Define typed configuration for competitive pricing against Amazon "total to door"
 * 
 * DESIGN PRINCIPLES:
 * - Explicit types prevent Copilot from freestyling
 * - Centralized config for easy tuning
 * - User-configurable settings stored per user
 * 
 * PRICING MODEL:
 * 1. Calculate Amazon total: amazonItemPrice + amazonShippingPrice
 * 2. Apply discount: ebayTargetTotal = amazonTotal × (1 - discountPercent/100)
 * 3. Split eBay total using shippingStrategy
 * 
 * IMPORTANT: This system never modifies eBay shipping templates/policies; it only computes item price.
 */

/**
 * Shipping strategy for eBay listings
 * 
 * ALGO_COMPETITIVE_TOTAL: Algorithmic split - absorb shipping intelligently
 *   - Analyze Amazon item/shipping breakdown
 *   - Keep eBay item price competitive
 *   - Absorb shipping by reducing item price (buyer still pays template shipping)
 * 
 * DISCOUNT_ITEM_ONLY: Simplest strategy - discount item price only
 *   - Apply discount only to Amazon item price
 *   - Use templateShippingEstimateCents for eBay shipping
 *   - Predictable, conservative approach
 */
export type ShippingStrategy =
  | 'ALGO_COMPETITIVE_TOTAL'
  | 'DISCOUNT_ITEM_ONLY';

/**
 * User pricing settings (stored per user, configurable in UI)
 */
export interface PricingSettings {
  /**
   * Discount percentage applied to Amazon total-to-door price
   * Example: 10 means eBay price = Amazon total × 0.90
   * Default: 10
   */
  discountPercent: number;

  /**
   * Strategy for handling eBay shipping costs
   * Default: 'ALGO_COMPETITIVE_TOTAL'
   */
  shippingStrategy: ShippingStrategy;

  /**
   * Estimated shipping charged by the template (used for competitiveness calculations)
   * Example: 600 = $6.00 flat shipping
   * Default: 600
   */
  templateShippingEstimateCents: number;

  /**
   * Maximum shipping subsidy seller will absorb (cents)
   * Optional cap on how much shipping to absorb when strategy is ALGO_COMPETITIVE_TOTAL
   * Example: 500 = seller covers up to $5.00 shipping
   * Default: null (no cap)
   */
  shippingSubsidyCapCents: number | null;

  /**
   * Minimum eBay item price floor (cents)
   * Prevents pricing from going negative or unreasonably low
   * Example: 199 = $1.99 minimum item price
   * Default: 199
   */
  minItemPriceCents: number;
}

/**
 * Get default pricing settings for new users
 * 
 * DEFAULT STRATEGY:
 * - 10% discount vs Amazon total-to-door
 * - ALGO_COMPETITIVE_TOTAL: Smart pricing that accounts for shipping
 * - $6.00 template shipping (common USPS Priority Mail cost)
 * - No subsidy cap
 * - $1.99 minimum item price floor
 * 
 * RATIONALE:
 * - 10% discount: Competitive advantage without race to bottom
 * - ALGO_COMPETITIVE_TOTAL: Accounts for competitor shipping in pricing
 * - $6.00 shipping: Typical small package cost, conservative estimate
 * - $1.99 floor: Prevents negative or unrealistic pricing
 */
export function getDefaultPricingSettings(): PricingSettings {
  return {
    discountPercent: 10,
    shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
    templateShippingEstimateCents: 600,
    shippingSubsidyCapCents: null,
    minItemPriceCents: 199,
  };
}
