/**
 * Unit tests for pricing priority logic
 * 
 * Tests selectPriceSource() function directly with mock candidates
 * 
 * Priority order (must be respected in ALL scenarios):
 * 1. Amazon (direct or rapidapi-amazon)
 * 2. Brand MSRP
 * 3. Other retail (rapidapi-retail, brave-fallback)
 * 4. eBay (ebay-sold, rapidapi-ebay) - LAST RESORT ONLY
 * 
 * eBay prices should NEVER be chosen over Amazon or Brand MSRP
 */

import { describe, it, expect } from '@jest/globals';
import { 
  selectPriceSource, 
  type PriceLookupInput, 
  type PriceSourceDetail,
  type PriceSource 
} from '../../src/lib/price-lookup.js';

// Standard test input with pricing settings
const testInput: PriceLookupInput = {
  title: 'Test Product 90 Pieces',
  brand: 'TestBrand',
  condition: 'NEW',
  quantity: 1,
  pricingSettings: {
    discountPercent: 10,
    shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
    templateShippingEstimateCents: 600,
    shippingSubsidyCapCents: 600,
  },
};

// Helper to create price candidate
function makeCandidate(
  source: PriceSource, 
  price: number, 
  confidence: 'high' | 'medium' | 'low' = 'medium',
  notes?: string
): PriceSourceDetail {
  return {
    source,
    price,
    currency: 'USD',
    confidence,
    notes: notes || `${source} price`,
  };
}

