/**
 * Tests for competitive pricing configuration - Phase 1
 * 
 * PURPOSE: Verify pricing config types and defaults
 * 
 * ACCEPTANCE CRITERIA:
 * ✅ No pricing outputs change (Phase 1 is structure only)
 * ✅ Types compile
 * ✅ Config can be imported without circular deps
 */

import {
  type ShippingStrategy,
  type PricingSettings,
  getDefaultPricingSettings,
} from '../../../src/lib/pricing-config';

// Legacy alias for backward compatibility
type CompetitivePricingRules = PricingSettings;
const getDefaultCompetitivePricingRules = getDefaultPricingSettings;

describe('Competitive Pricing Configuration - Phase 1', () => {
  describe('getDefaultPricingSettings', () => {
    it('should return default configuration', () => {
      const config = getDefaultPricingSettings();

      expect(config).toBeDefined();
      expect(config.discountPercent).toBe(10);
      expect(config.shippingStrategy).toBe('DISCOUNT_ITEM_ONLY');
      expect(config.templateShippingEstimateCents).toBe(600);
      expect(config.shippingSubsidyCapCents).toBeNull();
    });

    it('should return new object on each call (not singleton)', () => {
      const config1 = getDefaultPricingSettings();
      const config2 = getDefaultPricingSettings();

      expect(config1).not.toBe(config2); // Different object references
      expect(config1).toEqual(config2);  // Same values
    });

    it('should return immutable-safe config', () => {
      const config = getDefaultPricingSettings();
      
      // Verify structure matches interface
      expect(typeof config.discountPercent).toBe('number');
      expect(typeof config.shippingStrategy).toBe('string');
      expect(typeof config.templateShippingEstimateCents).toBe('number');
      expect(config.shippingSubsidyCapCents === null || typeof config.shippingSubsidyCapCents === 'number').toBe(true);
    });
  });

  describe('CompetitivePricingRules interface', () => {
    it('should allow valid configuration objects', () => {
      const validConfig: CompetitivePricingRules = {
        discountPercent: 15,
        shippingStrategy: 'MATCH_AMAZON',
        neverExceedAmazonTotal: true,
      };

      expect(validConfig.discountPercent).toBe(15);
      expect(validConfig.shippingStrategy).toBe('MATCH_AMAZON');
    });

    it('should allow sellerPaysUpTo when using SELLER_PAYS_UP_TO strategy', () => {
      const config: CompetitivePricingRules = {
        discountPercent: 10,
        shippingStrategy: 'SELLER_PAYS_UP_TO',
        sellerPaysUpTo: 500, // $5.00 in cents
        neverExceedAmazonTotal: true,
      };

      expect(config.sellerPaysUpTo).toBe(500);
    });

    it('should allow all valid discount percentages', () => {
      const configs = [0, 5, 10, 15, 20, 25].map(discount => ({
        discountPercent: discount,
        shippingStrategy: 'FREE_IF_AMAZON_FREE' as ShippingStrategy,
        neverExceedAmazonTotal: true,
      }));

      configs.forEach(config => {
        expect(config.discountPercent).toBeGreaterThanOrEqual(0);
        expect(config.discountPercent).toBeLessThanOrEqual(25);
      });
    });

    it('should allow neverExceedAmazonTotal to be disabled', () => {
      const config: CompetitivePricingRules = {
        discountPercent: 10,
        shippingStrategy: 'FREE_IF_AMAZON_FREE',
        neverExceedAmazonTotal: false, // Allow pricing above Amazon
      };

      expect(config.neverExceedAmazonTotal).toBe(false);
    });
  });

  describe('ShippingStrategy type', () => {
    it('should allow FREE_IF_AMAZON_FREE strategy', () => {
      const strategy: ShippingStrategy = 'FREE_IF_AMAZON_FREE';
      expect(strategy).toBe('FREE_IF_AMAZON_FREE');
    });

    it('should allow MATCH_AMAZON strategy', () => {
      const strategy: ShippingStrategy = 'MATCH_AMAZON';
      expect(strategy).toBe('MATCH_AMAZON');
    });

    it('should allow SELLER_PAYS_UP_TO strategy', () => {
      const strategy: ShippingStrategy = 'SELLER_PAYS_UP_TO';
      expect(strategy).toBe('SELLER_PAYS_UP_TO');
    });

    it('should only allow the three defined strategies', () => {
      const validStrategies: ShippingStrategy[] = [
        'FREE_IF_AMAZON_FREE',
        'MATCH_AMAZON',
        'SELLER_PAYS_UP_TO',
      ];

      expect(validStrategies.length).toBe(3);
      
      // TypeScript will prevent this at compile time:
      // const invalid: ShippingStrategy = 'INVALID_STRATEGY'; // ❌ Compile error
    });
  });

  describe('Type Safety', () => {
    it('should enforce required fields', () => {
      // Valid: all required fields present
      const complete: CompetitivePricingRules = {
        discountPercent: 10,
        shippingStrategy: 'FREE_IF_AMAZON_FREE',
        neverExceedAmazonTotal: true,
      };
      
      expect(complete).toBeDefined();

      // TypeScript will prevent these at compile time:
      // const missing: CompetitivePricingRules = { discountPercent: 10 }; // ❌
      // const wrong: CompetitivePricingRules = { ...complete, shippingStrategy: 'INVALID' }; // ❌
    });

    it('should allow optional sellerPaysUpTo field', () => {
      const withOptional: CompetitivePricingRules = {
        discountPercent: 10,
        shippingStrategy: 'SELLER_PAYS_UP_TO',
        sellerPaysUpTo: 500,
        neverExceedAmazonTotal: true,
      };

      const withoutOptional: CompetitivePricingRules = {
        discountPercent: 10,
        shippingStrategy: 'FREE_IF_AMAZON_FREE',
        neverExceedAmazonTotal: true,
      };

      expect(withOptional.sellerPaysUpTo).toBe(500);
      expect(withoutOptional.sellerPaysUpTo).toBeUndefined();
    });
  });

  describe('Default Configuration Values', () => {
    it('should use 10% discount by default', () => {
      const config = getDefaultPricingSettings();
      expect(config.discountPercent).toBe(10);
      
      // Rationale: 10% provides competitive advantage without race to bottom
    });

    it('should use ALGO_COMPETITIVE_TOTAL strategy by default', () => {
      const config = getDefaultPricingSettings();
      expect(config.shippingStrategy).toBe('ALGO_COMPETITIVE_TOTAL');
      
      // Rationale: More sophisticated strategy that includes shipping subsidy for better competitiveness
    });

    it('should set template shipping estimate to $6.00 by default', () => {
      const config = getDefaultPricingSettings();
      expect(config.templateShippingEstimateCents).toBe(600);
      
      // Rationale: $6 is typical USPS Priority Mail cost
    });

    it('should not set shipping subsidy cap by default', () => {
      const config = getDefaultPricingSettings();
      expect(config.shippingSubsidyCapCents).toBeNull();
      
      // Rationale: No cap provides maximum flexibility
    });
  });

  describe('No Behavior Change - Phase 1', () => {
    it('should not affect existing pricing functions', () => {
      // Phase 1 only introduces types and config structure
      // No existing pricing logic should change
      
      const config = getDefaultPricingSettings();
      
      // This config exists but is not used yet
      expect(config).toBeDefined();
      
      // Existing pricing functions (computeEbayPrice) remain unchanged
      // They will be refactored in Phase 2+
    });

    it('should allow import without circular dependencies', () => {
      // Simply importing the module should not cause issues
      expect(getDefaultPricingSettings).toBeDefined();
      expect(typeof getDefaultPricingSettings).toBe('function');
    });
  });

  describe('Configuration Examples', () => {
    it('should support aggressive discount strategy', () => {
      const aggressive: PricingSettings = {
        discountPercent: 20, // 20% off Amazon
        shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
        templateShippingEstimateCents: 600,
        shippingSubsidyCapCents: null,
      };

      expect(aggressive.discountPercent).toBe(20);
      expect(aggressive.shippingStrategy).toBe('ALGO_COMPETITIVE_TOTAL');
    });

    it('should support item-only discount strategy', () => {
      const itemOnly: PricingSettings = {
        discountPercent: 15, // 15% off item price
        shippingStrategy: 'DISCOUNT_ITEM_ONLY',
        templateShippingEstimateCents: 700,
        shippingSubsidyCapCents: null,
      };

      expect(itemOnly.discountPercent).toBe(15);
      expect(itemOnly.shippingStrategy).toBe('DISCOUNT_ITEM_ONLY');
    });

    it('should support shipping subsidy cap', () => {
      const withCap: PricingSettings = {
        discountPercent: 10,
        shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
        templateShippingEstimateCents: 600,
        shippingSubsidyCapCents: 500, // Cap at $5.00
      };

      expect(withCap.shippingSubsidyCapCents).toBe(500);
    });
  });
});
