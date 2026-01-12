# Pricing Types Summary

> Extracted from source files on January 5, 2026

## DeliveredPricingSettings (from `delivered-pricing.ts`)

```typescript
export type PricingMode = 'market-match' | 'fast-sale' | 'max-margin';

/**
 * What to do when we cannot compete on price
 * - FLAG_ONLY: Create listing but add cannotCompete warning (soft rollout)
 * - AUTO_SKIP: Don't create listing, return skipListing: true
 * - ALLOW_ANYWAY: Create listing even if overpriced (user's choice)
 */
export type LowPriceMode = 'FLAG_ONLY' | 'AUTO_SKIP' | 'ALLOW_ANYWAY';

export interface DeliveredPricingSettings {
  mode: PricingMode;
  shippingEstimateCents: number;
  minItemCents: number;
  undercutCents: number;           // For fast-sale mode
  
  // Free shipping controls
  allowFreeShippingWhenNeeded: boolean;  // Auto-enable free ship to hit market price
  freeShippingMaxSubsidyCents: number;   // Max we'll absorb for free shipping
  
  // What to do when we can't compete
  lowPriceMode: LowPriceMode;
  
  // Phase 4: Smart shipping
  useSmartShipping: boolean;       // Use category/comp-based shipping
  shippingSettings?: ShippingSettings;
}

export const DEFAULT_PRICING_SETTINGS: DeliveredPricingSettings = {
  mode: 'market-match',
  shippingEstimateCents: 600,          // $6.00 default shipping template
  minItemCents: 499,                   // $4.99 item price floor
  undercutCents: 100,                  // $1.00 undercut for fast-sale
  
  // Smart defaults: enable free shipping to compete
  allowFreeShippingWhenNeeded: true,   // Auto-enable free ship when market demands it
  freeShippingMaxSubsidyCents: 500,    // Max $5.00 subsidy (prevents losing money)
  lowPriceMode: 'FLAG_ONLY',           // Soft rollout: flag but don't skip
  
  useSmartShipping: true,              // Use category/comp-based shipping
};
```

---

## PricingSettings (from `pricing-config.ts`)

This is the **UI settings model** - user-configurable settings stored per user.

```typescript
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
 * DISCOUNT_ITEM_ONLY: Simplest strategy - discount item price only
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
```

---

## Key Differences

| Aspect | `DeliveredPricingSettings` | `PricingSettings` |
|--------|---------------------------|-------------------|
| **Purpose** | Backend pricing engine config | User-facing UI settings |
| **Location** | `delivered-pricing.ts` | `pricing-config.ts` |
| **Mode** | `PricingMode` (market-match, fast-sale, max-margin) | `ShippingStrategy` (ALGO_COMPETITIVE_TOTAL, DISCOUNT_ITEM_ONLY) |
| **Shipping** | `shippingEstimateCents` (single value) | `templateShippingEstimateCents` + `buyerShippingChargeCents` (split) |
| **Shipping Mode** | Implicit (uses `allowFreeShippingWhenNeeded`) | Explicit `ebayShippingMode` enum |
| **Low Price Handling** | `lowPriceMode` (FLAG_ONLY, AUTO_SKIP, ALLOW_ANYWAY) | `allowAutoFreeShippingOnLowPrice` (boolean) |

## Which to Use?

- **`PricingSettings`** → Used by `computeEbayOfferPricingCents()` for the final item/shipping split
- **`DeliveredPricingSettings`** → Used by `getDeliveredPricing()` for comp-based market pricing
