/**
 * Tests for eBay price splitting strategy - Phase 4
 * 
 * PURPOSE: Verify pure function splits eBay target total into item + shipping
 * 
 * ACCEPTANCE CRITERIA:
 * ✅ Pure function only (no network, no env)
 * ✅ Doesn't return negative item price
 * ✅ Evidence explains what happened (string array)
 */

import { splitEbayPrice } from '../../../src/lib/pricing-split';
import type { CompetitivePricingRules } from '../../../src/lib/pricing-config';

describe('eBay Price Splitting Strategy - Phase 4', () => {
  describe('Required test cases from Phase 4 spec', () => {
    it('FREE_IF_AMAZON_FREE, ship=0 → ship 0, item = target', () => {
      const rules: CompetitivePricingRules = {
        shippingStrategy: 'FREE_IF_AMAZON_FREE',
        discountPercent: 10,
        neverExceedAmazonTotal: true,
      };

      const result = splitEbayPrice({
        ebayTargetTotal: 15.29,
        amazonShippingPrice: 0,
        rules,
      });

      expect(result.ebayShippingPrice).toBe(0);
      expect(result.ebayItemPrice).toBe(15.29);
      expect(result.evidence).toContain('Strategy: FREE_IF_AMAZON_FREE');
      expect(result.evidence).toContain('Amazon has free shipping → eBay offers free shipping');
    });

    it('FREE_IF_AMAZON_FREE, ship=5.99 → ship 5.99, item = target-5.99', () => {
      const rules: CompetitivePricingRules = {
        shippingStrategy: 'FREE_IF_AMAZON_FREE',
        discountPercent: 10,
        neverExceedAmazonTotal: true,
      };

      const result = splitEbayPrice({
        ebayTargetTotal: 20.68,
        amazonShippingPrice: 5.99,
        rules,
      });

      expect(result.ebayShippingPrice).toBe(5.99);
      expect(result.ebayItemPrice).toBe(14.69); // 20.68 - 5.99 = 14.69
      expect(result.evidence).toContain('Strategy: FREE_IF_AMAZON_FREE');
      expect(result.evidence.some(e => e.includes('matches'))).toBe(true);
    });

    it('MATCH_AMAZON, ship=0 → ship 0', () => {
      const rules: CompetitivePricingRules = {
        shippingStrategy: 'MATCH_AMAZON',
        discountPercent: 10,
        neverExceedAmazonTotal: true,
      };

      const result = splitEbayPrice({
        ebayTargetTotal: 41.39,
        amazonShippingPrice: 0,
        rules,
      });

      expect(result.ebayShippingPrice).toBe(0);
      expect(result.ebayItemPrice).toBe(41.39);
      expect(result.evidence).toContain('Strategy: MATCH_AMAZON');
    });

    it('MATCH_AMAZON, ship=5.99 → split as expected', () => {
      const rules: CompetitivePricingRules = {
        shippingStrategy: 'MATCH_AMAZON',
        discountPercent: 10,
        neverExceedAmazonTotal: true,
      };

      const result = splitEbayPrice({
        ebayTargetTotal: 20.68,
        amazonShippingPrice: 5.99,
        rules,
      });

      expect(result.ebayShippingPrice).toBe(5.99);
      expect(result.ebayItemPrice).toBe(14.69); // 20.68 - 5.99 = 14.69
      expect(result.evidence).toContain('Strategy: MATCH_AMAZON');
      expect(result.evidence.some(e => e.includes('Amazon shipping'))).toBe(true);
    });

    it('SELLER_PAYS_UP_TO, ship=5.99, sellerPaysUpTo=6 → ebayShip 0', () => {
      const rules: CompetitivePricingRules = {
        shippingStrategy: 'SELLER_PAYS_UP_TO',
        sellerPaysUpTo: 600, // $6.00 in cents
        discountPercent: 10,
        neverExceedAmazonTotal: true,
      };

      const result = splitEbayPrice({
        ebayTargetTotal: 20.68,
        amazonShippingPrice: 5.99,
        rules,
      });

      // Seller covers $6.00, Amazon shipping is $5.99, so buyer pays $0
      expect(result.ebayShippingPrice).toBe(0);
      expect(result.ebayItemPrice).toBe(20.68); // Full target as item price
      expect(result.evidence).toContain('Strategy: SELLER_PAYS_UP_TO');
    });

    it('SELLER_PAYS_UP_TO, ship=9.99, sellerPaysUpTo=6 → ebayShip 3.99', () => {
      const rules: CompetitivePricingRules = {
        shippingStrategy: 'SELLER_PAYS_UP_TO',
        sellerPaysUpTo: 600, // $6.00 in cents
        discountPercent: 10,
        neverExceedAmazonTotal: true,
      };

      const result = splitEbayPrice({
        ebayTargetTotal: 35.54,
        amazonShippingPrice: 9.99,
        rules,
      });

      // Seller covers $6.00, buyer pays $3.99
      expect(result.ebayShippingPrice).toBe(3.99); // 9.99 - 6.00 = 3.99
      expect(result.ebayItemPrice).toBe(31.55); // 35.54 - 3.99 = 31.55
      expect(result.evidence).toContain('Strategy: SELLER_PAYS_UP_TO');
    });
  });

  describe('Strategy: FREE_IF_AMAZON_FREE', () => {
    const rules: CompetitivePricingRules = {
      shippingStrategy: 'FREE_IF_AMAZON_FREE',
      discountPercent: 10,
      neverExceedAmazonTotal: true,
    };

    it('should offer free shipping when Amazon has free shipping', () => {
      const result = splitEbayPrice({
        ebayTargetTotal: 45.99,
        amazonShippingPrice: 0,
        rules,
      });

      expect(result.ebayShippingPrice).toBe(0);
      expect(result.ebayItemPrice).toBe(45.99);
      expect(result.evidence).toContain('Amazon has free shipping → eBay offers free shipping');
    });

    it('should match Amazon shipping when Amazon charges', () => {
      const result = splitEbayPrice({
        ebayTargetTotal: 35.54,
        amazonShippingPrice: 6.99,
        rules,
      });

      expect(result.ebayShippingPrice).toBe(6.99);
      expect(result.ebayItemPrice).toBe(28.55); // 35.54 - 6.99
    });

    it('should handle high shipping relative to target', () => {
      const result = splitEbayPrice({
        ebayTargetTotal: 10.00,
        amazonShippingPrice: 8.00,
        rules,
      });

      expect(result.ebayShippingPrice).toBe(8.00);
      expect(result.ebayItemPrice).toBe(2.00); // 10.00 - 8.00
    });
  });

  describe('Strategy: MATCH_AMAZON', () => {
    const rules: CompetitivePricingRules = {
      shippingStrategy: 'MATCH_AMAZON',
      discountPercent: 10,
      neverExceedAmazonTotal: true,
    };

    it('should always match Amazon shipping exactly', () => {
      const result = splitEbayPrice({
        ebayTargetTotal: 50.00,
        amazonShippingPrice: 12.50,
        rules,
      });

      expect(result.ebayShippingPrice).toBe(12.50);
      expect(result.ebayItemPrice).toBe(37.50); // 50.00 - 12.50
    });

    it('should handle free Amazon shipping', () => {
      const result = splitEbayPrice({
        ebayTargetTotal: 30.00,
        amazonShippingPrice: 0,
        rules,
      });

      expect(result.ebayShippingPrice).toBe(0);
      expect(result.ebayItemPrice).toBe(30.00);
    });

    it('should work same as FREE_IF_AMAZON_FREE (behavior overlap)', () => {
      const matchRules = { ...rules, shippingStrategy: 'MATCH_AMAZON' as const };
      const freeIfFreeRules = { ...rules, shippingStrategy: 'FREE_IF_AMAZON_FREE' as const };

      const result1 = splitEbayPrice({
        ebayTargetTotal: 25.00,
        amazonShippingPrice: 5.00,
        rules: matchRules,
      });

      const result2 = splitEbayPrice({
        ebayTargetTotal: 25.00,
        amazonShippingPrice: 5.00,
        rules: freeIfFreeRules,
      });

      // Results should be identical (both charge $5 shipping)
      expect(result1.ebayShippingPrice).toBe(result2.ebayShippingPrice);
      expect(result1.ebayItemPrice).toBe(result2.ebayItemPrice);
    });
  });

  describe('Strategy: SELLER_PAYS_UP_TO', () => {
    it('should absorb all shipping when under threshold', () => {
      const rules: CompetitivePricingRules = {
        shippingStrategy: 'SELLER_PAYS_UP_TO',
        sellerPaysUpTo: 1000, // $10.00
        discountPercent: 10,
        neverExceedAmazonTotal: true,
      };

      const result = splitEbayPrice({
        ebayTargetTotal: 30.00,
        amazonShippingPrice: 7.50,
        rules,
      });

      // Seller covers all $7.50 (under $10 threshold)
      expect(result.ebayShippingPrice).toBe(0);
      expect(result.ebayItemPrice).toBe(30.00);
    });

    it('should split shipping when over threshold', () => {
      const rules: CompetitivePricingRules = {
        shippingStrategy: 'SELLER_PAYS_UP_TO',
        sellerPaysUpTo: 500, // $5.00
        discountPercent: 10,
        neverExceedAmazonTotal: true,
      };

      const result = splitEbayPrice({
        ebayTargetTotal: 40.00,
        amazonShippingPrice: 12.00,
        rules,
      });

      // Seller covers $5.00, buyer pays $7.00
      expect(result.ebayShippingPrice).toBe(7.00); // 12.00 - 5.00
      expect(result.ebayItemPrice).toBe(33.00); // 40.00 - 7.00
    });

    it('should handle exactly at threshold', () => {
      const rules: CompetitivePricingRules = {
        shippingStrategy: 'SELLER_PAYS_UP_TO',
        sellerPaysUpTo: 699, // $6.99
        discountPercent: 10,
        neverExceedAmazonTotal: true,
      };

      const result = splitEbayPrice({
        ebayTargetTotal: 25.00,
        amazonShippingPrice: 6.99,
        rules,
      });

      // Seller covers exact $6.99
      expect(result.ebayShippingPrice).toBe(0);
      expect(result.ebayItemPrice).toBe(25.00);
    });

    it('should handle threshold of 0 (no seller contribution)', () => {
      const rules: CompetitivePricingRules = {
        shippingStrategy: 'SELLER_PAYS_UP_TO',
        sellerPaysUpTo: 0,
        discountPercent: 10,
        neverExceedAmazonTotal: true,
      };

      const result = splitEbayPrice({
        ebayTargetTotal: 30.00,
        amazonShippingPrice: 8.00,
        rules,
      });

      // Buyer pays all shipping
      expect(result.ebayShippingPrice).toBe(8.00);
      expect(result.ebayItemPrice).toBe(22.00); // 30.00 - 8.00
    });
  });

  describe('Guardrail: neverExceedAmazonTotal', () => {
    it('should enforce when enabled and amazonTotal provided', () => {
      const rules: CompetitivePricingRules = {
        shippingStrategy: 'MATCH_AMAZON',
        discountPercent: 10,
        neverExceedAmazonTotal: true,
      };

      const result = splitEbayPrice({
        ebayTargetTotal: 50.00, // Would exceed
        amazonShippingPrice: 10.00,
        rules,
        amazonTotal: 45.00, // Cap at $45
      });

      const ebayTotal = result.ebayItemPrice + result.ebayShippingPrice;
      
      expect(ebayTotal).toBeLessThanOrEqual(45.00);
      expect(result.evidence.some(e => e.includes('Guardrail'))).toBe(true);
    });

    it('should not interfere when eBay total is under Amazon total', () => {
      const rules: CompetitivePricingRules = {
        shippingStrategy: 'FREE_IF_AMAZON_FREE',
        discountPercent: 10,
        neverExceedAmazonTotal: true,
      };

      const result = splitEbayPrice({
        ebayTargetTotal: 35.00,
        amazonShippingPrice: 5.00,
        rules,
        amazonTotal: 50.00, // Well above
      });

      expect(result.ebayItemPrice).toBe(30.00); // 35 - 5
      expect(result.ebayShippingPrice).toBe(5.00);
      expect(result.evidence.some(e => e.includes('Guardrail passed'))).toBe(true);
    });

    it('should reduce item price first when exceeding', () => {
      const rules: CompetitivePricingRules = {
        shippingStrategy: 'FREE_IF_AMAZON_FREE',
        discountPercent: 10,
        neverExceedAmazonTotal: true,
      };

      const result = splitEbayPrice({
        ebayTargetTotal: 40.00,
        amazonShippingPrice: 5.00,
        rules,
        amazonTotal: 38.00, // Force reduction
      });

      // Should reduce item price to fit: 38.00 - 5.00 = 33.00
      expect(result.ebayItemPrice).toBe(33.00);
      expect(result.ebayShippingPrice).toBe(5.00);
      expect(result.ebayItemPrice + result.ebayShippingPrice).toBe(38.00);
    });

    it('should not apply when disabled', () => {
      const rules: CompetitivePricingRules = {
        shippingStrategy: 'MATCH_AMAZON',
        discountPercent: 10,
        neverExceedAmazonTotal: false, // Disabled
      };

      const result = splitEbayPrice({
        ebayTargetTotal: 50.00,
        amazonShippingPrice: 10.00,
        rules,
        amazonTotal: 45.00, // Would normally cap
      });

      // Should not be capped since guardrail is disabled
      expect(result.ebayItemPrice).toBe(40.00); // 50 - 10
      expect(result.ebayShippingPrice).toBe(10.00);
      expect(result.ebayItemPrice + result.ebayShippingPrice).toBe(50.00);
    });
  });

  describe('Non-negative item price guarantee', () => {
    it('should never return negative item price', () => {
      const rules: CompetitivePricingRules = {
        shippingStrategy: 'MATCH_AMAZON',
        discountPercent: 10,
        neverExceedAmazonTotal: true,
      };

      const result = splitEbayPrice({
        ebayTargetTotal: 5.00,
        amazonShippingPrice: 10.00, // Shipping > target
        rules,
      });

      expect(result.ebayItemPrice).toBeGreaterThanOrEqual(0);
      expect(result.ebayItemPrice).toBe(0); // Clamped to 0
      expect(result.ebayShippingPrice).toBe(10.00);
    });

    it('should clamp to 0 when calculation would be negative', () => {
      const rules: CompetitivePricingRules = {
        shippingStrategy: 'FREE_IF_AMAZON_FREE',
        discountPercent: 10,
        neverExceedAmazonTotal: true,
      };

      const result = splitEbayPrice({
        ebayTargetTotal: 8.00,
        amazonShippingPrice: 12.00,
        rules,
      });

      // Would be 8.00 - 12.00 = -4.00, but clamped to 0
      expect(result.ebayItemPrice).toBe(0);
      expect(result.ebayShippingPrice).toBe(12.00);
    });
  });

  describe('Pure function properties', () => {
    it('should be deterministic (same input → same output)', () => {
      const rules: CompetitivePricingRules = {
        shippingStrategy: 'FREE_IF_AMAZON_FREE',
        discountPercent: 10,
        neverExceedAmazonTotal: true,
      };

      const input = {
        ebayTargetTotal: 20.68,
        amazonShippingPrice: 5.99,
        rules,
      };

      const result1 = splitEbayPrice(input);
      const result2 = splitEbayPrice(input);

      expect(result1).toEqual(result2);
    });

    it('should not mutate input', () => {
      const rules: CompetitivePricingRules = {
        shippingStrategy: 'MATCH_AMAZON',
        discountPercent: 10,
        neverExceedAmazonTotal: true,
      };

      const input = {
        ebayTargetTotal: 30.00,
        amazonShippingPrice: 5.00,
        rules,
      };

      const inputCopy = JSON.parse(JSON.stringify(input));
      splitEbayPrice(input);

      expect(input).toEqual(inputCopy);
    });

    it('should have no side effects', () => {
      const rules: CompetitivePricingRules = {
        shippingStrategy: 'SELLER_PAYS_UP_TO',
        sellerPaysUpTo: 500,
        discountPercent: 10,
        neverExceedAmazonTotal: true,
      };

      // Call multiple times
      splitEbayPrice({ ebayTargetTotal: 25.00, amazonShippingPrice: 7.00, rules });
      splitEbayPrice({ ebayTargetTotal: 30.00, amazonShippingPrice: 8.00, rules });
      const result = splitEbayPrice({ ebayTargetTotal: 35.00, amazonShippingPrice: 9.00, rules });

      // Should only depend on current inputs
      expect(result.ebayItemPrice).toBe(31.00); // 35 - 4 (9 - 5)
      expect(result.ebayShippingPrice).toBe(4.00);
    });
  });

  describe('Evidence array', () => {
    it('should always return evidence array', () => {
      const rules: CompetitivePricingRules = {
        shippingStrategy: 'FREE_IF_AMAZON_FREE',
        discountPercent: 10,
        neverExceedAmazonTotal: true,
      };

      const result = splitEbayPrice({
        ebayTargetTotal: 20.00,
        amazonShippingPrice: 0,
        rules,
      });

      expect(Array.isArray(result.evidence)).toBe(true);
      expect(result.evidence.length).toBeGreaterThan(0);
    });

    it('should explain strategy used', () => {
      const rules: CompetitivePricingRules = {
        shippingStrategy: 'SELLER_PAYS_UP_TO',
        sellerPaysUpTo: 600,
        discountPercent: 10,
        neverExceedAmazonTotal: true,
      };

      const result = splitEbayPrice({
        ebayTargetTotal: 25.00,
        amazonShippingPrice: 5.00,
        rules,
      });

      expect(result.evidence.some(e => e.includes('SELLER_PAYS_UP_TO'))).toBe(true);
    });

    it('should document guardrail actions', () => {
      const rules: CompetitivePricingRules = {
        shippingStrategy: 'MATCH_AMAZON',
        discountPercent: 10,
        neverExceedAmazonTotal: true,
      };

      const result = splitEbayPrice({
        ebayTargetTotal: 50.00,
        amazonShippingPrice: 5.00,
        rules,
        amazonTotal: 48.00,
      });

      expect(result.evidence.some(e => e.includes('Guardrail'))).toBe(true);
    });
  });

  describe('Rounding and precision', () => {
    it('should round results to cents', () => {
      const rules: CompetitivePricingRules = {
        shippingStrategy: 'FREE_IF_AMAZON_FREE',
        discountPercent: 10,
        neverExceedAmazonTotal: true,
      };

      const result = splitEbayPrice({
        ebayTargetTotal: 33.333,
        amazonShippingPrice: 6.667,
        rules,
      });

      // Should be rounded to 2 decimals
      expect(result.ebayItemPrice).toBe(26.67); // 33.33 - 6.67 = 26.66 (rounded from 26.666)
      expect(result.ebayShippingPrice).toBe(6.67);
    });
  });
});
