/**
 * Tests for pricing-compute.ts - Phase 2
 * 
 * Coverage:
 * - computeEbayItemPrice function with both strategies
 * - AC scenarios from Phase 2 requirements
 * - Rounding behavior
 * - Minimum price enforcement
 * - Evidence tracking
 */

import {
  computeEbayItemPrice,
  roundToCents,
  type ComputeEbayItemPriceInput,
} from '../../src/lib/pricing-compute.js';

describe('pricing-compute Phase 2', () => {
  describe('roundToCents', () => {
    it('should round to 2 decimal places', () => {
      expect(roundToCents(19.995)).toBe(20.00);
      expect(roundToCents(15.294)).toBe(15.29);
      expect(roundToCents(20.685)).toBe(20.69);
    });

    it('should handle exact cents', () => {
      expect(roundToCents(10.50)).toBe(10.50);
      expect(roundToCents(25.00)).toBe(25.00);
    });
  });

  describe('computeEbayItemPrice - AC Scenario 1', () => {
    it('should compute ALGO_COMPETITIVE_TOTAL for Amazon $57.00 free shipping, 10% discount', () => {
      const input: ComputeEbayItemPriceInput = {
        amazonItemPriceCents: 5700,
        amazonShippingCents: 0,
        discountPercent: 10,
        shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
        templateShippingEstimateCents: 600,
        shippingSubsidyCapCents: null,
      };

      const result = computeEbayItemPrice(input);

      // Target delivered total = 57.00 * 0.9 = 51.30
      // Item price = 51.30 - 6.00 = 45.30
      expect(result.ebayItemPriceCents).toBe(4530);
      expect(result.evidence.targetDeliveredTotalDollars).toBe(51.30);
      expect(result.evidence.ebayItemPriceDollars).toBe(45.30);
      expect(result.evidence.shippingStrategy).toBe('ALGO_COMPETITIVE_TOTAL');
      expect(result.evidence.minItemPriceApplied).toBe(false);
    });

    it('should compute DISCOUNT_ITEM_ONLY for Amazon $57.00 free shipping, 10% discount', () => {
      const input: ComputeEbayItemPriceInput = {
        amazonItemPriceCents: 5700,
        amazonShippingCents: 0,
        discountPercent: 10,
        shippingStrategy: 'DISCOUNT_ITEM_ONLY',
        templateShippingEstimateCents: 600,
        shippingSubsidyCapCents: null,
      };

      const result = computeEbayItemPrice(input);

      // Item price = 57.00 * 0.9 = 51.30
      // Note: Same as ALGO when Amazon shipping is 0
      expect(result.ebayItemPriceCents).toBe(5130);
      expect(result.evidence.ebayItemPriceDollars).toBe(51.30);
      expect(result.evidence.shippingStrategy).toBe('DISCOUNT_ITEM_ONLY');
    });
  });

  describe('computeEbayItemPrice - AC Scenario 2', () => {
    it('should compute ALGO_COMPETITIVE_TOTAL for Amazon $57.00 + $5.99 shipping, 10% discount', () => {
      const input: ComputeEbayItemPriceInput = {
        amazonItemPriceCents: 5700,
        amazonShippingCents: 599,
        discountPercent: 10,
        shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
        templateShippingEstimateCents: 600,
        shippingSubsidyCapCents: null,
      };

      const result = computeEbayItemPrice(input);

      // Amazon total = 57.00 + 5.99 = 62.99
      // Target delivered total = 62.99 * 0.9 = 56.691 → 56.69
      // Item price = 56.69 - 6.00 = 50.69
      expect(result.evidence.amazonTotalDollars).toBe(62.99);
      expect(result.evidence.targetDeliveredTotalDollars).toBe(56.69);
      expect(result.ebayItemPriceCents).toBe(5069);
      expect(result.evidence.ebayItemPriceDollars).toBe(50.69);
    });

    it('should compute DISCOUNT_ITEM_ONLY for Amazon $57.00 + $5.99 shipping, 10% discount', () => {
      const input: ComputeEbayItemPriceInput = {
        amazonItemPriceCents: 5700,
        amazonShippingCents: 599,
        discountPercent: 10,
        shippingStrategy: 'DISCOUNT_ITEM_ONLY',
        templateShippingEstimateCents: 600,
        shippingSubsidyCapCents: null,
      };

      const result = computeEbayItemPrice(input);

      // Item price = 57.00 * 0.9 = 51.30
      // (Ignores Amazon shipping)
      expect(result.ebayItemPriceCents).toBe(5130);
      expect(result.evidence.ebayItemPriceDollars).toBe(51.30);
      expect(result.evidence.amazonShippingDollars).toBe(5.99);
    });
  });

  describe('computeEbayItemPrice - Rounding behavior', () => {
    it('should round intermediate calculations correctly', () => {
      const input: ComputeEbayItemPriceInput = {
        amazonItemPriceCents: 1999, // $19.99
        amazonShippingCents: 0,
        discountPercent: 15,
        shippingStrategy: 'DISCOUNT_ITEM_ONLY',
        templateShippingEstimateCents: 600,
        shippingSubsidyCapCents: null,
      };

      const result = computeEbayItemPrice(input);

      // 19.99 * 0.85 = 16.9915 → rounds to 16.99
      expect(result.ebayItemPriceCents).toBe(1699);
      expect(result.evidence.ebayItemPriceDollars).toBe(16.99);
    });

    it('should handle cents-level rounding correctly', () => {
      const input: ComputeEbayItemPriceInput = {
        amazonItemPriceCents: 3333, // $33.33
        amazonShippingCents: 0,
        discountPercent: 10,
        shippingStrategy: 'DISCOUNT_ITEM_ONLY',
        templateShippingEstimateCents: 600,
        shippingSubsidyCapCents: null,
      };

      const result = computeEbayItemPrice(input);

      // 33.33 * 0.9 = 29.997 → rounds to 30.00
      expect(result.ebayItemPriceCents).toBe(3000);
      expect(result.evidence.ebayItemPriceDollars).toBe(30.00);
    });
  });

  describe('computeEbayItemPrice - Minimum price enforcement', () => {
    it('should apply minimum price floor when result is below minimum', () => {
      const input: ComputeEbayItemPriceInput = {
        amazonItemPriceCents: 1000, // $10.00
        amazonShippingCents: 0,
        discountPercent: 50,
        shippingStrategy: 'DISCOUNT_ITEM_ONLY',
        templateShippingEstimateCents: 600,
        shippingSubsidyCapCents: null,
        minItemPriceCents: 700, // $7.00 minimum
      };

      const result = computeEbayItemPrice(input);

      // Without min: 10.00 * 0.5 = 5.00
      // With min: floor at 7.00
      expect(result.ebayItemPriceCents).toBe(700);
      expect(result.evidence.ebayItemPriceDollars).toBe(7.00);
      expect(result.evidence.minItemPriceApplied).toBe(true);
      expect(result.evidence.minItemPriceDollars).toBe(7.00);
    });

    it('should not apply minimum price when result is above minimum', () => {
      const input: ComputeEbayItemPriceInput = {
        amazonItemPriceCents: 2000, // $20.00
        amazonShippingCents: 0,
        discountPercent: 10,
        shippingStrategy: 'DISCOUNT_ITEM_ONLY',
        templateShippingEstimateCents: 600,
        shippingSubsidyCapCents: null,
        minItemPriceCents: 500, // $5.00 minimum
      };

      const result = computeEbayItemPrice(input);

      // 20.00 * 0.9 = 18.00 (above $5.00 minimum)
      expect(result.ebayItemPriceCents).toBe(1800);
      expect(result.evidence.ebayItemPriceDollars).toBe(18.00);
      expect(result.evidence.minItemPriceApplied).toBe(false);
    });

    it('should handle null minimum price', () => {
      const input: ComputeEbayItemPriceInput = {
        amazonItemPriceCents: 1000,
        amazonShippingCents: 0,
        discountPercent: 50,
        shippingStrategy: 'DISCOUNT_ITEM_ONLY',
        templateShippingEstimateCents: 600,
        shippingSubsidyCapCents: null,
        minItemPriceCents: null,
      };

      const result = computeEbayItemPrice(input);

      // No floor applied
      expect(result.ebayItemPriceCents).toBe(500);
      expect(result.evidence.minItemPriceApplied).toBe(false);
      expect(result.evidence.minItemPriceDollars).toBeNull();
    });
  });

  describe('computeEbayItemPrice - Evidence tracking', () => {
    it('should track all intermediate values in evidence', () => {
      const input: ComputeEbayItemPriceInput = {
        amazonItemPriceCents: 4500,
        amazonShippingCents: 800,
        discountPercent: 15,
        shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
        templateShippingEstimateCents: 650,
        shippingSubsidyCapCents: 300,
        minItemPriceCents: 1000,
      };

      const result = computeEbayItemPrice(input);

      expect(result.evidence).toMatchObject({
        amazonItemPriceDollars: 45.00,
        amazonShippingDollars: 8.00,
        amazonTotalDollars: 53.00,
        discountPercent: 15,
        targetDeliveredTotalDollars: 45.05,
        shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
        templateShippingEstimateDollars: 6.50,
        shippingSubsidyCapDollars: 3.00,
        ebayItemPriceDollars: 38.55,
        minItemPriceDollars: 10.00,
        minItemPriceApplied: false,
      });
    });
  });

  describe('computeEbayItemPrice - Edge cases', () => {
    it('should handle zero discount', () => {
      const input: ComputeEbayItemPriceInput = {
        amazonItemPriceCents: 3000,
        amazonShippingCents: 0,
        discountPercent: 0,
        shippingStrategy: 'DISCOUNT_ITEM_ONLY',
        templateShippingEstimateCents: 600,
        shippingSubsidyCapCents: null,
      };

      const result = computeEbayItemPrice(input);

      // No discount: item price = Amazon item price
      expect(result.ebayItemPriceCents).toBe(3000);
      expect(result.evidence.ebayItemPriceDollars).toBe(30.00);
    });

    it('should handle high discount (50%)', () => {
      const input: ComputeEbayItemPriceInput = {
        amazonItemPriceCents: 6000,
        amazonShippingCents: 0,
        discountPercent: 50,
        shippingStrategy: 'DISCOUNT_ITEM_ONLY',
        templateShippingEstimateCents: 600,
        shippingSubsidyCapCents: null,
      };

      const result = computeEbayItemPrice(input);

      // 60.00 * 0.5 = 30.00
      expect(result.ebayItemPriceCents).toBe(3000);
      expect(result.evidence.ebayItemPriceDollars).toBe(30.00);
    });

    it('should handle zero template shipping estimate', () => {
      const input: ComputeEbayItemPriceInput = {
        amazonItemPriceCents: 5000,
        amazonShippingCents: 0,
        discountPercent: 10,
        shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
        templateShippingEstimateCents: 0,
        shippingSubsidyCapCents: null,
      };

      const result = computeEbayItemPrice(input);

      // Target = 50.00 * 0.9 = 45.00
      // Item = 45.00 - 0.00 = 45.00
      expect(result.ebayItemPriceCents).toBe(4500);
      expect(result.evidence.templateShippingEstimateDollars).toBe(0.00);
    });

    it('should handle ALGO strategy resulting in very low price', () => {
      const input: ComputeEbayItemPriceInput = {
        amazonItemPriceCents: 1500, // $15.00
        amazonShippingCents: 0,
        discountPercent: 10,
        shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
        templateShippingEstimateCents: 1200, // $12.00 estimated shipping
        shippingSubsidyCapCents: null,
      };

      const result = computeEbayItemPrice(input);

      // Target = 15.00 * 0.9 = 13.50
      // Item = 13.50 - 12.00 = 1.50
      expect(result.ebayItemPriceCents).toBe(150);
      expect(result.evidence.ebayItemPriceDollars).toBe(1.50);
    });
  });

  describe('computeEbayItemPrice - Strategy comparison', () => {
    it('ALGO should be lower than ITEM_ONLY when Amazon has free shipping', () => {
      const baseInput = {
        amazonItemPriceCents: 5000,
        amazonShippingCents: 0,
        discountPercent: 10,
        templateShippingEstimateCents: 600,
        shippingSubsidyCapCents: null,
      };

      const algoResult = computeEbayItemPrice({
        ...baseInput,
        shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
      });

      const itemOnlyResult = computeEbayItemPrice({
        ...baseInput,
        shippingStrategy: 'DISCOUNT_ITEM_ONLY',
      });

      // ALGO: (50 * 0.9) - 6 = 45 - 6 = 39
      // ITEM_ONLY: 50 * 0.9 = 45
      expect(algoResult.ebayItemPriceCents).toBe(3900);
      expect(itemOnlyResult.ebayItemPriceCents).toBe(4500);
      expect(algoResult.ebayItemPriceCents).toBeLessThan(itemOnlyResult.ebayItemPriceCents);
    });

    it('ALGO should account for Amazon shipping in target total', () => {
      const baseInput = {
        amazonItemPriceCents: 5000,
        amazonShippingCents: 1000, // $10 Amazon shipping
        discountPercent: 10,
        templateShippingEstimateCents: 600,
        shippingSubsidyCapCents: null,
      };

      const algoResult = computeEbayItemPrice({
        ...baseInput,
        shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
      });

      const itemOnlyResult = computeEbayItemPrice({
        ...baseInput,
        shippingStrategy: 'DISCOUNT_ITEM_ONLY',
      });

      // ALGO: ((50 + 10) * 0.9) - 6 = 54 - 6 = 48
      // ITEM_ONLY: 50 * 0.9 = 45
      expect(algoResult.ebayItemPriceCents).toBe(4800);
      expect(itemOnlyResult.ebayItemPriceCents).toBe(4500);
      expect(algoResult.ebayItemPriceCents).toBeGreaterThan(itemOnlyResult.ebayItemPriceCents);
    });
  });
});
