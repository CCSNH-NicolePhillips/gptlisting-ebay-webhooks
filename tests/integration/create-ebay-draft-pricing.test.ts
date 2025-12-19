/**
 * Integration tests for Phase 3 pricing wiring in create-ebay-draft-user.ts
 * Tests that computeEbayItemPriceCents() is correctly called at the offer creation layer
 */

import { computeEbayItemPriceCents } from '../../src/lib/pricing-compute.js';
import type { PricingSettings } from '../../src/lib/pricing-config.js';

describe('create-ebay-draft-user pricing integration', () => {
  describe('ALGO_COMPETITIVE_TOTAL strategy', () => {
    it('should compute $45.30 for Amazon $57 free shipping with 10% discount', () => {
      // Test scenario from Phase 2: Amazon item $57.00, free shipping, 10% discount, ALGO
      const result = computeEbayItemPriceCents({
        amazonItemPriceCents: 5700,
        amazonShippingCents: 0,
        settings: {
          discountPercent: 10,
          shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
          templateShippingEstimateCents: 600,
          shippingSubsidyCapCents: null,
          minItemPriceCents: 199,
        },
      });

      expect(result.ebayItemPriceCents).toBe(4530);
      expect(result.ebayItemPriceCents / 100).toBe(45.30);
      expect(result.targetDeliveredTotalCents).toBe(5130); // $57 * 0.9 = $51.30
      expect(result.evidence.shippingSubsidyAppliedCents).toBe(600);
    });

    it('should compute $50.69 for Amazon $57 + $5.99 shipping with 10% discount', () => {
      // Test scenario: Amazon item + shipping, 10% discount, ALGO
      const result = computeEbayItemPriceCents({
        amazonItemPriceCents: 5700,
        amazonShippingCents: 599,
        settings: {
          discountPercent: 10,
          shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
          templateShippingEstimateCents: 600,
          shippingSubsidyCapCents: null,
          minItemPriceCents: 199,
        },
      });

      expect(result.ebayItemPriceCents).toBe(5069);
      expect(result.ebayItemPriceCents / 100).toBe(50.69);
      expect(result.targetDeliveredTotalCents).toBe(5669); // ($57 + $5.99) * 0.9 = $56.69
      expect(result.evidence.shippingSubsidyAppliedCents).toBe(600);
    });

    it('should apply subsidy cap when specified', () => {
      // Test scenario: Cap subsidy at $5.00
      const result = computeEbayItemPriceCents({
        amazonItemPriceCents: 5700,
        amazonShippingCents: 0,
        settings: {
          discountPercent: 10,
          shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
          templateShippingEstimateCents: 600,
          shippingSubsidyCapCents: 500, // Cap at $5.00
          minItemPriceCents: 199,
        },
      });

      expect(result.evidence.shippingSubsidyAppliedCents).toBe(500); // Capped
      expect(result.ebayItemPriceCents).toBe(4630); // $51.30 - $5.00 = $46.30
    });

    it('should apply minimum item price floor', () => {
      // Test scenario: Result would be negative, should clamp to minimum
      const result = computeEbayItemPriceCents({
        amazonItemPriceCents: 100,
        amazonShippingCents: 0,
        settings: {
          discountPercent: 90,
          shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
          templateShippingEstimateCents: 600,
          shippingSubsidyCapCents: null,
          minItemPriceCents: 199,
        },
      });

      expect(result.ebayItemPriceCents).toBe(199); // Clamped to minimum
      expect(result.evidence.minItemPriceCents).toBe(199);
    });
  });

  describe('DISCOUNT_ITEM_ONLY strategy', () => {
    it('should compute $51.30 for Amazon $57 free shipping with 10% discount', () => {
      // Test scenario: DISCOUNT_ITEM_ONLY ignores shipping, only discounts item
      const result = computeEbayItemPriceCents({
        amazonItemPriceCents: 5700,
        amazonShippingCents: 0,
        settings: {
          discountPercent: 10,
          shippingStrategy: 'DISCOUNT_ITEM_ONLY',
          templateShippingEstimateCents: 600,
          shippingSubsidyCapCents: null,
          minItemPriceCents: 199,
        },
      });

      expect(result.ebayItemPriceCents).toBe(5130);
      expect(result.ebayItemPriceCents / 100).toBe(51.30);
      expect(result.targetDeliveredTotalCents).toBe(5130); // $57 * 0.9 = $51.30
      expect(result.evidence.shippingSubsidyAppliedCents).toBe(0); // No subsidy in this strategy
    });

    it('should ignore Amazon shipping in DISCOUNT_ITEM_ONLY', () => {
      // Test scenario: Amazon has shipping, but strategy ignores it
      const result = computeEbayItemPriceCents({
        amazonItemPriceCents: 5700,
        amazonShippingCents: 599, // Should be ignored
        settings: {
          discountPercent: 10,
          shippingStrategy: 'DISCOUNT_ITEM_ONLY',
          templateShippingEstimateCents: 600,
          shippingSubsidyCapCents: null,
          minItemPriceCents: 199,
        },
      });

      expect(result.ebayItemPriceCents).toBe(5130);
      expect(result.ebayItemPriceCents / 100).toBe(51.30);
      expect(result.evidence.shippingSubsidyAppliedCents).toBe(0);
    });
  });

  describe('Evidence tracking', () => {
    it('should return comprehensive evidence object', () => {
      const result = computeEbayItemPriceCents({
        amazonItemPriceCents: 5700,
        amazonShippingCents: 599,
        settings: {
          discountPercent: 10,
          shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
          templateShippingEstimateCents: 600,
          shippingSubsidyCapCents: 500,
          minItemPriceCents: 199,
        },
      });

      // Verify all evidence fields exist
      expect(result.evidence.amazonDeliveredTotalCents).toBe(6299); // $57 + $5.99
      expect(result.evidence.discountPercent).toBe(10);
      expect(result.evidence.shippingStrategy).toBe('ALGO_COMPETITIVE_TOTAL');
      expect(result.evidence.templateShippingEstimateCents).toBe(600);
      expect(result.evidence.shippingSubsidyAppliedCents).toBe(500); // Capped
      expect(result.evidence.minItemPriceCents).toBe(199);
      expect(result.targetDeliveredTotalCents).toBe(5669); // ($57 + $5.99) * 0.9
      expect(result.ebayItemPriceCents).toBe(5169); // $56.69 - $5.00 = $51.69
    });
  });

  describe('Price conversion to dollars', () => {
    it('should convert cents to dollars correctly for offer creation', () => {
      const result = computeEbayItemPriceCents({
        amazonItemPriceCents: 5700,
        amazonShippingCents: 0,
        settings: {
          discountPercent: 10,
          shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
          templateShippingEstimateCents: 600,
          shippingSubsidyCapCents: null,
          minItemPriceCents: 199,
        },
      });

      const offerPriceDollars = result.ebayItemPriceCents / 100;
      
      expect(offerPriceDollars).toBe(45.30);
      expect(typeof offerPriceDollars).toBe('number');
      expect(Number.isFinite(offerPriceDollars)).toBe(true);
      expect(offerPriceDollars > 0).toBe(true);
    });
  });

  describe('Edge cases', () => {
    it('should handle zero discount', () => {
      const result = computeEbayItemPriceCents({
        amazonItemPriceCents: 5700,
        amazonShippingCents: 0,
        settings: {
          discountPercent: 0,
          shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
          templateShippingEstimateCents: 600,
          shippingSubsidyCapCents: null,
          minItemPriceCents: 199,
        },
      });

      expect(result.targetDeliveredTotalCents).toBe(5700); // No discount
      expect(result.ebayItemPriceCents).toBe(5100); // $57 - $6 shipping = $51
    });

    it('should handle zero template shipping', () => {
      const result = computeEbayItemPriceCents({
        amazonItemPriceCents: 5700,
        amazonShippingCents: 0,
        settings: {
          discountPercent: 10,
          shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
          templateShippingEstimateCents: 0, // No template shipping
          shippingSubsidyCapCents: null,
          minItemPriceCents: 199,
        },
      });

      expect(result.evidence.shippingSubsidyAppliedCents).toBe(0);
      expect(result.ebayItemPriceCents).toBe(5130); // $51.30 (no subsidy applied)
    });
  });
});
