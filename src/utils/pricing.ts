import { getFinalEbayPrice } from '../lib/pricing-compute.js';

/**
 * @deprecated Use getFinalEbayPrice from pricing-compute.ts directly.
 * This wrapper exists only for backward compatibility.
 */
export function computeEbayPrice(base: number) {
  return getFinalEbayPrice(base);
}

export function computeFloorPrice(ebayPrice: number) {
  // floor = 20% off the final eBay price
  const floor = ebayPrice * 0.8;
  return Math.round(floor * 100) / 100;
}
