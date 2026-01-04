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
 * 
 * SHIPPING MODE EXPLAINED:
 * ========================
 * FREE_SHIPPING: Buyer pays $0 shipping. Item price = full delivered total.
 *   - eBay fulfillment policy must be set to "free shipping"
 *   - Seller absorbs shipping cost (shippingCostEstimateCents)
 * 
 * BUYER_PAYS_SHIPPING: Buyer pays item + shipping separately.
 *   - eBay fulfillment policy charges buyer (calculated or flat rate)
 *   - Item price = delivered total - buyerShippingChargeCents
 *   - Risk: If estimate doesn't match eBay's calculated shipping, total differs
 */

/**
 * eBay shipping mode - determines how shipping cost is presented to buyer
 * 
 * FREE_SHIPPING: Buyer pays $0 shipping, we bake shipping into item price
 * BUYER_PAYS_SHIPPING: Buyer pays item + shipping separately via eBay policy
 */
export type EbayShippingMode = 'FREE_SHIPPING' | 'BUYER_PAYS_SHIPPING';

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

  /**
   * eBay shipping mode - determines how shipping is presented to buyer
   * 
   * FREE_SHIPPING: Buyer pays $0 shipping, item price = full delivered total
   * BUYER_PAYS_SHIPPING: Buyer pays item + shipping separately
   * 
   * Default: 'BUYER_PAYS_SHIPPING'
   */
  ebayShippingMode: EbayShippingMode;

  /**
   * Shipping charge shown to buyer when BUYER_PAYS_SHIPPING (cents)
   * 
   * ⚠️ IMPORTANT: This is what the BUYER pays, NOT what we pay the carrier.
   * What we pay the carrier is shippingCostEstimateCents (used internally).
   * 
   * Example: 600 = buyer sees "$6.00 shipping" on eBay
   * Default: 600
   */
  buyerShippingChargeCents: number;

  /**
   * If BUYER_PAYS_SHIPPING would force item price below minItemPriceCents,
   * automatically switch to FREE_SHIPPING mode.
   * 
   * WHY: Prevents ugly "$1.99 + $6.00 shipping" listings that look scammy.
   * Better to show "$7.99 free shipping" even though same total.
   * 
   * Default: true
   */
  allowAutoFreeShippingOnLowPrice: boolean;
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
 * - BUYER_PAYS_SHIPPING: Buyer pays item + shipping separately (most common)
 * - $6.00 buyer shipping charge
 * - Auto-switch to free shipping if item price too low
 * 
 * RATIONALE:
 * - 10% discount: Competitive advantage without race to bottom
 * - ALGO_COMPETITIVE_TOTAL: Accounts for competitor shipping in pricing
 * - $6.00 shipping: Typical small package cost, conservative estimate
 * - $1.99 floor: Prevents negative or unrealistic pricing
 * - BUYER_PAYS_SHIPPING: Most sellers use calculated/flat shipping
 * - Auto free shipping: Prevents scammy-looking low item + high shipping combos
 */
export function getDefaultPricingSettings(): PricingSettings {
  return {
    discountPercent: 10,
    shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
    templateShippingEstimateCents: 600,
    shippingSubsidyCapCents: null,
    minItemPriceCents: 199,
    ebayShippingMode: 'BUYER_PAYS_SHIPPING',
    buyerShippingChargeCents: 600,
    allowAutoFreeShippingOnLowPrice: true,
  };
}
