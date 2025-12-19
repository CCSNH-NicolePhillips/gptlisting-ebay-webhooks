/**
 * Tests for pricing-compute.ts - Phase 2
 * computeEbayItemPriceCents() function
 */

import { computeEbayItemPriceCents } from '../../src/lib/pricing-compute.js';
import type { PricingSettings } from '../../src/lib/pricing-config.js';

describe('pricing-compute Phase 2: computeEbayItemPriceCents', () => {
  describe('ALGO_COMPETITIVE_TOTAL strategy', () => {
    it('should compute correct price for Amazon $57.00 free shipping, 10% discount, $6 template', () => {
      const settings: PricingSettings = {
        discountPercent: 10,
        shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
        templateShippingEstimateCents: 600,
        shippingSubsidyCapCents: null,
        minItemPriceCents: 199,
      };

      const result = computeEbayItemPriceCents({
        amazonItemPriceCents: 5700,
        amazonShippingCents: 0,
        settings,
      });

      // amazonTotal = 5700 + 0 = 5700
      // targetTotal = 5700 * 0.9 = 5130
      // itemPrice = 5130 - 600 = 4530
      expect(result.ebayItemPriceCents).toBe(4530);
      expect(result.targetDeliveredTotalCents).toBe(5130);
      expect(result.evidence.amazonDeliveredTotalCents).toBe(5700);
      expect(result.evidence.shippingSubsidyAppliedCents).toBe(600);
    });

    it('should compute correct price for Amazon $57.00 + $5.99 shipping, 10% discount', () => {
      const settings: PricingSettings = {
        discountPercent: 10,
        shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
        templateShippingEstimateCents: 600,
        shippingSubsidyCapCents: null,
        minItemPriceCents: 199,
      };

      const result = computeEbayItemPriceCents({
        amazonItemPriceCents: 5700,
        amazonShippingCents: 599,
        settings,
      });

      // amazonTotal = 5700 + 599 = 6299
      // targetTotal = 6299 * 0.9 = 5669.1 -> 5669
      // itemPrice = 5669 - 600 = 5069
      expect(result.ebayItemPriceCents).toBe(5069);
      expect(result.targetDeliveredTotalCents).toBe(5669);
      expect(result.evidence.amazonDeliveredTotalCents).toBe(6299);
      expect(result.evidence.shippingSubsidyAppliedCents).toBe(600);
    });

    it('should apply shipping subsidy cap when specified', () => {
      const settings: PricingSettings = {
        discountPercent: 10,
        shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
        templateShippingEstimateCents: 600,
        shippingSubsidyCapCents: 500, // Cap at $5
        minItemPriceCents: 199,
      };

      const result = computeEbayItemPriceCents({
        amazonItemPriceCents: 5700,
        amazonShippingCents: 0,
        settings,
      });

      // amazonTotal = 5700
      // targetTotal = 5700 * 0.9 = 5130
      // subsidy = min(600, 500) = 500
      // itemPrice = 5130 - 500 = 4630
      expect(result.ebayItemPriceCents).toBe(4630);
      expect(result.evidence.shippingSubsidyAppliedCents).toBe(500);
    });

    it('should apply minimum price floor when item price goes too low', () => {
      const settings: PricingSettings = {
        discountPercent: 10,
        shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
        templateShippingEstimateCents: 600,
        shippingSubsidyCapCents: null,
        minItemPriceCents: 199,
      };

      const result = computeEbayItemPriceCents({
        amazonItemPriceCents: 500,
        amazonShippingCents: 0,
        settings,
      });

      // amazonTotal = 500
      // targetTotal = 500 * 0.9 = 450
      // itemPrice = 450 - 600 = -150 -> clamped to 199
      expect(result.ebayItemPriceCents).toBe(199);
      expect(result.targetDeliveredTotalCents).toBe(450);
    });
  });

  describe('DISCOUNT_ITEM_ONLY strategy', () => {
    it('should compute correct price for Amazon $57.00 free shipping, 10% discount', () => {
      const settings: PricingSettings = {
        discountPercent: 10,
        shippingStrategy: 'DISCOUNT_ITEM_ONLY',
        templateShippingEstimateCents: 600,
        shippingSubsidyCapCents: null,
        minItemPriceCents: 199,
      };

      const result = computeEbayItemPriceCents({
        amazonItemPriceCents: 5700,
        amazonShippingCents: 0,
        settings,
      });

      // itemPrice = 5700 * 0.9 = 5130
      expect(result.ebayItemPriceCents).toBe(5130);
      expect(result.evidence.shippingSubsidyAppliedCents).toBe(0);
    });

    it('should ignore Amazon shipping cost in calculation', () => {
      const settings: PricingSettings = {
        discountPercent: 10,
        shippingStrategy: 'DISCOUNT_ITEM_ONLY',
        templateShippingEstimateCents: 600,
        shippingSubsidyCapCents: null,
        minItemPriceCents: 199,
      };

      const result = computeEbayItemPriceCents({
        amazonItemPriceCents: 5700,
        amazonShippingCents: 599, // Should be ignored
        settings,
      });

      // itemPrice = 5700 * 0.9 = 5130 (shipping ignored)
      expect(result.ebayItemPriceCents).toBe(5130);
      expect(result.evidence.shippingSubsidyAppliedCents).toBe(0);
    });

    it('should still apply minimum price floor', () => {
      const settings: PricingSettings = {
        discountPercent: 10,
        shippingStrategy: 'DISCOUNT_ITEM_ONLY',
        templateShippingEstimateCents: 600,
        shippingSubsidyCapCents: null,
        minItemPriceCents: 500,
      };

      const result = computeEbayItemPriceCents({
        amazonItemPriceCents: 300,
        amazonShippingCents: 0,
        settings,
      });

      // itemPrice = 300 * 0.9 = 270 -> clamped to 500
      expect(result.ebayItemPriceCents).toBe(500);
    });
  });

  describe('Evidence tracking', () => {
    it('should track all computation steps in evidence', () => {
      const settings: PricingSettings = {
        discountPercent: 15,
        shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
        templateShippingEstimateCents: 700,
        shippingSubsidyCapCents: 600,
        minItemPriceCents: 199,
      };

      const result = computeEbayItemPriceCents({
        amazonItemPriceCents: 4000,
        amazonShippingCents: 500,
        settings,
      });

      expect(result.evidence.amazonDeliveredTotalCents).toBe(4500);
      expect(result.evidence.discountPercent).toBe(15);
      expect(result.evidence.shippingStrategy).toBe('ALGO_COMPETITIVE_TOTAL');
      expect(result.evidence.templateShippingEstimateCents).toBe(700);
      expect(result.evidence.shippingSubsidyAppliedCents).toBe(600); // capped
      expect(result.evidence.minItemPriceCents).toBe(199);
    });
  });

  describe('Edge cases', () => {
    it('should handle zero discount', () => {
      const settings: PricingSettings = {
        discountPercent: 0,
        shippingStrategy: 'DISCOUNT_ITEM_ONLY',
        templateShippingEstimateCents: 600,
        shippingSubsidyCapCents: null,
        minItemPriceCents: 199,
      };

      const result = computeEbayItemPriceCents({
        amazonItemPriceCents: 5000,
        amazonShippingCents: 0,
        settings,
      });

      // itemPrice = 5000 * 1.0 = 5000
      expect(result.ebayItemPriceCents).toBe(5000);
    });

    it('should handle 50% discount', () => {
      const settings: PricingSettings = {
        discountPercent: 50,
        shippingStrategy: 'DISCOUNT_ITEM_ONLY',
        templateShippingEstimateCents: 600,
        shippingSubsidyCapCents: null,
        minItemPriceCents: 199,
      };

      const result = computeEbayItemPriceCents({
        amazonItemPriceCents: 6000,
        amazonShippingCents: 0,
        settings,
      });

      // itemPrice = 6000 * 0.5 = 3000
      expect(result.ebayItemPriceCents).toBe(3000);
    });

    it('should handle zero template shipping estimate', () => {
      const settings: PricingSettings = {
        discountPercent: 10,
        shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
        templateShippingEstimateCents: 0,
        shippingSubsidyCapCents: null,
        minItemPriceCents: 199,
      };

      const result = computeEbayItemPriceCents({
        amazonItemPriceCents: 5000,
        amazonShippingCents: 0,
        settings,
      });

      // targetTotal = 5000 * 0.9 = 4500
      // itemPrice = 4500 - 0 = 4500
      expect(result.ebayItemPriceCents).toBe(4500);
    });

    it('should handle subsidy cap equal to template estimate', () => {
      const settings: PricingSettings = {
        discountPercent: 10,
        shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
        templateShippingEstimateCents: 600,
        shippingSubsidyCapCents: 600, // Equal to template
        minItemPriceCents: 199,
      };

      const result = computeEbayItemPriceCents({
        amazonItemPriceCents: 5000,
        amazonShippingCents: 0,
        settings,
      });

      expect(result.evidence.shippingSubsidyAppliedCents).toBe(600);
    });

    it('should handle subsidy cap greater than template estimate', () => {
      const settings: PricingSettings = {
        discountPercent: 10,
        shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
        templateShippingEstimateCents: 600,
        shippingSubsidyCapCents: 800, // Greater than template
        minItemPriceCents: 199,
      };

      const result = computeEbayItemPriceCents({
        amazonItemPriceCents: 5000,
        amazonShippingCents: 0,
        settings,
      });

      // Cap doesn't limit, template estimate is smaller
      expect(result.evidence.shippingSubsidyAppliedCents).toBe(600);
    });
  });

  describe('Rounding behavior', () => {
    it('should round target total correctly', () => {
      const settings: PricingSettings = {
        discountPercent: 10,
        shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
        templateShippingEstimateCents: 600,
        shippingSubsidyCapCents: null,
        minItemPriceCents: 199,
      };

      const result = computeEbayItemPriceCents({
        amazonItemPriceCents: 5555,
        amazonShippingCents: 0,
        settings,
      });

      // targetTotal = 5555 * 0.9 = 4999.5 -> 5000 (rounded)
      expect(result.targetDeliveredTotalCents).toBe(5000);
    });

    it('should round item price correctly for DISCOUNT_ITEM_ONLY', () => {
      const settings: PricingSettings = {
        discountPercent: 10,
        shippingStrategy: 'DISCOUNT_ITEM_ONLY',
        templateShippingEstimateCents: 600,
        shippingSubsidyCapCents: null,
        minItemPriceCents: 199,
      };

      const result = computeEbayItemPriceCents({
        amazonItemPriceCents: 3333,
        amazonShippingCents: 0,
        settings,
      });

      // itemPrice = 3333 * 0.9 = 2999.7 -> 3000 (rounded)
      expect(result.ebayItemPriceCents).toBe(3000);
    });
  });
});
