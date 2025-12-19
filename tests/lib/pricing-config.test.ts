/**
 * Tests for pricing-config.ts - Phase 1
 * 
 * Coverage:
 * - Default pricing settings
 * - Type safety for shipping strategies
 */

import { getDefaultPricingSettings, type PricingSettings, type ShippingStrategy } from '../../src/lib/pricing-config.js';

describe('pricing-config', () => {
  describe('getDefaultPricingSettings', () => {
    it('should return valid default pricing settings', () => {
      const defaults = getDefaultPricingSettings();

      expect(defaults).toBeDefined();
      expect(typeof defaults).toBe('object');
    });

    it('should have discountPercent of 10', () => {
      const defaults = getDefaultPricingSettings();
      expect(defaults.discountPercent).toBe(10);
    });

    it('should default to ALGO_COMPETITIVE_TOTAL strategy', () => {
      const defaults = getDefaultPricingSettings();
      expect(defaults.shippingStrategy).toBe('ALGO_COMPETITIVE_TOTAL');
    });

    it('should have templateShippingEstimateCents of 600 ($6.00)', () => {
      const defaults = getDefaultPricingSettings();
      expect(defaults.templateShippingEstimateCents).toBe(600);
    });

    it('should have null shippingSubsidyCapCents by default', () => {
      const defaults = getDefaultPricingSettings();
      expect(defaults.shippingSubsidyCapCents).toBeNull();
    });

    it('should have minItemPriceCents of 199 ($1.99)', () => {
      const defaults = getDefaultPricingSettings();
      expect(defaults.minItemPriceCents).toBe(199);
    });

    it('should return consistent defaults across calls', () => {
      const defaults1 = getDefaultPricingSettings();
      const defaults2 = getDefaultPricingSettings();

      expect(defaults1).toEqual(defaults2);
    });
  });

  describe('PricingSettings type', () => {
    it('should accept valid pricing settings', () => {
      const validSettings: PricingSettings = {
        discountPercent: 15,
        shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
        templateShippingEstimateCents: 700,
        shippingSubsidyCapCents: 500,
        minItemPriceCents: 199,
      };

      expect(validSettings.discountPercent).toBe(15);
      expect(validSettings.shippingStrategy).toBe('ALGO_COMPETITIVE_TOTAL');
      expect(validSettings.templateShippingEstimateCents).toBe(700);
      expect(validSettings.shippingSubsidyCapCents).toBe(500);
      expect(validSettings.minItemPriceCents).toBe(199);
    });

    it('should accept null for shippingSubsidyCapCents', () => {
      const validSettings: PricingSettings = {
        discountPercent: 10,
        shippingStrategy: 'DISCOUNT_ITEM_ONLY',
        templateShippingEstimateCents: 600,
        shippingSubsidyCapCents: null,
        minItemPriceCents: 199,
      };

      expect(validSettings.shippingSubsidyCapCents).toBeNull();
    });
  });

  describe('ShippingStrategy type', () => {
    it('should support ALGO_COMPETITIVE_TOTAL', () => {
      const strategy: ShippingStrategy = 'ALGO_COMPETITIVE_TOTAL';
      expect(strategy).toBe('ALGO_COMPETITIVE_TOTAL');
    });

    it('should support DISCOUNT_ITEM_ONLY', () => {
      const strategy: ShippingStrategy = 'DISCOUNT_ITEM_ONLY';
      expect(strategy).toBe('DISCOUNT_ITEM_ONLY');
    });
  });

  describe('Defaults validation', () => {
    it('should have reasonable discount percentage (0-50%)', () => {
      const defaults = getDefaultPricingSettings();
      expect(defaults.discountPercent).toBeGreaterThanOrEqual(0);
      expect(defaults.discountPercent).toBeLessThanOrEqual(50);
    });

    it('should have positive shipping estimate', () => {
      const defaults = getDefaultPricingSettings();
      expect(defaults.templateShippingEstimateCents).toBeGreaterThan(0);
    });

    it('should have realistic shipping estimate ($3-$15)', () => {
      const defaults = getDefaultPricingSettings();
      const dollars = defaults.templateShippingEstimateCents / 100;
      expect(dollars).toBeGreaterThanOrEqual(3);
      expect(dollars).toBeLessThanOrEqual(15);
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
      expect(settings.discountPercent).toBe(0);
    });

    it('should handle maximum discount (50%)', () => {
      const settings: PricingSettings = {
        discountPercent: 50,
        shippingStrategy: 'DISCOUNT_ITEM_ONLY',
        templateShippingEstimateCents: 600,
        shippingSubsidyCapCents: null,
        minItemPriceCents: 199,
      };
      expect(settings.discountPercent).toBe(50);
    });

    it('should handle zero shipping cost', () => {
      const settings: PricingSettings = {
        discountPercent: 10,
        shippingStrategy: 'DISCOUNT_ITEM_ONLY',
        templateShippingEstimateCents: 0,
        shippingSubsidyCapCents: null,
        minItemPriceCents: 199,
      };
      expect(settings.templateShippingEstimateCents).toBe(0);
    });

    it('should handle high shipping costs', () => {
      const settings: PricingSettings = {
        discountPercent: 10,
        shippingStrategy: 'DISCOUNT_ITEM_ONLY',
        templateShippingEstimateCents: 2000, // $20
        shippingSubsidyCapCents: null,
        minItemPriceCents: 199,
      };
      expect(settings.templateShippingEstimateCents).toBe(2000);
    });

    it('should have positive minItemPriceCents floor', () => {
      const defaults = getDefaultPricingSettings();
      expect(defaults.minItemPriceCents).toBeGreaterThan(0);
    });

    it('should have minItemPriceCents less than $10', () => {
      const defaults = getDefaultPricingSettings();
      const dollars = defaults.minItemPriceCents / 100;
      expect(dollars).toBeLessThan(10);
    });
  });
});
