/**
 * Comprehensive tests for price-formula.ts
 * Target: 100% code coverage for pricing calculations
 */

import { applyPricingFormula, PricingResult } from '../../src/lib/price-formula';

describe('price-formula.ts', () => {
  describe('applyPricingFormula', () => {
    describe('Valid price inputs', () => {
      it('should apply 10% discount to average price', () => {
        const result = applyPricingFormula(100);
        
        expect(result).not.toBeNull();
        expect(result!.base).toBe(100.00);
        expect(result!.ebay).toBe(90.00); // 100 * 0.9
      });

      it('should round to 2 decimal places', () => {
        const result = applyPricingFormula(25.999);
        
        expect(result).not.toBeNull();
        expect(result!.base).toBe(26.00); // Rounded
        expect(result!.ebay).toBe(23.40); // 25.999 * 0.9 = 23.3991 → 23.40
      });

      it('should handle typical supplement pricing', () => {
        const result = applyPricingFormula(24.95);
        
        expect(result).not.toBeNull();
        expect(result!.base).toBe(24.95);
        expect(result!.ebay).toBe(22.45); // 24.95 * 0.9 = 22.455 → rounds to 22.45
      });
    });

    describe('Minimum price enforcement ($0.99)', () => {
      it('should enforce $0.99 minimum for very low prices', () => {
        const result = applyPricingFormula(1);
        
        expect(result).not.toBeNull();
        expect(result!.ebay).toBe(0.99); // 1 * 0.9 = 0.90 → enforced to 0.99
      });

      it('should enforce $0.99 minimum for sub-dollar inputs', () => {
        const result = applyPricingFormula(0.5);
        
        expect(result).not.toBeNull();
        expect(result!.ebay).toBe(0.99);
      });

      it('should NOT modify prices already above $0.99', () => {
        const result = applyPricingFormula(20);
        
        expect(result).not.toBeNull();
        expect(result!.ebay).toBe(18.00); // No minimum applied
      });
    });

    describe('Auto-reduction metadata', () => {
      it('should set fixed reduction parameters', () => {
        const result = applyPricingFormula(100);
        
        expect(result).not.toBeNull();
        expect(result!.auto.reduceBy).toBe(1); // $1 per reduction
        expect(result!.auto.everyDays).toBe(3); // Every 3 days
      });

      it('should calculate minPrice as 80% of ebay price', () => {
        const result = applyPricingFormula(100);
        
        expect(result).not.toBeNull();
        expect(result!.auto.minPrice).toBe(72.00); // 90 * 0.8
      });

      it('should round minPrice to 2 decimal places', () => {
        const result = applyPricingFormula(25.99);
        
        expect(result).not.toBeNull();
        // ebay = 25.99 * 0.9 = 23.391 → 23.39
        // minPrice = 23.39 * 0.8 = 18.712 → 18.71
        expect(result!.auto.minPrice).toBe(18.71);
      });

      it('should handle minPrice for minimum-enforced prices', () => {
        const result = applyPricingFormula(1);
        
        expect(result).not.toBeNull();
        expect(result!.ebay).toBe(0.99);
        expect(result!.auto.minPrice).toBe(0.79); // 0.99 * 0.8 = 0.792 → 0.79
      });
    });

    describe('Invalid inputs', () => {
      it('should return null for null input', () => {
        const result = applyPricingFormula(null);
        expect(result).toBeNull();
      });

      it('should return null for undefined input', () => {
        const result = applyPricingFormula(undefined);
        expect(result).toBeNull();
      });

      it('should return null for zero price', () => {
        const result = applyPricingFormula(0);
        expect(result).toBeNull();
      });

      it('should return null for negative price', () => {
        const result = applyPricingFormula(-10);
        expect(result).toBeNull();
      });
    });

    describe('Edge cases', () => {
      it('should handle very large prices', () => {
        const result = applyPricingFormula(10000);
        
        expect(result).not.toBeNull();
        expect(result!.base).toBe(10000.00);
        expect(result!.ebay).toBe(9000.00);
        expect(result!.auto.minPrice).toBe(7200.00);
      });

      it('should handle very small positive prices', () => {
        const result = applyPricingFormula(0.01);
        
        expect(result).not.toBeNull();
        expect(result!.base).toBe(0.01);
        expect(result!.ebay).toBe(0.99); // Enforced minimum
      });

      it('should handle prices exactly at $0.99 threshold', () => {
        const result = applyPricingFormula(1.10); // 1.10 * 0.9 = 0.99
        
        expect(result).not.toBeNull();
        expect(result!.ebay).toBe(0.99);
      });

      it('should handle floating point precision', () => {
        const result = applyPricingFormula(0.1 + 0.2); // JavaScript float issue
        
        expect(result).not.toBeNull();
        expect(result!.base).toBe(0.30); // Should handle correctly
      });
    });

    describe('PricingResult structure validation', () => {
      it('should return complete PricingResult object', () => {
        const result = applyPricingFormula(50);
        
        expect(result).not.toBeNull();
        expect(result).toHaveProperty('base');
        expect(result).toHaveProperty('ebay');
        expect(result).toHaveProperty('auto');
        expect(result!.auto).toHaveProperty('reduceBy');
        expect(result!.auto).toHaveProperty('everyDays');
        expect(result!.auto).toHaveProperty('minPrice');
      });

      it('should return all numeric values', () => {
        const result = applyPricingFormula(75);
        
        expect(typeof result!.base).toBe('number');
        expect(typeof result!.ebay).toBe('number');
        expect(typeof result!.auto.reduceBy).toBe('number');
        expect(typeof result!.auto.everyDays).toBe('number');
        expect(typeof result!.auto.minPrice).toBe('number');
      });
    });

    describe('Business logic verification', () => {
      it('should ensure ebay price is always less than base (except minimum)', () => {
        const result = applyPricingFormula(100);
        
        expect(result).not.toBeNull();
        expect(result!.ebay).toBeLessThan(result!.base);
      });

      it('should ensure minPrice is less than ebay price', () => {
        const result = applyPricingFormula(100);
        
        expect(result).not.toBeNull();
        expect(result!.auto.minPrice).toBeLessThan(result!.ebay);
      });

      it('should maintain 80% minimum price ratio', () => {
        const result = applyPricingFormula(100);
        
        expect(result).not.toBeNull();
        const ratio = result!.auto.minPrice / result!.ebay;
        expect(ratio).toBeCloseTo(0.8, 2);
      });
    });
  });
});
