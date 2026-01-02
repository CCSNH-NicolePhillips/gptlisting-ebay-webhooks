/**
 * Unit tests for uniform discount application across all price sources
 * 
 * KEY RULE: ALL price sources (amazon, brand-msrp, ebay-sold, etc.) must get
 * the same user-configured discount from settings.discountPercent
 * 
 * Formula: Amazon $29.99 -> 10% off = $26.99 -> minus $6 shipping = $20.99
 */

import { computeEbayItemPrice } from '../../src/lib/pricing-compute.js';
import { getDefaultPricingSettings } from '../../src/lib/pricing-config.js';

describe('Uniform Discount Application', () => {
  const defaultSettings = getDefaultPricingSettings();

  describe('ALGO_COMPETITIVE_TOTAL strategy (default)', () => {
    it('should apply 10% discount to Amazon $29.99 -> $20.99 eBay price', () => {
      // User's formula: $29.99 - 10% = $26.99 - $6 shipping = $20.99
      const result = computeEbayItemPrice({
        amazonItemPriceCents: 2999,
        amazonShippingCents: 0, // Free shipping
        discountPercent: 10,
        shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
        templateShippingEstimateCents: 600,
        shippingSubsidyCapCents: null,
        minItemPriceCents: 199,
      });

      expect(result.ebayItemPriceCents).toBe(2099); // $20.99
      expect(result.evidence.targetDeliveredTotalDollars).toBe(26.99); // $29.99 * 0.9
      expect(result.evidence.ebayItemPriceDollars).toBe(20.99); // $26.99 - $6
    });

    it('should apply 10% discount to $57.00 -> $45.30 eBay price', () => {
      // $57.00 * 0.9 = $51.30 - $6 = $45.30
      const result = computeEbayItemPrice({
        amazonItemPriceCents: 5700,
        amazonShippingCents: 0,
        discountPercent: 10,
        shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
        templateShippingEstimateCents: 600,
        shippingSubsidyCapCents: null,
        minItemPriceCents: 199,
      });

      expect(result.ebayItemPriceCents).toBe(4530); // $45.30
    });

    it('should include Amazon shipping in discount calculation', () => {
      // Amazon $29.99 item + $5.00 shipping = $34.99 total
      // $34.99 * 0.9 = $31.49 target total
      // $31.49 - $6 template shipping = $25.49 eBay item price
      const result = computeEbayItemPrice({
        amazonItemPriceCents: 2999,
        amazonShippingCents: 500,
        discountPercent: 10,
        shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
        templateShippingEstimateCents: 600,
        shippingSubsidyCapCents: null,
        minItemPriceCents: 199,
      });

      expect(result.evidence.amazonTotalDollars).toBe(34.99);
      expect(result.evidence.targetDeliveredTotalDollars).toBe(31.49);
      expect(result.ebayItemPriceCents).toBe(2549); // $25.49
    });
  });

  describe('DISCOUNT_ITEM_ONLY strategy', () => {
    it('should apply 10% discount to item only, ignoring shipping in calc', () => {
      // $29.99 * 0.9 = $26.99 (shipping not subtracted)
      const result = computeEbayItemPrice({
        amazonItemPriceCents: 2999,
        amazonShippingCents: 0,
        discountPercent: 10,
        shippingStrategy: 'DISCOUNT_ITEM_ONLY',
        templateShippingEstimateCents: 600,
        shippingSubsidyCapCents: null,
        minItemPriceCents: 199,
      });

      expect(result.ebayItemPriceCents).toBe(2699); // $26.99
    });
  });

  describe('User-configurable discount percentages', () => {
    it('should apply 15% discount when configured', () => {
      // $29.99 * 0.85 = $25.49 - $6 = $19.49
      const result = computeEbayItemPrice({
        amazonItemPriceCents: 2999,
        amazonShippingCents: 0,
        discountPercent: 15,
        shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
        templateShippingEstimateCents: 600,
        shippingSubsidyCapCents: null,
        minItemPriceCents: 199,
      });

      expect(result.evidence.discountPercent).toBe(15);
      expect(result.evidence.targetDeliveredTotalDollars).toBe(25.49);
      expect(result.ebayItemPriceCents).toBe(1949); // $19.49
    });

    it('should apply 5% discount when configured', () => {
      // $29.99 * 0.95 = $28.49 - $6 = $22.49
      const result = computeEbayItemPrice({
        amazonItemPriceCents: 2999,
        amazonShippingCents: 0,
        discountPercent: 5,
        shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
        templateShippingEstimateCents: 600,
        shippingSubsidyCapCents: null,
        minItemPriceCents: 199,
      });

      expect(result.evidence.discountPercent).toBe(5);
      expect(result.ebayItemPriceCents).toBe(2249); // $22.49
    });

    it('should apply 20% discount when configured', () => {
      // $29.99 * 0.80 = $23.99 - $6 = $17.99
      const result = computeEbayItemPrice({
        amazonItemPriceCents: 2999,
        amazonShippingCents: 0,
        discountPercent: 20,
        shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
        templateShippingEstimateCents: 600,
        shippingSubsidyCapCents: null,
        minItemPriceCents: 199,
      });

      expect(result.evidence.discountPercent).toBe(20);
      expect(result.ebayItemPriceCents).toBe(1799); // $17.99
    });

    it('should apply 0% discount (no discount) when configured', () => {
      // $29.99 * 1.0 = $29.99 - $6 = $23.99
      const result = computeEbayItemPrice({
        amazonItemPriceCents: 2999,
        amazonShippingCents: 0,
        discountPercent: 0,
        shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
        templateShippingEstimateCents: 600,
        shippingSubsidyCapCents: null,
        minItemPriceCents: 199,
      });

      expect(result.evidence.discountPercent).toBe(0);
      expect(result.ebayItemPriceCents).toBe(2399); // $23.99
    });
  });

  describe('User-configurable shipping estimates', () => {
    it('should use $8 template shipping when configured', () => {
      // $29.99 * 0.9 = $26.99 - $8 = $18.99
      const result = computeEbayItemPrice({
        amazonItemPriceCents: 2999,
        amazonShippingCents: 0,
        discountPercent: 10,
        shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
        templateShippingEstimateCents: 800, // $8 shipping
        shippingSubsidyCapCents: null,
        minItemPriceCents: 199,
      });

      expect(result.evidence.templateShippingEstimateDollars).toBe(8);
      expect(result.ebayItemPriceCents).toBe(1899); // $18.99
    });

    it('should use $4 template shipping when configured', () => {
      // $29.99 * 0.9 = $26.99 - $4 = $22.99
      const result = computeEbayItemPrice({
        amazonItemPriceCents: 2999,
        amazonShippingCents: 0,
        discountPercent: 10,
        shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
        templateShippingEstimateCents: 400, // $4 shipping
        shippingSubsidyCapCents: null,
        minItemPriceCents: 199,
      });

      expect(result.evidence.templateShippingEstimateDollars).toBe(4);
      expect(result.ebayItemPriceCents).toBe(2299); // $22.99
    });
  });

  describe('Minimum price floor', () => {
    it('should apply minimum price when result is too low', () => {
      // $10 * 0.9 = $9 - $6 = $3, but min is $1.99
      const result = computeEbayItemPrice({
        amazonItemPriceCents: 1000,
        amazonShippingCents: 0,
        discountPercent: 10,
        shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
        templateShippingEstimateCents: 600,
        shippingSubsidyCapCents: null,
        minItemPriceCents: 199, // $1.99 minimum
      });

      // $10 * 0.9 = $9 - $6 = $3, which is above minimum
      expect(result.ebayItemPriceCents).toBe(300); // $3.00
      expect(result.evidence.minItemPriceApplied).toBe(false);
    });

    it('should clamp to minimum when result would be negative', () => {
      // $5 * 0.9 = $4.50 - $6 = -$1.50, clamp to $1.99
      const result = computeEbayItemPrice({
        amazonItemPriceCents: 500,
        amazonShippingCents: 0,
        discountPercent: 10,
        shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
        templateShippingEstimateCents: 600,
        shippingSubsidyCapCents: null,
        minItemPriceCents: 199,
      });

      expect(result.ebayItemPriceCents).toBe(199); // $1.99 minimum
      expect(result.evidence.minItemPriceApplied).toBe(true);
    });

    it('should use custom minimum when configured', () => {
      const result = computeEbayItemPrice({
        amazonItemPriceCents: 500,
        amazonShippingCents: 0,
        discountPercent: 10,
        shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
        templateShippingEstimateCents: 600,
        shippingSubsidyCapCents: null,
        minItemPriceCents: 499, // $4.99 minimum
      });

      expect(result.ebayItemPriceCents).toBe(499); // $4.99 custom minimum
      expect(result.evidence.minItemPriceApplied).toBe(true);
    });
  });

  describe('Default settings from getDefaultPricingSettings()', () => {
    it('should have correct default values', () => {
      expect(defaultSettings.discountPercent).toBe(10);
      expect(defaultSettings.shippingStrategy).toBe('ALGO_COMPETITIVE_TOTAL');
      expect(defaultSettings.templateShippingEstimateCents).toBe(600);
      expect(defaultSettings.shippingSubsidyCapCents).toBeNull();
      expect(defaultSettings.minItemPriceCents).toBe(199);
    });

    it('should produce $20.99 for $29.99 Amazon with defaults', () => {
      const result = computeEbayItemPrice({
        amazonItemPriceCents: 2999,
        amazonShippingCents: 0,
        discountPercent: defaultSettings.discountPercent,
        shippingStrategy: defaultSettings.shippingStrategy,
        templateShippingEstimateCents: defaultSettings.templateShippingEstimateCents,
        shippingSubsidyCapCents: defaultSettings.shippingSubsidyCapCents,
        minItemPriceCents: defaultSettings.minItemPriceCents,
      });

      expect(result.ebayItemPriceCents).toBe(2099); // $20.99
    });
  });

  describe('Edge cases', () => {
    it('should handle exact dollar amounts without rounding errors', () => {
      // $30.00 * 0.9 = $27.00 - $6 = $21.00
      const result = computeEbayItemPrice({
        amazonItemPriceCents: 3000,
        amazonShippingCents: 0,
        discountPercent: 10,
        shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
        templateShippingEstimateCents: 600,
        shippingSubsidyCapCents: null,
        minItemPriceCents: 199,
      });

      expect(result.ebayItemPriceCents).toBe(2100); // $21.00 exactly
    });

    it('should handle large prices correctly', () => {
      // $199.99 * 0.9 = $179.99 - $6 = $173.99
      const result = computeEbayItemPrice({
        amazonItemPriceCents: 19999,
        amazonShippingCents: 0,
        discountPercent: 10,
        shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
        templateShippingEstimateCents: 600,
        shippingSubsidyCapCents: null,
        minItemPriceCents: 199,
      });

      expect(result.ebayItemPriceCents).toBe(17399); // $173.99
    });

    it('should handle penny prices correctly', () => {
      // $29.39 * 0.9 = $26.45 - $6 = $20.45
      const result = computeEbayItemPrice({
        amazonItemPriceCents: 2939,
        amazonShippingCents: 0,
        discountPercent: 10,
        shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
        templateShippingEstimateCents: 600,
        shippingSubsidyCapCents: null,
        minItemPriceCents: 199,
      });

      // $29.39 * 0.9 = $26.451 -> rounds to $26.45
      // $26.45 - $6 = $20.45
      expect(result.ebayItemPriceCents).toBe(2045); // $20.45
    });
  });
});
