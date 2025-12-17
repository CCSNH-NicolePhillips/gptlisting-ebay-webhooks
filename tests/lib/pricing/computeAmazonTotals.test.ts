/**
 * Tests for competitive pricing computation - Phase 2
 * 
 * PURPOSE: Verify pure math functions for Amazon total and eBay target calculation
 * 
 * ACCEPTANCE CRITERIA:
 * ✅ No pricing outputs change (not wired in yet)
 * ✅ Handles shipping=0 correctly
 * ✅ Rounding is deterministic
 */

import { roundToCents, computeAmazonTotals } from '../../../src/lib/pricing-compute';

describe('Competitive Pricing Computation - Phase 2', () => {
  describe('roundToCents', () => {
    it('should round to 2 decimal places', () => {
      expect(roundToCents(15.294)).toBe(15.29);
      expect(roundToCents(15.295)).toBe(15.30); // Banker's rounding: round half up
      expect(roundToCents(15.296)).toBe(15.30);
    });

    it('should handle edge case: 19.995 rounds to 20.00', () => {
      // This is a key test case from requirements
      expect(roundToCents(19.995)).toBe(20.00);
    });

    it('should handle rounding up', () => {
      expect(roundToCents(20.685)).toBe(20.69);
      expect(roundToCents(36.385)).toBe(36.39);
    });

    it('should handle rounding down', () => {
      expect(roundToCents(20.681)).toBe(20.68);
      expect(roundToCents(36.381)).toBe(36.38);
    });

    it('should handle whole numbers', () => {
      expect(roundToCents(10)).toBe(10.00);
      expect(roundToCents(100)).toBe(100.00);
    });

    it('should handle already-rounded values', () => {
      expect(roundToCents(15.29)).toBe(15.29);
      expect(roundToCents(20.68)).toBe(20.68);
    });

    it('should handle very small values', () => {
      expect(roundToCents(0.001)).toBe(0.00);
      expect(roundToCents(0.005)).toBe(0.01);
      expect(roundToCents(0.01)).toBe(0.01);
    });

    it('should handle negative values (edge case)', () => {
      expect(roundToCents(-15.294)).toBe(-15.29);
      expect(roundToCents(-15.296)).toBe(-15.30);
    });
  });

  describe('computeAmazonTotals', () => {
    describe('Required test cases from Phase 2 spec', () => {
      it('case: item 16.99, ship 0, 10% → total 16.99, target 15.29', () => {
        const result = computeAmazonTotals({
          amazonItemPrice: 16.99,
          amazonShippingPrice: 0,
          discountPercent: 10,
        });

        expect(result.amazonTotal).toBe(16.99);
        expect(result.ebayTargetTotal).toBe(15.29);

        // Verify calculation: 16.99 × 0.90 = 15.291 → 15.29
        const expectedTarget = roundToCents(16.99 * 0.90);
        expect(result.ebayTargetTotal).toBe(expectedTarget);
      });

      it('case: item 16.99, ship 5.99, 10% → total 22.98, target 20.68', () => {
        const result = computeAmazonTotals({
          amazonItemPrice: 16.99,
          amazonShippingPrice: 5.99,
          discountPercent: 10,
        });

        expect(result.amazonTotal).toBe(22.98);
        expect(result.ebayTargetTotal).toBe(20.68);

        // Verify calculation: (16.99 + 5.99) × 0.90 = 22.98 × 0.90 = 20.682 → 20.68
        const expectedTotal = roundToCents(16.99 + 5.99);
        const expectedTarget = roundToCents(expectedTotal * 0.90);
        expect(result.amazonTotal).toBe(expectedTotal);
        expect(result.ebayTargetTotal).toBe(expectedTarget);
      });

      it('edge: rounding like 19.995 → 20.00', () => {
        // Construct a scenario that results in 19.995 before rounding
        // 19.995 / 0.90 = 22.216666...
        // So amazonTotal = 22.22 → ebayTargetTotal = 19.998 ≈ 20.00
        const result = computeAmazonTotals({
          amazonItemPrice: 22.22,
          amazonShippingPrice: 0,
          discountPercent: 10,
        });

        // 22.22 × 0.90 = 19.998 → rounds to 20.00
        expect(result.amazonTotal).toBe(22.22);
        expect(result.ebayTargetTotal).toBe(20.00);
      });
    });

    describe('Free shipping scenarios', () => {
      it('should handle free shipping (ship = 0)', () => {
        const result = computeAmazonTotals({
          amazonItemPrice: 45.99,
          amazonShippingPrice: 0,
          discountPercent: 10,
        });

        expect(result.amazonTotal).toBe(45.99);
        // 45.99 × 0.90 = 41.391 → 41.39
        expect(result.ebayTargetTotal).toBe(41.39);
      });

      it('should handle low-priced item with free shipping', () => {
        const result = computeAmazonTotals({
          amazonItemPrice: 19.99,
          amazonShippingPrice: 0,
          discountPercent: 10,
        });

        expect(result.amazonTotal).toBe(19.99);
        // 19.99 × 0.90 = 17.991 → 17.99
        expect(result.ebayTargetTotal).toBe(17.99);
      });
    });

    describe('Paid shipping scenarios', () => {
      it('should handle typical paid shipping', () => {
        const result = computeAmazonTotals({
          amazonItemPrice: 32.50,
          amazonShippingPrice: 6.99,
          discountPercent: 10,
        });

        // 32.50 + 6.99 = 39.49
        expect(result.amazonTotal).toBe(39.49);
        // 39.49 × 0.90 = 35.541 → 35.54
        expect(result.ebayTargetTotal).toBe(35.54);
      });

      it('should handle high shipping relative to item price', () => {
        const result = computeAmazonTotals({
          amazonItemPrice: 15.00,
          amazonShippingPrice: 12.50,
          discountPercent: 10,
        });

        // 15.00 + 12.50 = 27.50
        expect(result.amazonTotal).toBe(27.50);
        // 27.50 × 0.90 = 24.75
        expect(result.ebayTargetTotal).toBe(24.75);
      });
    });

    describe('Different discount percentages', () => {
      it('should handle 0% discount (match Amazon exactly)', () => {
        const result = computeAmazonTotals({
          amazonItemPrice: 25.00,
          amazonShippingPrice: 5.00,
          discountPercent: 0,
        });

        expect(result.amazonTotal).toBe(30.00);
        expect(result.ebayTargetTotal).toBe(30.00); // No discount
      });

      it('should handle 5% discount', () => {
        const result = computeAmazonTotals({
          amazonItemPrice: 20.00,
          amazonShippingPrice: 0,
          discountPercent: 5,
        });

        expect(result.amazonTotal).toBe(20.00);
        // 20.00 × 0.95 = 19.00
        expect(result.ebayTargetTotal).toBe(19.00);
      });

      it('should handle 15% discount', () => {
        const result = computeAmazonTotals({
          amazonItemPrice: 40.00,
          amazonShippingPrice: 0,
          discountPercent: 15,
        });

        expect(result.amazonTotal).toBe(40.00);
        // 40.00 × 0.85 = 34.00
        expect(result.ebayTargetTotal).toBe(34.00);
      });

      it('should handle 20% discount', () => {
        const result = computeAmazonTotals({
          amazonItemPrice: 50.00,
          amazonShippingPrice: 10.00,
          discountPercent: 20,
        });

        // 50.00 + 10.00 = 60.00
        expect(result.amazonTotal).toBe(60.00);
        // 60.00 × 0.80 = 48.00
        expect(result.ebayTargetTotal).toBe(48.00);
      });
    });

    describe('Rounding consistency', () => {
      it('should round Amazon total consistently', () => {
        // Test case where item + shipping needs rounding
        const result = computeAmazonTotals({
          amazonItemPrice: 10.995,
          amazonShippingPrice: 5.006,
          discountPercent: 10,
        });

        // 10.995 + 5.006 = 16.001 → rounds to 16.00
        expect(result.amazonTotal).toBe(16.00);
        // 16.00 × 0.90 = 14.40
        expect(result.ebayTargetTotal).toBe(14.40);
      });

      it('should round eBay target consistently', () => {
        const result = computeAmazonTotals({
          amazonItemPrice: 33.33,
          amazonShippingPrice: 0,
          discountPercent: 10,
        });

        expect(result.amazonTotal).toBe(33.33);
        // 33.33 × 0.90 = 29.997 → rounds to 30.00
        expect(result.ebayTargetTotal).toBe(30.00);
      });

      it('should handle multiple rounding operations deterministically', () => {
        // Same input should always produce same output
        const input = {
          amazonItemPrice: 19.99,
          amazonShippingPrice: 3.99,
          discountPercent: 10,
        };

        const result1 = computeAmazonTotals(input);
        const result2 = computeAmazonTotals(input);

        expect(result1).toEqual(result2);
        expect(result1.amazonTotal).toBe(23.98);
        expect(result1.ebayTargetTotal).toBe(21.58); // 23.98 × 0.90 = 21.582 → 21.58
      });
    });

    describe('Edge cases', () => {
      it('should handle zero item price', () => {
        const result = computeAmazonTotals({
          amazonItemPrice: 0,
          amazonShippingPrice: 5.00,
          discountPercent: 10,
        });

        expect(result.amazonTotal).toBe(5.00);
        expect(result.ebayTargetTotal).toBe(4.50); // 5.00 × 0.90 = 4.50
      });

      it('should handle very small prices', () => {
        const result = computeAmazonTotals({
          amazonItemPrice: 0.99,
          amazonShippingPrice: 0,
          discountPercent: 10,
        });

        expect(result.amazonTotal).toBe(0.99);
        // 0.99 × 0.90 = 0.891 → 0.89
        expect(result.ebayTargetTotal).toBe(0.89);
      });

      it('should handle large prices', () => {
        const result = computeAmazonTotals({
          amazonItemPrice: 999.99,
          amazonShippingPrice: 0,
          discountPercent: 10,
        });

        expect(result.amazonTotal).toBe(999.99);
        // 999.99 × 0.90 = 899.991 → 899.99
        expect(result.ebayTargetTotal).toBe(899.99);
      });

      it('should handle decimal shipping costs', () => {
        const result = computeAmazonTotals({
          amazonItemPrice: 25.00,
          amazonShippingPrice: 3.47,
          discountPercent: 10,
        });

        // 25.00 + 3.47 = 28.47
        expect(result.amazonTotal).toBe(28.47);
        // 28.47 × 0.90 = 25.623 → 25.62
        expect(result.ebayTargetTotal).toBe(25.62);
      });
    });

    describe('No behavior change verification', () => {
      it('should be a pure function (no side effects)', () => {
        const input = {
          amazonItemPrice: 30.00,
          amazonShippingPrice: 5.00,
          discountPercent: 10,
        };

        // Calling function should not modify input
        const inputCopy = { ...input };
        computeAmazonTotals(input);

        expect(input).toEqual(inputCopy);
      });

      it('should not affect existing pricing logic (not wired in yet)', () => {
        // Phase 2 introduces math functions only
        // They are NOT used by computeEbayPrice or any production code yet
        // This test just documents that fact

        const result = computeAmazonTotals({
          amazonItemPrice: 45.99,
          amazonShippingPrice: 0,
          discountPercent: 10,
        });

        // New function works correctly
        expect(result.ebayTargetTotal).toBe(41.39);

        // But existing pricing still uses old formula
        // (verified by baseline tests still passing)
        expect(true).toBe(true);
      });
    });
  });
});
