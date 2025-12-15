/**
 * Comprehensive tests for utils/pricing.ts
 * Target: 100% code coverage
 */

import { computeEbayPrice, computeFloorPrice } from '../../src/utils/pricing';

describe('pricing.ts', () => {
  describe('computeEbayPrice', () => {
    it('should apply 10% discount to base price', () => {
      // 100 * 0.9 = 90, but >30 so -5 = 85
      expect(computeEbayPrice(100)).toBe(85);
      // 50 * 0.9 = 45, but >30 so -5 = 40
      expect(computeEbayPrice(50)).toBe(40);
      expect(computeEbayPrice(20)).toBe(18);
    });

    it('should apply additional $5 discount for prices > $30', () => {
      expect(computeEbayPrice(40)).toBe(31); // 40 * 0.9 - 5 = 36 - 5 = 31
      expect(computeEbayPrice(50)).toBe(40); // 50 * 0.9 - 5 = 45 - 5 = 40
      expect(computeEbayPrice(100)).toBe(85); // 100 * 0.9 - 5 = 90 - 5 = 85
    });

    it('should not apply $5 discount for prices <= $30', () => {
      expect(computeEbayPrice(30)).toBe(27); // 30 * 0.9 = 27 (no extra $5 off)
      expect(computeEbayPrice(25)).toBe(22.5); // 25 * 0.9 = 22.5
      expect(computeEbayPrice(10)).toBe(9); // 10 * 0.9 = 9
    });

    it('should round to 2 decimal places', () => {
      expect(computeEbayPrice(33.33)).toBe(25); // 33.33 * 0.9 - 5 = 29.997 - 5 = 24.997 ≈ 25
      expect(computeEbayPrice(15.99)).toBe(14.39); // 15.99 * 0.9 = 14.391 ≈ 14.39
      expect(computeEbayPrice(22.22)).toBe(20); // 22.22 * 0.9 = 19.998 ≈ 20
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

    it('should handle edge case at $30 boundary', () => {
      expect(computeEbayPrice(30)).toBe(27); // Exactly 30: 30 * 0.9 = 27
      expect(computeEbayPrice(30.01)).toBe(22.01); // Just over 30: 30.01 * 0.9 - 5 = 27.009 - 5 = 22.009 ≈ 22.01
    });

    it('should handle very small prices', () => {
      expect(computeEbayPrice(0.01)).toBe(0.01); // 0.01 * 0.9 = 0.009 ≈ 0.01
      expect(computeEbayPrice(1)).toBe(0.9); // 1 * 0.9 = 0.9
    });

    it('should handle very large prices', () => {
      expect(computeEbayPrice(1000)).toBe(895); // 1000 * 0.9 - 5 = 900 - 5 = 895
      expect(computeEbayPrice(10000)).toBe(8995); // 10000 * 0.9 - 5 = 9000 - 5 = 8995
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
      const ebayPrice = computeEbayPrice(100); // 85
      const floorPrice = computeFloorPrice(ebayPrice); // 85 * 0.8 = 68
      expect(floorPrice).toBe(68);
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
      const ebay = computeEbayPrice(base); // 50 * 0.9 = 45, but >30 so -5 = 40
      const floor = computeFloorPrice(ebay); // 40 * 0.8 = 32
      
      expect(ebay).toBe(40);
      expect(floor).toBe(32);
    });

    it('should calculate complete price chain for > $30', () => {
      const base = 100;
      const ebay = computeEbayPrice(base); // 100 * 0.9 - 5 = 85
      const floor = computeFloorPrice(ebay); // 85 * 0.8 = 68
      
      expect(ebay).toBe(85);
      expect(floor).toBe(68);
    });

    it('should handle edge case at $30 boundary in full chain', () => {
      const base = 30;
      const ebay = computeEbayPrice(base); // 30 * 0.9 = 27
      const floor = computeFloorPrice(ebay); // 27 * 0.8 = 21.6
      
      expect(ebay).toBe(27);
      expect(floor).toBe(21.6);
    });
  });
});
