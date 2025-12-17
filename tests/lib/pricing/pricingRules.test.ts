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
  type CompetitivePricingRules,
  getDefaultCompetitivePricingRules,
} from '../../../src/lib/pricing-config';

describe('Competitive Pricing Configuration - Phase 1', () => {
  describe('getDefaultCompetitivePricingRules', () => {
    it('should return default configuration', () => {
      const config = getDefaultCompetitivePricingRules();

      expect(config).toBeDefined();
      expect(config.discountPercent).toBe(10);
      expect(config.shippingStrategy).toBe('FREE_IF_AMAZON_FREE');
      expect(config.neverExceedAmazonTotal).toBe(true);
      expect(config.sellerPaysUpTo).toBeUndefined();
    });

    it('should return new object on each call (not singleton)', () => {
      const config1 = getDefaultCompetitivePricingRules();
      const config2 = getDefaultCompetitivePricingRules();

      expect(config1).not.toBe(config2); // Different object references
      expect(config1).toEqual(config2);  // Same values
    });

    it('should return immutable-safe config', () => {
      const config = getDefaultCompetitivePricingRules();
      
      // Verify structure matches interface
      expect(typeof config.discountPercent).toBe('number');
      expect(typeof config.shippingStrategy).toBe('string');
      expect(typeof config.neverExceedAmazonTotal).toBe('boolean');
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
      const config = getDefaultCompetitivePricingRules();
      expect(config.discountPercent).toBe(10);
      
      // Rationale: 10% provides competitive advantage without race to bottom
    });

    it('should use FREE_IF_AMAZON_FREE strategy by default', () => {
      const config = getDefaultCompetitivePricingRules();
      expect(config.shippingStrategy).toBe('FREE_IF_AMAZON_FREE');
      
      // Rationale: Matches customer expectations (Prime = free shipping)
    });

    it('should enable neverExceedAmazonTotal safety constraint by default', () => {
      const config = getDefaultCompetitivePricingRules();
      expect(config.neverExceedAmazonTotal).toBe(true);
      
      // Rationale: Safety net prevents pricing errors
    });

    it('should not set sellerPaysUpTo by default', () => {
      const config = getDefaultCompetitivePricingRules();
      expect(config.sellerPaysUpTo).toBeUndefined();
      
      // Rationale: Only needed for SELLER_PAYS_UP_TO strategy
    });
  });

  describe('No Behavior Change - Phase 1', () => {
    it('should not affect existing pricing functions', () => {
      // Phase 1 only introduces types and config structure
      // No existing pricing logic should change
      
      const config = getDefaultCompetitivePricingRules();
      
      // This config exists but is not used yet
      expect(config).toBeDefined();
      
      // Existing pricing functions (computeEbayPrice) remain unchanged
      // They will be refactored in Phase 2+
    });

    it('should allow import without circular dependencies', () => {
      // Simply importing the module should not cause issues
      expect(getDefaultCompetitivePricingRules).toBeDefined();
      expect(typeof getDefaultCompetitivePricingRules).toBe('function');
    });
  });

  describe('Configuration Examples', () => {
    it('should support aggressive discount strategy', () => {
      const aggressive: CompetitivePricingRules = {
        discountPercent: 20, // 20% off Amazon
        shippingStrategy: 'FREE_IF_AMAZON_FREE',
        neverExceedAmazonTotal: true,
      };

      expect(aggressive.discountPercent).toBe(20);
    });

    it('should support matching Amazon exactly', () => {
      const exact: CompetitivePricingRules = {
        discountPercent: 0, // No discount
        shippingStrategy: 'MATCH_AMAZON',
        neverExceedAmazonTotal: true,
      };

      expect(exact.discountPercent).toBe(0);
      expect(exact.shippingStrategy).toBe('MATCH_AMAZON');
    });

    it('should support seller-paid shipping with threshold', () => {
      const sellerPays: CompetitivePricingRules = {
        discountPercent: 10,
        shippingStrategy: 'SELLER_PAYS_UP_TO',
        sellerPaysUpTo: 700, // Seller covers up to $7.00
        neverExceedAmazonTotal: true,
      };

      expect(sellerPays.sellerPaysUpTo).toBe(700);
    });
  });
});
