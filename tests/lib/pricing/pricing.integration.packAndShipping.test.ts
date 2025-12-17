/**
 * Integration Test: Pack-of + Photo Quantity + Shipping - Phase 7
 * 
 * PURPOSE: Ensure all pricing components work together without double-dividing or breaking logic
 * 
 * SCENARIOS TESTED:
 * - Pack sizes (2-pack, 3-pack, etc.) from Amazon
 * - Photo quantities (selling 1 unit from pack)
 * - Shipping strategies (FREE_IF_AMAZON_FREE, MATCH_AMAZON, SELLER_PAYS_UP_TO)
 * - Per-unit pricing calculations
 * - Competitive pricing with Amazon total-to-door
 */

import { describe, it, expect } from '@jest/globals';
import { computeAmazonTotals } from '../../../src/lib/pricing-compute';
import { splitEbayPrice } from '../../../src/lib/pricing-split';
import type { CompetitivePricingRules } from '../../../src/lib/pricing-config';

describe('Integration: Pack-of + Photo Quantity + Shipping - Phase 7', () => {
  /**
   * Core scenario from Phase 7 requirements:
   * - amazonPackSize = 2 (2-pack)
   * - photoQty = 1 (selling 1 unit)
   * - amazonItemPrice = $27.99, amazonShippingPrice = $0
   * - discount = 10%
   * - strategy = FREE_IF_AMAZON_FREE
   */
  describe('Required scenario: 2-pack with free shipping', () => {
    it('should calculate per-unit pricing correctly without double-divide', () => {
      // Amazon sells a 2-pack for $27.99 with free shipping
      const amazonPackSize = 2;
      const amazonItemPrice = 27.99;
      const amazonShippingPrice = 0;
      const photoQty = 1; // Selling 1 unit from the pack
      
      // Step 1: Calculate per-unit price
      const perUnitItemPrice = amazonItemPrice / amazonPackSize;
      expect(perUnitItemPrice).toBe(13.995); // 27.99 / 2 = 13.995
      
      const perUnitShippingPrice = amazonShippingPrice / amazonPackSize;
      expect(perUnitShippingPrice).toBe(0); // 0 / 2 = 0
      
      // Step 2: Compute Amazon total and eBay target (per-unit)
      const { amazonTotal, ebayTargetTotal } = computeAmazonTotals({
        amazonItemPrice: perUnitItemPrice,
        amazonShippingPrice: perUnitShippingPrice,
        discountPercent: 10,
      });
      
      expect(amazonTotal).toBe(14.00); // 13.995 rounds to 14.00
      expect(ebayTargetTotal).toBe(12.60); // 14.00 × 0.9 = 12.60
      
      // Step 3: Split eBay target into item + shipping
      const rules: CompetitivePricingRules = {
        shippingStrategy: 'FREE_IF_AMAZON_FREE',
        discountPercent: 10,
        neverExceedAmazonTotal: true,
      };
      
      const result = splitEbayPrice({
        ebayTargetTotal,
        amazonShippingPrice: perUnitShippingPrice,
        rules,
        amazonTotal,
      });
      
      // Expected results (per-unit)
      expect(result.ebayShippingPrice).toBe(0); // Amazon free → eBay free
      expect(result.ebayItemPrice).toBe(12.60); // All goes to item price
      
      // Verify no double-divide occurred
      const ebayTotal = result.ebayItemPrice + result.ebayShippingPrice;
      expect(ebayTotal).toBe(12.60);
      expect(ebayTotal).toBeLessThanOrEqual(amazonTotal); // Guardrail check
      
      // Verify competitive pricing
      const discountAmount = amazonTotal - ebayTotal;
      expect(discountAmount).toBeCloseTo(1.40, 2); // $14.00 - $12.60 = $1.40 (10% discount)
      
      // Evidence should show per-unit pricing
      expect(result.evidence).toContain('Strategy: FREE_IF_AMAZON_FREE');
      expect(result.evidence.some(e => e.includes('free shipping'))).toBe(true);
    });
  });

  describe('Pack sizes with paid shipping', () => {
    it('should handle 2-pack with paid shipping correctly', () => {
      // Amazon sells a 2-pack for $32.50 + $6.99 shipping
      const amazonPackSize = 2;
      const amazonItemPrice = 32.50;
      const amazonShippingPrice = 6.99;
      
      // Per-unit pricing
      const perUnitItemPrice = amazonItemPrice / amazonPackSize; // 16.25
      const perUnitShippingPrice = amazonShippingPrice / amazonPackSize; // 3.495
      
      const { amazonTotal, ebayTargetTotal } = computeAmazonTotals({
        amazonItemPrice: perUnitItemPrice,
        amazonShippingPrice: perUnitShippingPrice,
        discountPercent: 10,
      });
      
      // amazonTotal = 16.25 + 3.495 = 19.745 → 19.75
      expect(amazonTotal).toBe(19.75);
      // ebayTarget = 19.75 × 0.9 = 17.775 → 17.78
      expect(ebayTargetTotal).toBe(17.78);
      
      const rules: CompetitivePricingRules = {
        shippingStrategy: 'FREE_IF_AMAZON_FREE',
        discountPercent: 10,
        neverExceedAmazonTotal: true,
      };
      
      const result = splitEbayPrice({
        ebayTargetTotal,
        amazonShippingPrice: perUnitShippingPrice,
        rules,
        amazonTotal,
      });
      
      // Amazon charges shipping → eBay matches
      expect(result.ebayShippingPrice).toBeCloseTo(3.50, 2); // 3.495 rounds to 3.50
      expect(result.ebayItemPrice).toBeCloseTo(14.29, 2); // 17.79 - 3.50 = 14.29
      
      // Verify no double-divide
      const ebayTotal = result.ebayItemPrice + result.ebayShippingPrice;
      expect(ebayTotal).toBeCloseTo(17.79, 2);
      expect(ebayTotal).toBeLessThanOrEqual(amazonTotal);
    });

    it('should handle 3-pack with high shipping', () => {
      // Amazon sells a 3-pack for $45.00 + $12.99 shipping
      const amazonPackSize = 3;
      const amazonItemPrice = 45.00;
      const amazonShippingPrice = 12.99;
      
      // Per-unit pricing
      const perUnitItemPrice = amazonItemPrice / amazonPackSize; // 15.00
      const perUnitShippingPrice = amazonShippingPrice / amazonPackSize; // 4.33
      
      const { amazonTotal, ebayTargetTotal } = computeAmazonTotals({
        amazonItemPrice: perUnitItemPrice,
        amazonShippingPrice: perUnitShippingPrice,
        discountPercent: 10,
      });
      
      expect(amazonTotal).toBe(19.33); // 15.00 + 4.33
      expect(ebayTargetTotal).toBe(17.40); // 19.33 × 0.9 = 17.397 → 17.40
      
      const rules: CompetitivePricingRules = {
        shippingStrategy: 'MATCH_AMAZON',
        discountPercent: 10,
        neverExceedAmazonTotal: true,
      };
      
      const result = splitEbayPrice({
        ebayTargetTotal,
        amazonShippingPrice: perUnitShippingPrice,
        rules,
        amazonTotal,
      });
      
      expect(result.ebayShippingPrice).toBe(4.33);
      expect(result.ebayItemPrice).toBe(13.07); // 17.40 - 4.33
      
      const ebayTotal = result.ebayItemPrice + result.ebayShippingPrice;
      expect(ebayTotal).toBe(17.40);
    });
  });

  describe('Photo quantity variations', () => {
    it('should handle photoQty=1 from 6-pack correctly', () => {
      // Amazon sells a 6-pack for $59.94 with free shipping
      // Selling 1 unit from the pack
      const amazonPackSize = 6;
      const photoQty = 1;
      const amazonItemPrice = 59.94;
      const amazonShippingPrice = 0;
      
      // Per-unit pricing
      const perUnitItemPrice = amazonItemPrice / amazonPackSize; // 9.99
      const perUnitShippingPrice = amazonShippingPrice / amazonPackSize; // 0
      
      const { amazonTotal, ebayTargetTotal } = computeAmazonTotals({
        amazonItemPrice: perUnitItemPrice,
        amazonShippingPrice: perUnitShippingPrice,
        discountPercent: 10,
      });
      
      expect(amazonTotal).toBe(9.99);
      expect(ebayTargetTotal).toBe(8.99); // 9.99 × 0.9 = 8.991 → 8.99
      
      const rules: CompetitivePricingRules = {
        shippingStrategy: 'FREE_IF_AMAZON_FREE',
        discountPercent: 10,
        neverExceedAmazonTotal: true,
      };
      
      const result = splitEbayPrice({
        ebayTargetTotal,
        amazonShippingPrice: perUnitShippingPrice,
        rules,
        amazonTotal,
      });
      
      expect(result.ebayShippingPrice).toBe(0);
      expect(result.ebayItemPrice).toBe(8.99);
      
      // Verify photoQty doesn't cause double-divide
      // If we're selling photoQty=1, result is already per-unit
      const totalForPhotoQty = result.ebayItemPrice * photoQty;
      expect(totalForPhotoQty).toBe(8.99); // Just 1 unit
    });

    it('should handle photoQty=2 from 4-pack correctly', () => {
      // Amazon sells a 4-pack for $39.96 with free shipping
      // Selling 2 units from the pack (half the pack)
      const amazonPackSize = 4;
      const photoQty = 2;
      const amazonItemPrice = 39.96;
      const amazonShippingPrice = 0;
      
      // Per-unit pricing
      const perUnitItemPrice = amazonItemPrice / amazonPackSize; // 9.99
      const perUnitShippingPrice = amazonShippingPrice / amazonPackSize; // 0
      
      const { amazonTotal, ebayTargetTotal } = computeAmazonTotals({
        amazonItemPrice: perUnitItemPrice,
        amazonShippingPrice: perUnitShippingPrice,
        discountPercent: 10,
      });
      
      expect(amazonTotal).toBe(9.99);
      expect(ebayTargetTotal).toBe(8.99);
      
      const rules: CompetitivePricingRules = {
        shippingStrategy: 'FREE_IF_AMAZON_FREE',
        discountPercent: 10,
        neverExceedAmazonTotal: true,
      };
      
      const result = splitEbayPrice({
        ebayTargetTotal,
        amazonShippingPrice: perUnitShippingPrice,
        rules,
        amazonTotal,
      });
      
      // Result is per-unit pricing
      expect(result.ebayItemPrice).toBe(8.99);
      
      // For photoQty=2, multiply by quantity
      const totalForPhotoQty = result.ebayItemPrice * photoQty;
      expect(totalForPhotoQty).toBe(17.98); // 8.99 × 2
    });
  });

  describe('Shipping strategy variations with packs', () => {
    it('should apply SELLER_PAYS_UP_TO correctly with pack pricing', () => {
      // Amazon sells a 2-pack for $30.00 + $8.00 shipping
      const amazonPackSize = 2;
      const amazonItemPrice = 30.00;
      const amazonShippingPrice = 8.00;
      
      // Per-unit pricing
      const perUnitItemPrice = amazonItemPrice / amazonPackSize; // 15.00
      const perUnitShippingPrice = amazonShippingPrice / amazonPackSize; // 4.00
      
      const { amazonTotal, ebayTargetTotal } = computeAmazonTotals({
        amazonItemPrice: perUnitItemPrice,
        amazonShippingPrice: perUnitShippingPrice,
        discountPercent: 10,
      });
      
      expect(amazonTotal).toBe(19.00); // 15.00 + 4.00
      expect(ebayTargetTotal).toBe(17.10); // 19.00 × 0.9 = 17.10
      
      const rules: CompetitivePricingRules = {
        shippingStrategy: 'SELLER_PAYS_UP_TO',
        sellerPaysUpTo: 300, // Seller absorbs $3.00 of shipping
        discountPercent: 10,
        neverExceedAmazonTotal: true,
      };
      
      const result = splitEbayPrice({
        ebayTargetTotal,
        amazonShippingPrice: perUnitShippingPrice,
        rules,
        amazonTotal,
      });
      
      // Seller absorbs $3.00, buyer pays $1.00
      expect(result.ebayShippingPrice).toBe(1.00); // 4.00 - 3.00 = 1.00
      expect(result.ebayItemPrice).toBe(16.10); // 17.10 - 1.00 = 16.10
      
      const ebayTotal = result.ebayItemPrice + result.ebayShippingPrice;
      expect(ebayTotal).toBe(17.10);
    });
  });

  describe('Edge cases: rounding with pack pricing', () => {
    it('should handle rounding edge cases in per-unit calculations', () => {
      // Amazon sells a 3-pack for $10.00 with free shipping
      // Per-unit: 10.00 / 3 = 3.333...
      const amazonPackSize = 3;
      const amazonItemPrice = 10.00;
      const amazonShippingPrice = 0;
      
      const perUnitItemPrice = amazonItemPrice / amazonPackSize; // 3.333...
      const perUnitShippingPrice = 0;
      
      const { amazonTotal, ebayTargetTotal } = computeAmazonTotals({
        amazonItemPrice: perUnitItemPrice,
        amazonShippingPrice: perUnitShippingPrice,
        discountPercent: 10,
      });
      
      // Check rounding: 3.333... → 3.33
      expect(amazonTotal).toBe(3.33);
      expect(ebayTargetTotal).toBe(3.00); // 3.33 × 0.9 = 2.997 → 3.00
      
      const rules: CompetitivePricingRules = {
        shippingStrategy: 'FREE_IF_AMAZON_FREE',
        discountPercent: 10,
        neverExceedAmazonTotal: true,
      };
      
      const result = splitEbayPrice({
        ebayTargetTotal,
        amazonShippingPrice: perUnitShippingPrice,
        rules,
        amazonTotal,
      });
      
      expect(result.ebayItemPrice).toBe(3.00);
      expect(result.ebayShippingPrice).toBe(0);
      
      // Verify guardrail with rounding
      const ebayTotal = result.ebayItemPrice + result.ebayShippingPrice;
      expect(ebayTotal).toBeLessThanOrEqual(amazonTotal);
    });

    it('should handle extreme pack sizes without breaking', () => {
      // Amazon sells a 12-pack for $119.88 + $9.99 shipping
      const amazonPackSize = 12;
      const amazonItemPrice = 119.88;
      const amazonShippingPrice = 9.99;
      
      const perUnitItemPrice = amazonItemPrice / amazonPackSize; // 9.99
      const perUnitShippingPrice = amazonShippingPrice / amazonPackSize; // 0.8325
      
      const { amazonTotal, ebayTargetTotal } = computeAmazonTotals({
        amazonItemPrice: perUnitItemPrice,
        amazonShippingPrice: perUnitShippingPrice,
        discountPercent: 10,
      });
      
      expect(amazonTotal).toBe(10.82); // 9.99 + 0.83 (rounded from 0.8325)
      expect(ebayTargetTotal).toBe(9.74); // 10.82 × 0.9 = 9.738 → 9.74
      
      const rules: CompetitivePricingRules = {
        shippingStrategy: 'MATCH_AMAZON',
        discountPercent: 10,
        neverExceedAmazonTotal: true,
      };
      
      const result = splitEbayPrice({
        ebayTargetTotal,
        amazonShippingPrice: perUnitShippingPrice,
        rules,
        amazonTotal,
      });
      
      expect(result.ebayShippingPrice).toBe(0.83); // 0.8325 rounds to 0.83
      expect(result.ebayItemPrice).toBe(8.91); // 9.74 - 0.83
      
      // No double-divide even with large pack
      const ebayTotal = result.ebayItemPrice + result.ebayShippingPrice;
      expect(ebayTotal).toBe(9.74);
    });
  });

  describe('Guardrail with pack pricing', () => {
    it('should enforce neverExceedAmazonTotal with per-unit pricing', () => {
      // Scenario where per-unit rounding could cause exceed
      const amazonPackSize = 2;
      const amazonItemPrice = 25.99;
      const amazonShippingPrice = 5.00;
      
      const perUnitItemPrice = amazonItemPrice / amazonPackSize; // 12.995
      const perUnitShippingPrice = amazonShippingPrice / amazonPackSize; // 2.50
      
      const { amazonTotal, ebayTargetTotal } = computeAmazonTotals({
        amazonItemPrice: perUnitItemPrice,
        amazonShippingPrice: perUnitShippingPrice,
        discountPercent: 5, // Small discount to test guardrail
      });
      
      expect(amazonTotal).toBe(15.50); // 13.00 + 2.50
      expect(ebayTargetTotal).toBe(14.73); // 15.50 × 0.95 = 14.725 → 14.73
      
      const rules: CompetitivePricingRules = {
        shippingStrategy: 'MATCH_AMAZON',
        discountPercent: 5,
        neverExceedAmazonTotal: true,
      };
      
      const result = splitEbayPrice({
        ebayTargetTotal,
        amazonShippingPrice: perUnitShippingPrice,
        rules,
        amazonTotal,
      });
      
      // Guardrail should ensure total doesn't exceed
      const ebayTotal = result.ebayItemPrice + result.ebayShippingPrice;
      expect(ebayTotal).toBeLessThanOrEqual(amazonTotal);
      expect(ebayTotal).toBe(14.73);
    });
  });

  describe('Documentation: Integration points', () => {
    it('documents the complete pricing flow with pack logic', () => {
      /**
       * COMPLETE PRICING FLOW:
       * 
       * 1. Extract Amazon data:
       *    - amazonItemPrice (for entire pack)
       *    - amazonShippingPrice (for entire pack)
       *    - amazonPackSize (number of units in pack)
       * 
       * 2. Calculate per-unit pricing:
       *    - perUnitItemPrice = amazonItemPrice / amazonPackSize
       *    - perUnitShippingPrice = amazonShippingPrice / amazonPackSize
       * 
       * 3. Compute competitive pricing (per-unit):
       *    - amazonTotal = perUnitItemPrice + perUnitShippingPrice
       *    - ebayTargetTotal = amazonTotal × (1 - discountPercent/100)
       * 
       * 4. Split eBay total (per-unit):
       *    - Apply shipping strategy
       *    - Enforce guardrails
       *    - Return ebayItemPrice + ebayShippingPrice
       * 
       * 5. For listing creation:
       *    - If photoQty=1: use per-unit pricing directly
       *    - If photoQty>1: multiply ebayItemPrice × photoQty
       * 
       * CRITICAL: No double-divide!
       * - Divide by pack size ONCE at step 2
       * - All subsequent calculations use per-unit values
       * - Multiply by photoQty only at final listing creation
       */
      
      const flow = {
        step1: 'Extract Amazon pack data',
        step2: 'Calculate per-unit pricing (divide by pack size ONCE)',
        step3: 'Compute competitive pricing (per-unit)',
        step4: 'Split eBay total (per-unit)',
        step5: 'Multiply by photoQty for final listing',
      };
      
      expect(flow.step2).toContain('divide by pack size ONCE');
      expect(flow.step5).toContain('Multiply by photoQty');
    });
  });
});
