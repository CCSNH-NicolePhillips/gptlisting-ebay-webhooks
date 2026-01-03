/**
 * Comprehensive tests for utils/pricing.ts
 * 
 * NOTE: computeEbayPrice now delegates to getFinalEbayPrice in pricing-compute.ts
 * The formula uses user settings (default: ALGO_COMPETITIVE_TOTAL):
 *   - 10% discount from base price
 *   - Subtract $6 shipping (templateShippingEstimateCents: 600)
 *   - Minimum $1.99 floor
 * 
 * OLD formula was: base * 0.9, then -$5 if >$30
 * NEW formula is: (base * 0.9) - $6
 */

import { computeEbayPrice, computeFloorPrice } from '../../src/utils/pricing';

describe('pricing.ts', () => {
  describe('computeEbayPrice', () => {
    it('should apply 10% discount and $6 shipping deduction', () => {
      // 100 * 0.9 = 90 - 6 = 84
      expect(computeEbayPrice(100)).toBe(84);
      // 50 * 0.9 = 45 - 6 = 39
      expect(computeEbayPrice(50)).toBe(39);
      // 20 * 0.9 = 18 - 6 = 12
      expect(computeEbayPrice(20)).toBe(12);
    });

    it('should apply $6 shipping deduction consistently', () => {
      expect(computeEbayPrice(40)).toBe(30); // 40 * 0.9 - 6 = 36 - 6 = 30
      expect(computeEbayPrice(50)).toBe(39); // 50 * 0.9 - 6 = 45 - 6 = 39
      expect(computeEbayPrice(100)).toBe(84); // 100 * 0.9 - 6 = 90 - 6 = 84
    });

    it('should handle prices around $30 consistently', () => {
      // 30 * 0.9 - 6 = 27 - 6 = 21
      expect(computeEbayPrice(30)).toBe(21);
      // 25 * 0.9 - 6 = 22.5 - 6 = 16.5
      expect(computeEbayPrice(25)).toBe(16.5);
      // 10 * 0.9 - 6 = 9 - 6 = 3
      expect(computeEbayPrice(10)).toBe(3);
    });

    it('should round to 2 decimal places', () => {
      // 33.33 * 0.9 - 6 = 30 - 6 = 24 (approx)
      expect(computeEbayPrice(33.33)).toBeCloseTo(24, 0);
      // 15.99 * 0.9 - 6 = 14.391 - 6 = 8.39
      expect(computeEbayPrice(15.99)).toBeCloseTo(8.39, 2);
      // 22.22 * 0.9 - 6 = 20 - 6 = 14
      expect(computeEbayPrice(22.22)).toBeCloseTo(14, 0);
    });

    it('should return 0 for non-finite values', () => {
      expect(computeEbayPrice(Infinity)).toBe(0);
      expect(computeEbayPrice(-Infinity)).toBe(0);
      expect(computeEbayPrice(NaN)).toBe(0);
    });

    it('should return 0 for zero or negative prices', () => {
      expect(computeEbayPrice(0)).toBe(0);
      expect(computeEbayPrice(-10)).toBe(0);
      expect(computeEbayPrice(-100)).toBe(0);
    });

    it('should enforce minimum price floor of $1.99', () => {
      // Very small base: formula would go negative, but floor is $1.99
      expect(computeEbayPrice(5)).toBe(1.99); // 5 * 0.9 - 6 = -1.5, but min is 1.99
      expect(computeEbayPrice(7)).toBe(1.99); // 7 * 0.9 - 6 = 0.3, but min is 1.99
    });

    it('should handle very small positive prices with floor', () => {
      // 0.01 * 0.9 - 6 would be negative, so floor of $1.99
      expect(computeEbayPrice(0.01)).toBe(1.99);
      // 1 * 0.9 - 6 = -5.1, floor to $1.99
      expect(computeEbayPrice(1)).toBe(1.99);
    });

    it('should handle very large prices', () => {
      expect(computeEbayPrice(1000)).toBe(894); // 1000 * 0.9 - 6 = 900 - 6 = 894
      expect(computeEbayPrice(10000)).toBe(8994); // 10000 * 0.9 - 6 = 9000 - 6 = 8994
    });
  });

  describe('computeFloorPrice', () => {
    it('should apply 20% discount to eBay price', () => {
      expect(computeFloorPrice(100)).toBe(80);
      expect(computeFloorPrice(50)).toBe(40);
      expect(computeFloorPrice(25)).toBe(20);
    });

    it('should round to 2 decimal places', () => {
      expect(computeFloorPrice(33.33)).toBe(26.66); // 33.33 * 0.8 = 26.664 ≈ 26.66
      expect(computeFloorPrice(15.99)).toBe(12.79); // 15.99 * 0.8 = 12.792 ≈ 12.79
      expect(computeFloorPrice(22.22)).toBe(17.78); // 22.22 * 0.8 = 17.776 ≈ 17.78
    });

    it('should handle zero', () => {
      expect(computeFloorPrice(0)).toBe(0);
    });

    it('should handle negative prices (edge case)', () => {
      expect(computeFloorPrice(-10)).toBe(-8); // -10 * 0.8 = -8
    });

    it('should handle very small prices', () => {
      expect(computeFloorPrice(0.01)).toBe(0.01); // 0.01 * 0.8 = 0.008 ≈ 0.01
      expect(computeFloorPrice(1)).toBe(0.8); // 1 * 0.8 = 0.8
    });

    it('should handle very large prices', () => {
      expect(computeFloorPrice(1000)).toBe(800); // 1000 * 0.8 = 800
      expect(computeFloorPrice(10000)).toBe(8000); // 10000 * 0.8 = 8000
    });

    it('should work with eBay price output', () => {
      const ebayPrice = computeEbayPrice(100); // 84 (new formula)
      const floorPrice = computeFloorPrice(ebayPrice); // 84 * 0.8 = 67.2
      expect(floorPrice).toBe(67.2);
    });

    it('should handle rounding edge cases', () => {
      expect(computeFloorPrice(12.49)).toBe(9.99); // 12.49 * 0.8 = 9.992 ≈ 9.99
      expect(computeFloorPrice(12.50)).toBe(10); // 12.50 * 0.8 = 10
      expect(computeFloorPrice(12.51)).toBe(10.01); // 12.51 * 0.8 = 10.008 ≈ 10.01
    });
  });

  describe('integration tests', () => {
    it('should calculate complete price chain from base to floor', () => {
      const base = 50;
      const ebay = computeEbayPrice(base); // 50 * 0.9 - 6 = 39
      const floor = computeFloorPrice(ebay); // 39 * 0.8 = 31.2
      
      expect(ebay).toBe(39);
      expect(floor).toBe(31.2);
    });

    it('should calculate complete price chain for $100', () => {
      const base = 100;
      const ebay = computeEbayPrice(base); // 100 * 0.9 - 6 = 84
      const floor = computeFloorPrice(ebay); // 84 * 0.8 = 67.2
      
      expect(ebay).toBe(84);
      expect(floor).toBe(67.2);
    });

    it('should handle $30 base in full chain', () => {
      const base = 30;
      const ebay = computeEbayPrice(base); // 30 * 0.9 - 6 = 21
      const floor = computeFloorPrice(ebay); // 21 * 0.8 = 16.8
      
      expect(ebay).toBe(21);
      expect(floor).toBe(16.8);
    });
  });
});