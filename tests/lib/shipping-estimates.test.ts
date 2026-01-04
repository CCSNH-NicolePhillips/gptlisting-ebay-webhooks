/**
 * Unit tests for shipping estimates
 */

import {
  detectCategory,
  analyzeCompShipping,
  getShippingEstimate,
  getShippingByMode,
  estimateShipping,
  parseSizeSignal,
  CATEGORY_SHIPPING,
} from '../../src/lib/shipping-estimates.js';
import { CompetitorPrice } from '../../src/lib/delivered-pricing.js';

describe('shipping-estimates', () => {
  // ========================================================================
  // detectCategory
  // ========================================================================
  describe('detectCategory', () => {
    it('detects beauty products', () => {
      expect(detectCategory('CeraVe', 'Moisturizing Cream 16oz')).toBe('beauty');
      expect(detectCategory('Neutrogena', 'Hydro Boost Serum')).toBe('beauty');
    });

    it('detects haircare products', () => {
      expect(detectCategory('Olaplex', 'No 3 Hair Perfector')).toBe('haircare');
      expect(detectCategory('Pantene', 'Shampoo Pro-V')).toBe('haircare');
    });

    it('detects supplements', () => {
      expect(detectCategory('Neuro', 'Vita Mints D3 K2 90ct')).toBe('supplements');
      expect(detectCategory('Nature Made', 'Vitamin D3 Gummies')).toBe('supplements');
    });

    it('detects shoes', () => {
      expect(detectCategory('Nike', 'Air Max Sneakers')).toBe('shoes');
      expect(detectCategory('Timberland', 'Boots 6 inch')).toBe('shoes');
    });

    it('detects bags', () => {
      expect(detectCategory('Coach', 'Leather Purse')).toBe('bags');
      expect(detectCategory('Jansport', 'Student Backpack')).toBe('bags');
    });

    it('returns default for unknown', () => {
      expect(detectCategory('Generic', 'Random Product')).toBe('default');
    });
  });

  // ========================================================================
  // analyzeCompShipping
  // ========================================================================
  describe('analyzeCompShipping', () => {
    const makeComp = (shipCents: number): CompetitorPrice => ({
      source: 'ebay',
      itemCents: 1000,
      shipCents,
      deliveredCents: 1000 + shipCents,
      title: 'Test',
      url: null,
      inStock: true,
      seller: 'test',
    });

    it('calculates median shipping', () => {
      const comps = [makeComp(500), makeComp(600), makeComp(700)];
      const result = analyzeCompShipping(comps);
      expect(result.medianCents).toBe(600);
    });

    it('calculates free shipping percentage', () => {
      const comps = [makeComp(0), makeComp(0), makeComp(0), makeComp(500)];
      const result = analyzeCompShipping(comps);
      expect(result.freeShipPercent).toBe(75);
    });

    it('finds most common shipping value', () => {
      const comps = [makeComp(500), makeComp(600), makeComp(500), makeComp(500)];
      const result = analyzeCompShipping(comps);
      expect(result.mostCommonCents).toBe(500);
    });

    it('handles empty array', () => {
      const result = analyzeCompShipping([]);
      expect(result.medianCents).toBe(0);
      expect(result.freeShipPercent).toBe(0);
      expect(result.count).toBe(0);
    });
  });

  // ========================================================================
  // getShippingEstimate
  // ========================================================================
  describe('getShippingEstimate', () => {
    it('returns category-based estimate by default', () => {
      const result = getShippingEstimate('Olaplex', 'No 3 Hair Perfector');
      expect(result.source).toBe('category');
      expect(result.categoryDetected).toBe('haircare');
      expect(result.cents).toBe(CATEGORY_SHIPPING.haircare);
    });

    it('returns comp-based when preferred and enough data', () => {
      const comps: CompetitorPrice[] = Array(5).fill(null).map(() => ({
        source: 'ebay' as const,
        itemCents: 1000,
        shipCents: 550,
        deliveredCents: 1550,
        title: 'Test',
        url: null,
        inStock: true,
        seller: 'test',
      }));
      
      const result = getShippingEstimate('Brand', 'Product', comps, {
        preferredSource: 'comps',
      });
      expect(result.source).toBe('comp-median');
      expect(result.cents).toBe(550);
      expect(result.confidence).toBe('high');
    });

    it('lowers estimate when most comps have free shipping', () => {
      const comps: CompetitorPrice[] = Array(10).fill(null).map(() => ({
        source: 'ebay' as const,
        itemCents: 1000,
        shipCents: 0, // Free shipping
        deliveredCents: 1000,
        title: 'Test',
        url: null,
        inStock: true,
        seller: 'test',
      }));
      
      const result = getShippingEstimate('Brand', 'Product', comps, {
        preferredSource: 'comps',
      });
      expect(result.cents).toBe(400); // Lower estimate for free-ship dominated market
    });

    it('falls back to category when not enough comps', () => {
      const comps: CompetitorPrice[] = []; // No comps
      
      const result = getShippingEstimate('Neuro', 'Vita Mints', comps, {
        preferredSource: 'comps',
      });
      expect(result.source).toBe('category');
      expect(result.categoryDetected).toBe('supplements');
    });

    it('respects min/max bounds', () => {
      const result = getShippingEstimate('Brand', 'Random Product', [], {
        preferredSource: 'default',
        defaultCents: 100,  // Below min
        minCents: 300,
      });
      expect(result.cents).toBeGreaterThanOrEqual(300);
    });
  });

  // ========================================================================
  // estimateShipping (quick helper)
  // ========================================================================
  describe('estimateShipping', () => {
    it('returns cents for category-based estimate', () => {
      const cents = estimateShipping('Neuro', 'Vita Mints 90ct');
      // With size heuristic enabled: 60% * 400 (light/90ct) + 40% * 500 (supplements) = 440
      expect(cents).toBe(440);
    });

    it('returns default for unknown product', () => {
      const cents = estimateShipping('Unknown', 'Random Thing');
      expect(cents).toBe(CATEGORY_SHIPPING.default); // 600
    });
  });

  // ========================================================================
  // parseSizeSignal - Size heuristic parser
  // ========================================================================
  describe('parseSizeSignal', () => {
    it('parses oz weights', () => {
      const result = parseSizeSignal('CeraVe Moisturizer 16oz');
      expect(result.signalType).toBe('weight');
      expect(result.value).toBe(16);
      expect(result.unit).toBe('oz');
      expect(result.band).toBe('heavy');
    });

    it('parses fl oz weights', () => {
      const result = parseSizeSignal('Serum 1.7 fl oz');
      expect(result.signalType).toBe('weight');
      expect(result.value).toBe(1.7);
      expect(result.unit).toBe('oz');
      expect(result.band).toBe('light');
    });

    it('parses lb weights', () => {
      const result = parseSizeSignal('Protein Powder 2 lbs');
      expect(result.signalType).toBe('weight');
      expect(result.value).toBe(2);
      expect(result.unit).toBe('lb');
      expect(result.band).toBe('extra-heavy'); // 32oz
    });

    it('parses mL volumes', () => {
      const result = parseSizeSignal('Face Cream 30ml');
      expect(result.signalType).toBe('volume');
      expect(result.value).toBe(30);
      expect(result.unit).toBe('ml');
      expect(result.band).toBe('light');
    });

    it('parses large mL volumes', () => {
      const result = parseSizeSignal('Shampoo 500ml');
      expect(result.signalType).toBe('volume');
      expect(result.value).toBe(500);
      expect(result.unit).toBe('ml');
      expect(result.band).toBe('heavy');
    });

    it('parses capsule counts', () => {
      const result = parseSizeSignal('Vitamin D3 60 Capsules');
      expect(result.signalType).toBe('count');
      expect(result.value).toBe(60);
      expect(result.unit).toBe('count');
      expect(result.band).toBe('light');
    });

    it('parses gummy counts', () => {
      const result = parseSizeSignal('Neuro Gum 90 pieces');
      expect(result.signalType).toBe('count');
      expect(result.value).toBe(90);
      expect(result.band).toBe('light');
    });

    it('parses grams', () => {
      const result = parseSizeSignal('Protein 500g');
      expect(result.signalType).toBe('weight');
      expect(result.value).toBe(500);
      expect(result.unit).toBe('g');
      expect(result.band).toBe('extra-heavy'); // 500g = ~17.6oz > 16oz
    });

    it('returns unknown for no signal', () => {
      const result = parseSizeSignal('Generic Product XYZ');
      expect(result.signalType).toBe('unknown');
      expect(result.band).toBe('unknown');
    });
  });

  // ========================================================================
  // getShippingByMode - Mode-based shipping
  // ========================================================================
  describe('getShippingByMode', () => {
    it('returns flat rate in FLAT mode', () => {
      const result = getShippingByMode('Brand', 'Product', {
        mode: 'FLAT',
        flatCents: 650,
      });
      expect(result.source).toBe('flat');
      expect(result.cents).toBe(650);
      expect(result.confidence).toBe('high');
    });

    it('uses category in CATEGORY_ESTIMATE mode', () => {
      const result = getShippingByMode('Olaplex', 'Hair Treatment', {
        mode: 'CATEGORY_ESTIMATE',
        useSizeHeuristic: false,
      });
      expect(result.source).toBe('category');
      expect(result.categoryDetected).toBe('haircare');
      expect(result.cents).toBe(500); // haircare = $5.00
    });

    it('uses size heuristic when enabled', () => {
      const result = getShippingByMode('Brand', 'Shampoo 16oz', {
        mode: 'CATEGORY_ESTIMATE',
        useSizeHeuristic: true,
      });
      expect(result.source).toBe('size-heuristic');
      expect(result.sizeSignal?.band).toBe('heavy');
      // Heavy band (650) weighted 60% + haircare (500) weighted 40%
      expect(result.cents).toBeGreaterThan(500);
    });

    it('falls back to category when no size signal', () => {
      const result = getShippingByMode('Neuro', 'Vita Mints', {
        mode: 'CATEGORY_ESTIMATE',
        useSizeHeuristic: true,
      });
      // No size signal, so uses category
      expect(result.source).toBe('category');
      expect(result.categoryDetected).toBe('supplements');
    });

    it('allows custom category rates', () => {
      const result = getShippingByMode('Brand', 'Hair Product', {
        mode: 'CATEGORY_ESTIMATE',
        useSizeHeuristic: false,
        categoryRates: {
          haircare: 750, // Custom higher rate
          default: 600,
        },
      });
      expect(result.cents).toBe(750);
    });

    it('respects min/max bounds', () => {
      const result = getShippingByMode('Brand', 'Product', {
        mode: 'FLAT',
        flatCents: 100, // Below min
        minCents: 300,
      });
      expect(result.cents).toBe(300);
    });
  });
});
