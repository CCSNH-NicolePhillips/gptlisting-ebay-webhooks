/**
 * Competitive Pricing Integration Tests - Phase 5
 * 
 * Tests the feature flag integration and dual-mode behavior
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  isCompetitivePricingEnabled,
  calculateCompetitivePricing,
  calculateEbayPriceWithFlag,
} from '../../../src/lib/competitive-pricing';
import type { CompetitivePricingRules } from '../../../src/lib/pricing-config';
import fs from 'fs';
import path from 'path';

describe('Competitive Pricing Integration - Phase 5', () => {
  // Save original env
  const originalEnv = process.env.DP_COMPETITIVE_PRICING_V2;

  afterEach(() => {
    // Restore original env after each test
    if (originalEnv === undefined) {
      delete process.env.DP_COMPETITIVE_PRICING_V2;
    } else {
      process.env.DP_COMPETITIVE_PRICING_V2 = originalEnv;
    }
  });

  describe('Feature flag: DP_COMPETITIVE_PRICING_V2', () => {
    it('should be disabled by default', () => {
      delete process.env.DP_COMPETITIVE_PRICING_V2;
      expect(isCompetitivePricingEnabled()).toBe(false);
    });

    it('should be disabled when set to false', () => {
      process.env.DP_COMPETITIVE_PRICING_V2 = 'false';
      expect(isCompetitivePricingEnabled()).toBe(false);
    });

    it('should be disabled for any non-true value', () => {
      process.env.DP_COMPETITIVE_PRICING_V2 = '1';
      expect(isCompetitivePricingEnabled()).toBe(false);

      process.env.DP_COMPETITIVE_PRICING_V2 = 'yes';
      expect(isCompetitivePricingEnabled()).toBe(false);

      process.env.DP_COMPETITIVE_PRICING_V2 = 'TRUE';
      expect(isCompetitivePricingEnabled()).toBe(false);
    });

    it('should be enabled when set to true', () => {
      process.env.DP_COMPETITIVE_PRICING_V2 = 'true';
      expect(isCompetitivePricingEnabled()).toBe(true);
    });
  });

  describe('calculateCompetitivePricing', () => {
    const freeShippingHtml = fs.readFileSync(
      path.join(__dirname, '../../fixtures/amazon-free-shipping.html'),
      'utf-8'
    );

    const paidShippingHtml = fs.readFileSync(
      path.join(__dirname, '../../fixtures/amazon-paid-shipping.html'),
      'utf-8'
    );

    it('should calculate competitive pricing from Amazon free shipping HTML', () => {
      const result = calculateCompetitivePricing(freeShippingHtml, 'Nature Made Vitamin D3');

      expect(result).not.toBeNull();
      expect(result!.amazonData.itemPrice).toBe(16.99);
      expect(result!.amazonData.shippingPrice).toBe(0);
      expect(result!.amazonData.totalPrice).toBe(16.99);
      expect(result!.amazonData.shippingEvidence).toBe('free');

      // Default 10% discount: 16.99 × 0.9 = 15.291 → 15.29
      expect(result!.ebayItemPrice).toBe(15.29);
      expect(result!.ebayShippingPrice).toBe(0);

      // Should have evidence
      expect(result!.evidence).toContain('Amazon: $16.99 + $0.00 shipping (free)');
      expect(result!.evidence.length).toBeGreaterThan(0);
    });

    it('should calculate competitive pricing from Amazon paid shipping HTML', () => {
      const result = calculateCompetitivePricing(paidShippingHtml, 'Heavy Equipment Parts');

      expect(result).not.toBeNull();
      expect(result!.amazonData.itemPrice).toBe(32.50);
      expect(result!.amazonData.shippingPrice).toBe(6.99);
      expect(result!.amazonData.totalPrice).toBe(39.49);
      expect(result!.amazonData.shippingEvidence).toBe('paid');

      // Default 10% discount on total: 39.49 × 0.9 = 35.541 → 35.54
      // ALGO_COMPETITIVE_TOTAL strategy: apply discount to total, eBay free shipping
      expect(result!.ebayItemPrice).toBe(35.54); // Discounted total becomes item price
      expect(result!.ebayShippingPrice).toBe(0); // Free shipping on eBay

      expect(result!.evidence).toContain('Amazon: $32.50 + $6.99 shipping (paid)');
    });

    it('should return null for invalid HTML', () => {
      const result = calculateCompetitivePricing('<html><body>No price here</body></html>');
      expect(result).toBeNull();
    });

    it('should respect custom pricing rules', () => {
      const customRules: CompetitivePricingRules = {
        discountPercent: 15, // 15% discount instead of 10%
        shippingStrategy: 'MATCH_AMAZON',
        neverExceedAmazonTotal: true,
      };

      const result = calculateCompetitivePricing(freeShippingHtml, 'Nature Made Vitamin D3', customRules);

      expect(result).not.toBeNull();
      // 16.99 × 0.85 = 14.4415 → 14.44
      expect(result!.ebayItemPrice).toBe(14.44);
      expect(result!.ebayShippingPrice).toBe(0);
    });

    it('should use SELLER_PAYS_UP_TO strategy when configured', () => {
      const rules: CompetitivePricingRules = {
        discountPercent: 10,
        shippingStrategy: 'SELLER_PAYS_UP_TO',
        sellerPaysUpTo: 500, // $5.00 in cents
        neverExceedAmazonTotal: true,
      };

      const result = calculateCompetitivePricing(paidShippingHtml, 'Heavy Equipment Parts', rules);

      expect(result).not.toBeNull();
      // Amazon shipping $6.99, seller pays $5.00, buyer pays $1.99
      expect(result!.ebayShippingPrice).toBe(1.99);
      expect(result!.ebayItemPrice).toBe(33.55); // 35.54 - 1.99
    });
  });

  describe('calculateEbayPriceWithFlag - Legacy Mode (flag OFF)', () => {
    beforeEach(() => {
      delete process.env.DP_COMPETITIVE_PRICING_V2;
    });

    it('should use legacy formula when flag is off', () => {
      const result = calculateEbayPriceWithFlag({ basePrice: 45.99 });

      expect(result.ebayItemPrice).toBe(36.39); // 45.99 × 0.9 - 5 = 36.391 → 36.39
      expect(result.ebayShippingPrice).toBe(0);
    });

    it('should handle low prices without $5 discount', () => {
      const result = calculateEbayPriceWithFlag({ basePrice: 19.99 });

      expect(result.ebayItemPrice).toBe(17.99); // 19.99 × 0.9 = 17.991 → 17.99
      expect(result.ebayShippingPrice).toBe(0);
    });

    it('should handle $30 threshold', () => {
      const result = calculateEbayPriceWithFlag({ basePrice: 30.00 });
      expect(result.ebayItemPrice).toBe(27.00); // No $5 discount at exactly $30

      const result2 = calculateEbayPriceWithFlag({ basePrice: 30.01 });
      expect(result2.ebayItemPrice).toBe(22.01); // $5 discount just above $30
    });

    it('should return 0 for invalid inputs', () => {
      expect(calculateEbayPriceWithFlag({ basePrice: 0 }).ebayItemPrice).toBe(0);
      expect(calculateEbayPriceWithFlag({ basePrice: -10 }).ebayItemPrice).toBe(0);
      expect(calculateEbayPriceWithFlag({ basePrice: NaN }).ebayItemPrice).toBe(0);
      expect(calculateEbayPriceWithFlag({ basePrice: Infinity }).ebayItemPrice).toBe(0);
    });

    it('should ignore amazonHtml when flag is off', () => {
      const freeShippingHtml = fs.readFileSync(
        path.join(__dirname, '../../fixtures/amazon-free-shipping.html'),
        'utf-8'
      );

      const result = calculateEbayPriceWithFlag({
        basePrice: 45.99,
        amazonHtml: freeShippingHtml,
        productTitle: 'Nature Made Vitamin D3',
      });

      // Should use legacy formula, not competitive pricing
      expect(result.ebayItemPrice).toBe(36.39);
      expect(result.ebayShippingPrice).toBe(0);
    });
  });

  describe('calculateEbayPriceWithFlag - Competitive Mode (flag ON)', () => {
    beforeEach(() => {
      process.env.DP_COMPETITIVE_PRICING_V2 = 'true';
    });

    const freeShippingHtml = fs.readFileSync(
      path.join(__dirname, '../../fixtures/amazon-free-shipping.html'),
      'utf-8'
    );

    const paidShippingHtml = fs.readFileSync(
      path.join(__dirname, '../../fixtures/amazon-paid-shipping.html'),
      'utf-8'
    );

    it('should use competitive pricing when flag is on', () => {
      const result = calculateEbayPriceWithFlag({
        amazonHtml: freeShippingHtml,
        productTitle: 'Nature Made Vitamin D3',
      });

      // Should use competitive pricing formula
      expect(result.ebayItemPrice).toBe(15.29); // 16.99 × 0.9 = 15.291 → 15.29
      expect(result.ebayShippingPrice).toBe(0);
    });

    it('should handle paid shipping with competitive pricing', () => {
      const result = calculateEbayPriceWithFlag({
        amazonHtml: paidShippingHtml,
        productTitle: 'Heavy Equipment Parts',
      });

      expect(result.ebayItemPrice).toBe(35.54); // (32.50 + 6.99) × 0.9 = 35.54
      expect(result.ebayShippingPrice).toBe(0); // Free shipping on eBay
    });

    it('should include evidence in CompetitivePricingResult', () => {
      const result = calculateEbayPriceWithFlag({
        amazonHtml: freeShippingHtml,
        productTitle: 'Nature Made Vitamin D3',
      });

      // Should be CompetitivePricingResult with evidence
      if ('evidence' in result) {
        expect(result.evidence).toContain('Amazon: $16.99 + $0.00 shipping (free)');
        expect(result.evidence.length).toBeGreaterThan(0);
      } else {
        fail('Expected CompetitivePricingResult with evidence');
      }
    });

    it('should fallback to legacy when HTML is missing', () => {
      const result = calculateEbayPriceWithFlag({
        basePrice: 45.99,
        // No amazonHtml provided
      });

      // Should fallback to legacy formula
      expect(result.ebayItemPrice).toBe(36.39);
      expect(result.ebayShippingPrice).toBe(0);
    });

    it('should fallback to legacy when HTML parsing fails', () => {
      const result = calculateEbayPriceWithFlag({
        basePrice: 45.99,
        amazonHtml: '<html><body>Invalid HTML</body></html>',
      });

      // Should fallback to legacy formula
      expect(result.ebayItemPrice).toBe(36.39);
      expect(result.ebayShippingPrice).toBe(0);
    });

    it('should respect custom rules in competitive mode', () => {
      const customRules: CompetitivePricingRules = {
        discountPercent: 15,
        shippingStrategy: 'MATCH_AMAZON',
        neverExceedAmazonTotal: true,
      };

      const result = calculateEbayPriceWithFlag({
        amazonHtml: freeShippingHtml,
        productTitle: 'Nature Made Vitamin D3',
        rules: customRules,
      });

      expect(result.ebayItemPrice).toBe(14.44); // 16.99 × 0.85
      expect(result.ebayShippingPrice).toBe(0);
    });
  });

  describe('Baseline regression - flag OFF should match old behavior exactly', () => {
    beforeEach(() => {
      delete process.env.DP_COMPETITIVE_PRICING_V2;
    });

    /**
     * These tests verify that with flag OFF, behavior is IDENTICAL to Phase 0 baseline
     */

    it('BASELINE: $45.99 free shipping → $36.39', () => {
      const result = calculateEbayPriceWithFlag({ basePrice: 45.99 });
      expect(result.ebayItemPrice).toBe(36.39);
      expect(result.ebayShippingPrice).toBe(0);
    });

    it('BASELINE: $19.99 free shipping → $17.99', () => {
      const result = calculateEbayPriceWithFlag({ basePrice: 19.99 });
      expect(result.ebayItemPrice).toBe(17.99);
      expect(result.ebayShippingPrice).toBe(0);
    });

    it('BASELINE: $32.50 paid shipping ignored → $24.25', () => {
      const result = calculateEbayPriceWithFlag({ basePrice: 32.50 });
      expect(result.ebayItemPrice).toBe(24.25);
      expect(result.ebayShippingPrice).toBe(0);
    });

    it('BASELINE: $15.00 high shipping ignored → $13.50', () => {
      const result = calculateEbayPriceWithFlag({ basePrice: 15.00 });
      expect(result.ebayItemPrice).toBe(13.50);
      expect(result.ebayShippingPrice).toBe(0);
    });
  });

  describe('New behavior - flag ON uses competitive pricing', () => {
    beforeEach(() => {
      process.env.DP_COMPETITIVE_PRICING_V2 = 'true';
    });

    const freeShippingHtml = fs.readFileSync(
      path.join(__dirname, '../../fixtures/amazon-free-shipping.html'),
      'utf-8'
    );

    const paidShippingHtml = fs.readFileSync(
      path.join(__dirname, '../../fixtures/amazon-paid-shipping.html'),
      'utf-8'
    );

    it('NEW: $16.99 free shipping → $15.29 (accounts for total-to-door)', () => {
      const result = calculateEbayPriceWithFlag({
        amazonHtml: freeShippingHtml,
        productTitle: 'Nature Made Vitamin D3',
      });

      expect(result.ebayItemPrice).toBe(15.29);
      expect(result.ebayShippingPrice).toBe(0);

      // This is different from legacy: 16.99 × 0.9 = 15.29 (no $5 discount)
      // vs legacy: 16.99 × 0.9 = 15.29 (same in this case, but logic is different)
    });

    it('NEW: $32.50 + $6.99 shipping → accounts for total $39.49', () => {
      const result = calculateEbayPriceWithFlag({
        amazonHtml: paidShippingHtml,
        productTitle: 'Heavy Equipment Parts',
      });

      // New logic: (32.50 + 6.99) × 0.9 = 35.541 → 35.54 total
      // ALGO_COMPETITIVE_TOTAL: eBay has free shipping, item price = discounted total
      expect(result.ebayItemPrice).toBe(35.54);
      expect(result.ebayShippingPrice).toBe(0);

      // Compare to legacy: 32.50 × 0.9 - 5 = 24.25 (ignores shipping)
      // New logic is ~$11.29 higher total due to accounting for Amazon shipping!
    });
  });
});
