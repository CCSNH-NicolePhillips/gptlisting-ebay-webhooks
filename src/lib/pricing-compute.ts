/**
 * Competitive Pricing Computation - Phase 2
 * 
 * PURPOSE: Pure functions for computing Amazon total-to-door and eBay target pricing
 * 
 * DESIGN PRINCIPLES:
 * - Pure functions (no side effects)
 * - Deterministic rounding
 * - Easy to test and reason about
 * - Not wired into production yet (Phase 2 is math only)
 */

/**
 * Round to cents (2 decimal places)
 * Uses standard banker's rounding (round half to even)
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
 * Compute Amazon total-to-door and eBay target total
 * 
 * FORMULA:
 * 1. amazonTotal = amazonItemPrice + amazonShippingPrice
 * 2. ebayTargetTotal = amazonTotal × (1 - discountPercent/100)
 * 3. Round both to cents
 * 
 * @param input - Pricing input parameters
 * @param input.amazonItemPrice - Amazon item price (before shipping)
 * @param input.amazonShippingPrice - Amazon shipping cost (0 if free shipping)
 * @param input.discountPercent - Discount percentage (e.g., 10 for 10% off)
 * @returns Object with amazonTotal and ebayTargetTotal
 * 
 * @example
 * // Free shipping scenario
 * computeAmazonTotals({
 *   amazonItemPrice: 16.99,
 *   amazonShippingPrice: 0,
 *   discountPercent: 10
 * })
 * // Returns: { amazonTotal: 16.99, ebayTargetTotal: 15.29 }
 * 
 * @example
 * // Paid shipping scenario
 * computeAmazonTotals({
 *   amazonItemPrice: 16.99,
 *   amazonShippingPrice: 5.99,
 *   discountPercent: 10
 * })
 * // Returns: { amazonTotal: 22.98, ebayTargetTotal: 20.68 }
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