describe('selectPriceSource - Priority Logic', () => {
  
  describe('Priority 1: Amazon should always win when available', () => {
    
    it('should use Amazon when only Amazon is available', () => {
      const candidates = [
        makeCandidate('amazon', 29.99, 'high'),
      ];

      const result = selectPriceSource(testInput, candidates);

      expect(result.ok).toBe(true);
      expect(result.source).toBe('amazon');
      expect(result.chosen?.price).toBe(29.99);
    });

    it('should prefer Amazon over Brand MSRP even when Brand is cheaper', () => {
      const candidates = [
        makeCandidate('amazon', 30.00, 'high'),
        makeCandidate('brand-msrp', 25.00, 'high'), // Cheaper but should NOT be chosen
      ];

      const result = selectPriceSource(testInput, candidates);

      expect(result.ok).toBe(true);
      expect(result.source).toBe('amazon');
      expect(result.chosen?.price).toBe(30.00);
    });

    it('should prefer Amazon over eBay sold prices', () => {
      const candidates = [
        makeCandidate('amazon', 30.00, 'high'),
        makeCandidate('ebay-sold', 15.00, 'high'), // Much cheaper but should NOT be chosen
      ];

      const result = selectPriceSource(testInput, candidates);

      expect(result.ok).toBe(true);
      expect(result.source).toBe('amazon');
      expect(result.source).not.toBe('ebay-sold');
    });

    it('should prefer Amazon over RapidAPI eBay', () => {
      const candidates = [
        makeCandidate('amazon', 30.00, 'high'),
        makeCandidate('rapidapi-ebay', 19.95, 'medium'),
      ];

      const result = selectPriceSource(testInput, candidates);

      expect(result.ok).toBe(true);
      expect(result.source).toBe('amazon');
      expect(result.source).not.toBe('rapidapi-ebay');
    });

    it('should use RapidAPI Amazon when direct Amazon is not available', () => {
      const candidates = [
        makeCandidate('rapidapi-amazon', 28.00, 'high'),
        makeCandidate('brand-msrp', 25.00, 'high'),
      ];

      const result = selectPriceSource(testInput, candidates);

      expect(result.ok).toBe(true);
      expect(result.source).toBe('rapidapi-amazon');
    });

    it('should prefer direct Amazon over RapidAPI Amazon', () => {
      const candidates = [
        makeCandidate('amazon', 30.00, 'high'),
        makeCandidate('rapidapi-amazon', 28.00, 'high'),
      ];

      const result = selectPriceSource(testInput, candidates);

      expect(result.ok).toBe(true);
      expect(result.source).toBe('amazon');
    });
  });

  describe('Priority 2: Brand MSRP should win when no Amazon', () => {
    
    it('should use Brand MSRP when Amazon is not available', () => {
      const candidates = [
        makeCandidate('brand-msrp', 25.00, 'high'),
      ];

      const result = selectPriceSource(testInput, candidates);

      expect(result.ok).toBe(true);
      expect(result.source).toBe('brand-msrp');
    });

    it('should prefer Brand MSRP over eBay sold prices', () => {
      const candidates = [
        makeCandidate('brand-msrp', 25.00, 'high'),
        makeCandidate('ebay-sold', 19.00, 'high'),
      ];

      const result = selectPriceSource(testInput, candidates);

      expect(result.ok).toBe(true);
      expect(result.source).toBe('brand-msrp');
      expect(result.source).not.toBe('ebay-sold');
    });

    it('should prefer Brand MSRP over RapidAPI eBay results', () => {
      const candidates = [
        makeCandidate('rapidapi-ebay', 19.95, 'medium', 'eBay - cashchucker'),
        makeCandidate('brand-msrp', 24.99, 'high'),
      ];

      const result = selectPriceSource(testInput, candidates);

      expect(result.ok).toBe(true);
      expect(result.source).toBe('brand-msrp');
      expect(result.source).not.toBe('rapidapi-ebay');
    });

    it('should prefer Brand MSRP over brave-fallback', () => {
      const candidates = [
        makeCandidate('brave-fallback', 22.00, 'medium'),
        makeCandidate('brand-msrp', 25.00, 'high'),
      ];

      const result = selectPriceSource(testInput, candidates);

      expect(result.ok).toBe(true);
      expect(result.source).toBe('brand-msrp');
    });
  });

  describe('Priority 3: Other retail when no Amazon or Brand', () => {
    
    it('should use RapidAPI retail (Target) when no Amazon or Brand', () => {
      const candidates = [
        makeCandidate('rapidapi-retail', 22.00, 'high', 'Target price'),
      ];

      const result = selectPriceSource(testInput, candidates);

      expect(result.ok).toBe(true);
      expect(result.source).toBe('rapidapi-retail');
    });

    it('should prefer RapidAPI retail over eBay', () => {
      const candidates = [
        makeCandidate('rapidapi-retail', 22.00, 'high', 'Walmart'),
        makeCandidate('ebay-sold', 18.00, 'high'),
      ];

      const result = selectPriceSource(testInput, candidates);

      expect(result.ok).toBe(true);
      expect(result.source).toBe('rapidapi-retail');
      expect(result.source).not.toBe('ebay-sold');
    });

    it('should use brave-fallback when available', () => {
      const candidates = [
        makeCandidate('brave-fallback', 23.00, 'medium'),
      ];

      const result = selectPriceSource(testInput, candidates);

      expect(result.ok).toBe(true);
      expect(result.source).toBe('brave-fallback');
    });
  });

  describe('Priority 4: eBay as absolute last resort', () => {
    
    it('should use eBay sold only when NO other sources available', () => {
      const candidates = [
        makeCandidate('ebay-sold', 19.00, 'high'),
      ];

      const result = selectPriceSource(testInput, candidates);

      expect(result.ok).toBe(true);
      expect(result.source).toBe('ebay-sold');
    });

    it('should use RapidAPI eBay only when NO other sources available', () => {
      const candidates = [
        makeCandidate('rapidapi-ebay', 19.95, 'medium'),
      ];

      const result = selectPriceSource(testInput, candidates);

      expect(result.ok).toBe(true);
      expect(result.source).toBe('rapidapi-ebay');
    });

    it('should mark eBay sold results with low confidence', () => {
      const candidates = [
        makeCandidate('ebay-sold', 19.00, 'high'), // Even if marked high
      ];

      const result = selectPriceSource(testInput, candidates);

      // eBay should be marked as low confidence
      expect(result.confidence).toBe('low');
    });

    it('should mark RapidAPI eBay results with low confidence', () => {
      const candidates = [
        makeCandidate('rapidapi-ebay', 19.95, 'high'), // Even if marked high
      ];

      const result = selectPriceSource(testInput, candidates);

      // eBay should always be low confidence
      expect(result.confidence).toBe('low');
    });

    it('should prefer ebay-sold over rapidapi-ebay', () => {
      const candidates = [
        makeCandidate('ebay-sold', 19.00, 'high'),
        makeCandidate('rapidapi-ebay', 19.95, 'medium'),
      ];

      const result = selectPriceSource(testInput, candidates);

      expect(result.source).toBe('ebay-sold');
    });
  });

  describe('Edge cases', () => {
    
    it('should return ok: false when no candidates', () => {
      const candidates: PriceSourceDetail[] = [];

      const result = selectPriceSource(testInput, candidates);

      expect(result.ok).toBe(false);
      expect(result.reason).toBe('no-price-signals');
    });

    it('should handle all sources available - Amazon wins', () => {
      const candidates = [
        makeCandidate('ebay-sold', 15.00, 'high'),
        makeCandidate('rapidapi-ebay', 18.00, 'medium'),
        makeCandidate('brave-fallback', 20.00, 'medium'),
        makeCandidate('rapidapi-retail', 22.00, 'high'),
        makeCandidate('brand-msrp', 25.00, 'high'),
        makeCandidate('rapidapi-amazon', 28.00, 'high'),
        makeCandidate('amazon', 30.00, 'high'),
      ];

      const result = selectPriceSource(testInput, candidates);

      expect(result.ok).toBe(true);
      expect(result.source).toBe('amazon');
    });

    it('should handle candidates in any order - priority still works', () => {
      // Candidates in "wrong" order - eBay first
      const candidates = [
        makeCandidate('rapidapi-ebay', 15.00, 'medium'),
        makeCandidate('ebay-sold', 18.00, 'high'),
        makeCandidate('brand-msrp', 25.00, 'high'),
      ];

      const result = selectPriceSource(testInput, candidates);

      expect(result.ok).toBe(true);
      expect(result.source).toBe('brand-msrp');
      expect(result.source).not.toBe('rapidapi-ebay');
      expect(result.source).not.toBe('ebay-sold');
    });
  });

  describe('Real-world scenario: D3K2 pricing bug', () => {
    
    it('should NOT use eBay reseller price when Brand MSRP is available', () => {
      // This is the actual bug scenario:
      // - RapidAPI found eBay price $19.95
      // - Brand MSRP was $24.99
      // - System incorrectly chose eBay $19.95
      const candidates = [
        makeCandidate('rapidapi-ebay', 19.95, 'medium', 'eBay - cashchucker'),
        makeCandidate('brand-msrp', 24.99, 'high', 'Official brand site MSRP'),
      ];

      const result = selectPriceSource({
        ...testInput,
        title: 'Vita+Mints Vitamins D3 & K2 mints 90 Pieces',
        brand: 'Neuro',
      }, candidates);

      expect(result.ok).toBe(true);
      // MUST use Brand MSRP, NOT eBay
      expect(result.source).toBe('brand-msrp');
      expect(result.source).not.toBe('rapidapi-ebay');
      expect(result.chosen?.price).toBe(24.99);
    });

    it('should correctly calculate final price from Brand MSRP with discount', () => {
      // Brand MSRP $24.99 → 10% discount → minus $6 shipping = expected ~$16.49
      const candidates = [
        makeCandidate('brand-msrp', 24.99, 'high'),
      ];

      const result = selectPriceSource({
        ...testInput,
        pricingSettings: {
          discountPercent: 10,
          shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
          templateShippingEstimateCents: 600,
          shippingSubsidyCapCents: 600,
        },
      }, candidates);

      expect(result.ok).toBe(true);
      expect(result.source).toBe('brand-msrp');
      
      // Final price should be around $16.49 (24.99 * 0.9 - 6.00)
      const expectedFinalPrice = (24.99 * 0.9) - 6.00; // ~16.49
      expect(result.price).toBeCloseTo(expectedFinalPrice, 0);
    });

    it('should NOT choose eBay even when it has higher confidence', () => {
      const candidates = [
        makeCandidate('rapidapi-ebay', 19.95, 'high'), // High confidence
        makeCandidate('brand-msrp', 24.99, 'medium'), // Lower confidence
      ];

      const result = selectPriceSource(testInput, candidates);

      // Should still choose brand-msrp over eBay regardless of confidence
      expect(result.source).toBe('brand-msrp');
    });
  });

  describe('Price calculation with discounts', () => {
    
    it('should apply 10% discount correctly', () => {
      // $30 Amazon → $27 (10% off) → $21 (minus $6 shipping)
      const candidates = [
        makeCandidate('amazon', 30.00, 'high'),
      ];

      const result = selectPriceSource({
        ...testInput,
        pricingSettings: {
          discountPercent: 10,
          shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
          templateShippingEstimateCents: 600,
          shippingSubsidyCapCents: 600,
        },
      }, candidates);

      // 30 * 0.9 - 6 = 21
      expect(result.price).toBeCloseTo(21.00, 1);
    });

    it('should apply 20% discount correctly', () => {
      // $30 Amazon → $24 (20% off) → $18 (minus $6 shipping)
      const candidates = [
        makeCandidate('amazon', 30.00, 'high'),
      ];

      const result = selectPriceSource({
        ...testInput,
        pricingSettings: {
          discountPercent: 20,
          shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
          templateShippingEstimateCents: 600,
          shippingSubsidyCapCents: 600,
        },
      }, candidates);

      // 30 * 0.8 - 6 = 18
      expect(result.price).toBeCloseTo(18.00, 1);
    });

    it('should handle zero discount', () => {
      const candidates = [
        makeCandidate('amazon', 30.00, 'high'),
      ];

      const result = selectPriceSource({
        ...testInput,
        pricingSettings: {
          discountPercent: 0,
          shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
          templateShippingEstimateCents: 600,
          shippingSubsidyCapCents: 600,
        },
      }, candidates);

      // 30 * 1.0 - 6 = 24
      expect(result.price).toBeCloseTo(24.00, 1);
    });
  });

  describe('Source type identification', () => {
    
    it('should correctly identify all Amazon sources', () => {
      const amazonSources: PriceSource[] = ['amazon', 'rapidapi-amazon'];
      
      for (const source of amazonSources) {
        const candidates = [makeCandidate(source, 29.99, 'high')];
        const result = selectPriceSource(testInput, candidates);
        
        expect(result.ok).toBe(true);
        expect(result.source).toBe(source);
      }
    });

    it('should correctly identify all eBay sources', () => {
      const ebaySources: PriceSource[] = ['ebay-sold', 'rapidapi-ebay'];
      
      for (const source of ebaySources) {
        const candidates = [makeCandidate(source, 19.99, 'high')];
        const result = selectPriceSource(testInput, candidates);
        
        expect(result.ok).toBe(true);
        expect(result.source).toBe(source);
        expect(result.confidence).toBe('low'); // All eBay should be low confidence
      }
    });
  });

  describe('Comprehensive priority matrix', () => {
    // Test all pairwise combinations to ensure priority is always respected
    
    const allSources: PriceSource[] = [
      'amazon',
      'rapidapi-amazon', 
      'brand-msrp',
      'rapidapi-retail',
      'brave-fallback',
      'ebay-sold',
      'rapidapi-ebay',
    ];

    it('should respect priority order for all source combinations', () => {
      for (let i = 0; i < allSources.length; i++) {
        for (let j = i + 1; j < allSources.length; j++) {
          const higherPriority = allSources[i];
          const lowerPriority = allSources[j];
          
          // Create candidates with lower priority first (to test order independence)
          const candidates = [
            makeCandidate(lowerPriority, 15.00, 'high'),
            makeCandidate(higherPriority, 30.00, 'medium'),
          ];
          
          const result = selectPriceSource(testInput, candidates);
          
          expect(result.ok).toBe(true);
          expect(result.source).toBe(higherPriority);
        }
      }
    });
  });
});
