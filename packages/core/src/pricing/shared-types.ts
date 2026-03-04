/**
 * Shared pricing types used by both delivered-pricing.ts and shipping-estimates.ts.
 *
 * This module exists to break the circular import:
 *   delivered-pricing.ts  (imports ShippingEstimate from shipping-estimates.ts)
 *   shipping-estimates.ts (needs CompetitorPrice, which was defined in delivered-pricing.ts)
 *
 * Both modules now import CompetitorPrice from here instead.
 */

export interface CompetitorPrice {
  source: 'amazon' | 'walmart' | 'ebay' | 'target' | 'other';
  itemCents: number;
  shipCents: number;        // 0 if free shipping
  deliveredCents: number;   // item + ship
  title: string;
  url: string | null;
  inStock: boolean;
  seller: string;
}
