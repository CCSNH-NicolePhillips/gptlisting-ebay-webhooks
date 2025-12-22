/**
 * Tests for user pricing settings application
 * 
 * Verifies the ALGO_COMPETITIVE_TOTAL pricing formula:
 * 1. Amazon price × (1 - discountPercent/100) = targetDeliveredTotal
 * 2. targetDeliveredTotal - templateShippingEstimate = eBay item price
 * 
 * Example with 10% discount and $6 shipping:
 * - Frog Fuel $48 → $48 × 0.90 = $43.20 → $43.20 - $6 = $37.20
 */

import { computeEbayItemPrice } from '../../src/lib/pricing-compute.js';
import { computeEbayItemPriceCents } from '../../src/lib/pricing-compute.js';
import { getDefaultPricingSettings } from '../../src/lib/pricing-config.js';

describe('User Pricing Settings Application', () => {
  describe('ALGO_COMPETITIVE_TOTAL with 10% discount and $6 shipping', () => {
    const userSettings = {
      discountPercent: 10,
      shippingStrategy: 'ALGO_COMPETITIVE_TOTAL' as const,
      templateShippingEstimateCents: 600, // $6.00
      shippingSubsidyCapCents: null,
      minItemPriceCents: 199,
    };

    it('should compute $37.20 for Frog Fuel at $48', () => {
      const result = computeEbayItemPriceCents({
        amazonItemPriceCents: 4800, // $48.00
        amazonShippingCents: 0,
        settings: userSettings,
      });

      // $48 × 0.90 = $43.20 target delivered
      // $43.20 - $6 = $37.20 eBay item price
      expect(result.ebayItemPriceCents).toBe(3720);
      expect(result.targetDeliveredTotalCents).toBe(4320);
      expect(result.evidence.shippingSubsidyAppliedCents).toBe(600);
    });

    it('should compute $50.40 for bettr. Morning at $62.67', () => {
      const result = computeEbayItemPriceCents({
        amazonItemPriceCents: 6267, // $62.67
        amazonShippingCents: 0,
        settings: userSettings,
      });

      // $62.67 × 0.90 = $56.40 target delivered
      // $56.40 - $6 = $50.40 eBay item price
      expect(result.ebayItemPriceCents).toBe(5040);
      expect(result.targetDeliveredTotalCents).toBe(5640);
    });

    it('should NOT produce $42.60 (the buggy result from 60 cents shipping)', () => {
      // This was the buggy behavior when shipping was 60 cents instead of 600
      const result = computeEbayItemPriceCents({
        amazonItemPriceCents: 4800,
        amazonShippingCents: 0,
        settings: userSettings,
      });

      // $42.60 = $43.20 - $0.60 (WRONG - shipping was in dollars not cents)
      expect(result.ebayItemPriceCents).not.toBe(4260);
      expect(result.ebayItemPriceCents).toBe(3720); // Correct: $37.20
    });

    it('should NOT produce $42.60 (the buggy result from double-counted shipping)', () => {
      // Another bug: passing templateShippingEstimate as amazonShippingCents
      // caused the shipping to be counted twice:
      // Amazon total = $48 + $6 = $54
      // Target = $54 * 0.9 = $48.60
      // eBay price = $48.60 - $6 = $42.60 (WRONG!)
      // 
      // Correct calculation with amazonShippingCents = 0:
      // Amazon total = $48 + $0 = $48
      // Target = $48 * 0.9 = $43.20
      // eBay price = $43.20 - $6 = $37.20 (CORRECT!)
      
      const result = computeEbayItemPriceCents({
        amazonItemPriceCents: 4800,
        amazonShippingCents: 0, // Brand MSRP has no shipping info!
        settings: userSettings,
      });

      expect(result.ebayItemPriceCents).not.toBe(4260);
      expect(result.ebayItemPriceCents).toBe(3720);
    });

    it('should correctly apply shipping subsidy with Amazon shipping included', () => {
      const result = computeEbayItemPriceCents({
        amazonItemPriceCents: 4800,
        amazonShippingCents: 599, // $5.99 Amazon shipping
        settings: userSettings,
      });

      // Amazon total: $48 + $5.99 = $53.99
      // Target delivered: $53.99 × 0.90 = $48.59
      // eBay item price: $48.59 - $6 = $42.59
      expect(result.ebayItemPriceCents).toBe(4259);
      expect(result.targetDeliveredTotalCents).toBe(4859);
    });
  });

  describe('Edge cases', () => {
    it('should apply minimum price floor', () => {
      const settings = {
        ...getDefaultPricingSettings(),
        discountPercent: 90, // Extreme discount
        templateShippingEstimateCents: 600,
      };

      const result = computeEbayItemPriceCents({
        amazonItemPriceCents: 500, // $5.00
        amazonShippingCents: 0,
        settings,
      });

      // $5 × 0.10 = $0.50 target, minus $6 = negative!
      // Should clamp to minItemPriceCents (199 = $1.99)
      expect(result.ebayItemPriceCents).toBe(199);
    });

    it('should handle free shipping template correctly', () => {
      const settings = {
        ...getDefaultPricingSettings(),
        discountPercent: 10,
        templateShippingEstimateCents: 0, // FREE SHIPPING
      };

      const result = computeEbayItemPriceCents({
        amazonItemPriceCents: 4800,
        amazonShippingCents: 0,
        settings,
      });

      // $48 × 0.90 = $43.20 (no shipping subtracted)
      expect(result.ebayItemPriceCents).toBe(4320);
      expect(result.evidence.shippingSubsidyAppliedCents).toBe(0);
    });

    it('should apply shipping subsidy cap when specified', () => {
      const settings = {
        ...getDefaultPricingSettings(),
        discountPercent: 10,
        templateShippingEstimateCents: 1000, // $10.00 shipping
        shippingSubsidyCapCents: 500, // Cap at $5.00
      };

      const result = computeEbayItemPriceCents({
        amazonItemPriceCents: 4800,
        amazonShippingCents: 0,
        settings,
      });

      // $48 × 0.90 = $43.20
      // $43.20 - $5.00 (capped) = $38.20
      expect(result.ebayItemPriceCents).toBe(3820);
      expect(result.evidence.shippingSubsidyAppliedCents).toBe(500); // Capped
    });
  });

  describe('DISCOUNT_ITEM_ONLY strategy', () => {
    it('should only discount item price, ignoring shipping estimate', () => {
      const settings = {
        ...getDefaultPricingSettings(),
        discountPercent: 10,
        shippingStrategy: 'DISCOUNT_ITEM_ONLY' as const,
        templateShippingEstimateCents: 600,
      };

      const result = computeEbayItemPriceCents({
        amazonItemPriceCents: 4800,
        amazonShippingCents: 0,
        settings,
      });

      // $48 × 0.90 = $43.20 (no shipping subtracted)
      expect(result.ebayItemPriceCents).toBe(4320);
      expect(result.evidence.shippingSubsidyAppliedCents).toBe(0);
    });
  });

  describe('Default settings validation', () => {
    it('should have correct defaults', () => {
      const defaults = getDefaultPricingSettings();

      expect(defaults.discountPercent).toBe(10);
      expect(defaults.shippingStrategy).toBe('ALGO_COMPETITIVE_TOTAL');
      expect(defaults.templateShippingEstimateCents).toBe(600);
      expect(defaults.shippingSubsidyCapCents).toBeNull();
      expect(defaults.minItemPriceCents).toBe(199);
    });
  });
});
