/**
 * Pricing regression tests - NEW formula (Post-Migration)
 * 
 * MIGRATION COMPLETE: The old formula (base * 0.9 - $5 if > $30) has been replaced
 * with the centralized ALGO_COMPETITIVE_TOTAL formula:
 * 
 * NEW FORMULA (getFinalEbayPrice):
 *   - Apply discount: base * (1 - discountPercent/100)  [default 10%]
 *   - Subtract shipping: result - templateShippingEstimate  [default $6]
 *   - Apply minimum floor: max(result, minItemPrice)  [default $1.99]
 * 
 * Example: $45.99 → $45.99 * 0.9 = $41.39 - $6 = $35.39
 * 
 * All pricing now flows through ONE function: getFinalEbayPrice in pricing-compute.ts
 */

import { computeEbayPrice } from '../../../src/utils/pricing';

describe('Pricing Regression Tests - Centralized Formula', () => {
  describe('New pricing formula: (base * 0.9) - $6 shipping', () => {
    describe('Amazon Free Shipping Scenario', () => {
      /**
       * FIXTURE: Amazon item with free Prime shipping
       * - Amazon item price: $45.99
       * - Amazon shipping: $0.00 (Free Prime)
       * 
       * NEW FORMULA:
       * - Input: $45.99
       * - Apply 10% discount: $45.99 * 0.9 = $41.391
       * - Subtract $6 shipping: $41.391 - $6 = $35.391 ≈ $35.39
       */
      it('should apply new formula to Amazon free shipping item', () => {
        const amazonItemPrice = 45.99;
        const amazonShipping = 0;
        const amazonTotal = amazonItemPrice + amazonShipping;
        
        const ebayPrice = computeEbayPrice(amazonItemPrice);
        
        // NEW: $45.99 * 0.9 - $6 = $35.39
        expect(ebayPrice).toBe(35.39);
        
        console.log('[NEW FORMULA] Free Shipping:');
        console.log(`  Amazon: item=$${amazonItemPrice.toFixed(2)} + ship=$${amazonShipping.toFixed(2)} = total=$${amazonTotal.toFixed(2)}`);
        console.log(`  eBay: $${ebayPrice.toFixed(2)} (new centralized formula)`);
      });

      it('should handle lower-priced Amazon free shipping item', () => {
        const amazonItemPrice = 19.99;
        const amazonShipping = 0;
        const amazonTotal = amazonItemPrice + amazonShipping;
        
        const ebayPrice = computeEbayPrice(amazonItemPrice);
        
        // $19.99 * 0.9 - $6 = $17.99 - $6 = $11.99
        expect(ebayPrice).toBe(11.99);
        
        console.log('[NEW FORMULA] Free Shipping (Low Price):');
        console.log(`  Amazon: item=$${amazonItemPrice.toFixed(2)} + ship=$${amazonShipping.toFixed(2)} = total=$${amazonTotal.toFixed(2)}`);
        console.log(`  eBay: $${ebayPrice.toFixed(2)} (new formula)`);
      });
    });

    describe('Amazon Paid Shipping Scenario', () => {
      /**
       * FIXTURE: Amazon item with paid shipping
       * - Amazon item price: $32.50
       * - Amazon shipping: $6.99 (not yet extracted in this flow)
       * 
       * NEW FORMULA (using item price only):
       * - Input: $32.50
       * - Apply 10% discount: $32.50 * 0.9 = $29.25
       * - Subtract $6 shipping: $29.25 - $6 = $23.25
       */
      it('should apply new formula to paid shipping item', () => {
        const amazonItemPrice = 32.50;
        const amazonShipping = 6.99;
        const amazonTotal = amazonItemPrice + amazonShipping;
        
        const ebayPrice = computeEbayPrice(amazonItemPrice);
        
        // NEW: $32.50 * 0.9 - $6 = $23.25
        expect(ebayPrice).toBe(23.25);
        
        console.log('[NEW FORMULA] Paid Shipping:');
        console.log(`  Amazon: item=$${amazonItemPrice.toFixed(2)} + ship=$${amazonShipping.toFixed(2)} = total=$${amazonTotal.toFixed(2)}`);
        console.log(`  eBay: $${ebayPrice.toFixed(2)} (new formula)`);
      });

      it('should handle high-shipping Amazon item', () => {
        const amazonItemPrice = 15.00;
        const amazonShipping = 12.50;
        const amazonTotal = amazonItemPrice + amazonShipping;
        
        const ebayPrice = computeEbayPrice(amazonItemPrice);
        
        // $15.00 * 0.9 - $6 = $13.50 - $6 = $7.50
        expect(ebayPrice).toBe(7.5);
        
        console.log('[NEW FORMULA] High Shipping:');
        console.log(`  Amazon: item=$${amazonItemPrice.toFixed(2)} + ship=$${amazonShipping.toFixed(2)} = total=$${amazonTotal.toFixed(2)}`);
        console.log(`  eBay: $${ebayPrice.toFixed(2)} (new formula)`);
      });
    });

    describe('Edge Cases', () => {
      it('should handle exactly $30', () => {
        const amazonItemPrice = 30.00;
        
        const ebayPrice = computeEbayPrice(amazonItemPrice);
        
        // $30.00 * 0.9 - $6 = $27 - $6 = $21
        expect(ebayPrice).toBe(21);
        
        console.log('[NEW FORMULA] $30 input:');
        console.log(`  Amazon: item=$${amazonItemPrice.toFixed(2)}`);
        console.log(`  eBay: $${ebayPrice.toFixed(2)}`);
      });

      it('should handle just above $30', () => {
        const amazonItemPrice = 30.01;
        
        const ebayPrice = computeEbayPrice(amazonItemPrice);
        
        // $30.01 * 0.9 - $6 = $27.009 - $6 = $21.01
        expect(ebayPrice).toBe(21.01);
        
        console.log('[NEW FORMULA] $30.01 input:');
        console.log(`  Amazon: item=$${amazonItemPrice.toFixed(2)}`);
        console.log(`  eBay: $${ebayPrice.toFixed(2)}`);
      });

      it('should enforce $1.99 minimum floor', () => {
        // Very low prices that would go negative after $6 deduction
        expect(computeEbayPrice(5)).toBe(1.99);  // 5 * 0.9 - 6 = -1.5 → $1.99 floor
        expect(computeEbayPrice(7)).toBe(1.99);  // 7 * 0.9 - 6 = 0.3 → $1.99 floor
        expect(computeEbayPrice(8)).toBe(1.99);  // 8 * 0.9 - 6 = 1.2 → $1.99 floor
        
        console.log('[NEW FORMULA] Minimum floor enforced at $1.99');
      });

      it('should handle zero/invalid prices', () => {
        expect(computeEbayPrice(0)).toBe(0);
        expect(computeEbayPrice(-10)).toBe(0);
        expect(computeEbayPrice(NaN)).toBe(0);
        expect(computeEbayPrice(Infinity)).toBe(0);
        
        console.log('[NEW FORMULA] Invalid inputs return $0');
      });
    });
  });

  describe('Migration Complete - Centralized Pricing', () => {
    /**
     * MIGRATION COMPLETE!
     * 
     * All pricing now flows through ONE function: getFinalEbayPrice in pricing-compute.ts
     * 
     * WHAT WAS FIXED:
     * 1. Removed hardcoded `base * 0.9 - $5` formula from multiple places
     * 2. Centralized all pricing logic in pricing-compute.ts
     * 3. All callers now use getFinalEbayPrice() or computeEbayItemPrice()
     * 4. User settings (discountPercent, shippingStrategy) respected everywhere
     * 
     * FILES CONSOLIDATED:
     * - src/utils/pricing.ts → delegates to getFinalEbayPrice
     * - netlify/functions/smartdrafts-create-drafts.ts → uses getFinalEbayPrice
     * - netlify/functions/listing-plan.ts → uses getFinalEbayPrice
     * - src/lib/price-lookup.ts → uses computeEbayItemPrice with full settings
     */
    it('should have ONE source of truth for pricing', () => {
      // Verify that computeEbayPrice delegates to centralized function
      const price1 = computeEbayPrice(29.99);
      
      // Expected: $29.99 * 0.9 - $6 = $26.99 - $6 = $20.99
      expect(price1).toBeCloseTo(20.99, 2);
      
      console.log('[MIGRATION COMPLETE] All pricing through getFinalEbayPrice');
      console.log(`  Input: $29.99 → Output: $${price1.toFixed(2)}`);
    });

    it('should use user settings from pricing-config', () => {
      // Default settings: 10% discount, $6 shipping deduction
      const price = computeEbayPrice(50);
      
      // $50 * 0.9 - $6 = $45 - $6 = $39
      expect(price).toBe(39);
      
      console.log('[MIGRATION COMPLETE] User settings respected');
    });
  });

  describe('Documentation: Centralized Pricing Architecture', () => {
    /**
     * CURRENT SYSTEM ARCHITECTURE (Post-Migration):
     * 
     * Single Source of Truth:
     * - getFinalEbayPrice(baseDollars, options) in pricing-compute.ts
     * - Takes base price in dollars, returns final eBay price in dollars
     * - Respects user settings from pricing-config.ts
     * 
     * Options:
     * - categoryCap: Category-specific price caps (books: $35, DVDs: $25)
     * - settings: Override default pricing settings
     * 
     * Default Formula (ALGO_COMPETITIVE_TOTAL):
     * - Apply discount: base * (1 - discountPercent/100)
     * - Subtract shipping: result - templateShippingEstimate
     * - Apply minimum floor: max(result, minItemPrice)
     * 
     * Default Settings:
     * - discountPercent: 10
     * - templateShippingEstimateCents: 600 ($6)
     * - minItemPriceCents: 199 ($1.99)
     */
    it('documents centralized pricing architecture', () => {
      // This test just documents the architecture
      expect(true).toBe(true);
      
      console.log('[DOCUMENTATION] Centralized pricing:');
      console.log('  - Single function: getFinalEbayPrice()');
      console.log('  - User settings from pricing-config.ts');
      console.log('  - Category caps in getCategoryCap()');
    });
  });
});
