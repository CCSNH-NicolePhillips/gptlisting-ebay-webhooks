/**
 * Integration Tests: Delivered-Price-First Pricing Pipeline
 * 
 * Tests the full pricing pipeline with mocked external APIs.
 * Validates that the pricing engine produces competitive prices.
 * 
 * @see docs/PRICING-OVERHAUL.md - Phase 5
 */

import {
  getDeliveredPricing,
  calculateTargetDelivered,
  splitDeliveredPrice,
  DEFAULT_PRICING_SETTINGS,
  DeliveredPricingSettings,
  CompetitorPrice,
} from '../../src/lib/delivered-pricing.js';

import {
  getShippingEstimate,
  detectCategory,
  CATEGORY_SHIPPING,
} from '../../src/lib/shipping-estimates.js';

// ============================================================================
// Test Fixtures
// ============================================================================

const NEURO_MINTS_COMPS: CompetitorPrice[] = [
  {
    source: 'ebay',
    itemCents: 1895,
    shipCents: 0,
    deliveredCents: 1895,
    title: 'Neuro Vita+Mints D3 K2 90 Pieces New Sealed',
    url: 'https://ebay.com/itm/123',
    inStock: true,
    seller: 'vitaminseller2024',
  },
  {
    source: 'ebay',
    itemCents: 1599,
    shipCents: 599,
    deliveredCents: 2198,
    title: 'Neuro Vita Mints D3 K2 90ct',
    url: 'https://ebay.com/itm/456',
    inStock: true,
    seller: 'healthstore',
  },
  {
    source: 'ebay',
    itemCents: 2195,
    shipCents: 0,
    deliveredCents: 2195,
    title: 'Neuro Vita+Mints D3 & K2 90 Pieces',
    url: 'https://ebay.com/itm/789',
    inStock: true,
    seller: 'megavitamins',
  },
  {
    source: 'amazon',
    itemCents: 2995,
    shipCents: 0,
    deliveredCents: 2995,
    title: 'Neuro Vita+Mints Vitamin D3 K2 - 90 Count',
    url: 'https://amazon.com/dp/B0123',
    inStock: true,
    seller: 'Amazon.com',
  },
];

const OLAPLEX_COMPS: CompetitorPrice[] = [
  {
    source: 'ebay',
    itemCents: 2499,
    shipCents: 499,
    deliveredCents: 2998,
    title: 'Olaplex No 3 Hair Perfector 3.3oz',
    url: 'https://ebay.com/itm/olaplex1',
    inStock: true,
    seller: 'beautysupply',
  },
  {
    source: 'ebay',
    itemCents: 2799,
    shipCents: 0,
    deliveredCents: 2799,
    title: 'Olaplex No.3 Hair Perfector 3.3 oz',
    url: 'https://ebay.com/itm/olaplex2',
    inStock: true,
    seller: 'haircare_deals',
  },
  {
    source: 'ebay',
    itemCents: 2650,
    shipCents: 550,
    deliveredCents: 3200,
    title: 'OLAPLEX No 3 Hair Perfector Treatment 3.3oz New',
    url: 'https://ebay.com/itm/olaplex3',
    inStock: true,
    seller: 'cosmeticstore',
  },
];

// ============================================================================
// Integration Tests
// ============================================================================

describe('pricing-pipeline-integration', () => {
  describe('market-match mode', () => {
    it('targets eBay floor for competitive pricing', () => {
      const ebayComps = NEURO_MINTS_COMPS.filter(c => c.source === 'ebay');
      const activeFloor = Math.min(...ebayComps.map(c => c.deliveredCents));
      const activeMedian = 2195; // middle of [1895, 2195, 2198]
      
      const result = calculateTargetDelivered(
        'market-match',
        activeFloor,
        activeMedian,
        null,  // no sold data
        0,
        2995,  // amazon
        null,
        100,   // undercut
        1099   // min delivered
      );
      
      expect(result.targetCents).toBe(1895); // eBay floor
      expect(result.fallbackUsed).toBe(false);
    });

    it('uses sold median when lower than active floor', () => {
      const result = calculateTargetDelivered(
        'market-match',
        1995,  // activeFloor
        2495,  // activeMedian
        1795,  // soldMedian (lower!)
        12,    // soldCount (strong)
        null,
        null,
        100,
        1099
      );
      
      expect(result.targetCents).toBe(1795); // sold median wins
      expect(result.soldStrong).toBe(true);
    });
  });

  describe('fast-sale mode', () => {
    it('undercuts eBay floor by specified amount', () => {
      const result = calculateTargetDelivered(
        'fast-sale',
        1995,  // activeFloor
        2495,
        null,
        0,
        null,
        null,
        150,   // undercut $1.50
        1099
      );
      
      expect(result.targetCents).toBe(1845); // 1995 - 150
    });

    it('respects minimum delivered price', () => {
      const result = calculateTargetDelivered(
        'fast-sale',
        1199,  // activeFloor
        1499,
        null,
        0,
        null,
        null,
        300,   // undercut $3
        1099   // min delivered
      );
      
      expect(result.targetCents).toBe(1099); // floored at min
    });
  });

  describe('max-margin mode', () => {
    it('uses median for higher margin', () => {
      const result = calculateTargetDelivered(
        'max-margin',
        1895,  // activeFloor
        2195,  // activeMedian
        null,
        0,
        null,
        null,
        100,
        1099
      );
      
      expect(result.targetCents).toBe(2195); // median, not floor
    });
  });

  describe('item/shipping split', () => {
    it('splits delivered into item + shipping', () => {
      const settings: DeliveredPricingSettings = {
        ...DEFAULT_PRICING_SETTINGS,
        shippingEstimateCents: 600,
        minItemCents: 499,
      };
      
      const result = splitDeliveredPrice(1895, settings);
      
      expect(result.itemCents).toBe(1295); // 1895 - 600
      expect(result.shipCents).toBe(600);
      expect(result.freeShipApplied).toBe(false);
      expect(result.canCompete).toBe(true);
    });

    it('applies free shipping when enabled and affordable', () => {
      const settings: DeliveredPricingSettings = {
        ...DEFAULT_PRICING_SETTINGS,
        shippingEstimateCents: 500,
        minItemCents: 499,
        allowFreeShippingWhenNeeded: true,
        freeShippingMaxSubsidyCents: 600,
      };
      
      // Target is $8.99 delivered, can't do $3.99 item + $5 ship (need free ship)
      // With free shipping, item = $8.99, ship = $0
      const result = splitDeliveredPrice(899, settings);
      
      expect(result.itemCents).toBe(899);
      expect(result.shipCents).toBe(0);
      expect(result.freeShipApplied).toBe(true);
      expect(result.subsidyCents).toBe(500);
      expect(result.canCompete).toBe(true);
    });

    it('marks cannotCompete when free shipping not enabled and cant hit target', () => {
      const settings: DeliveredPricingSettings = {
        ...DEFAULT_PRICING_SETTINGS,
        shippingEstimateCents: 850, // shoes
        minItemCents: 499,
        allowFreeShippingWhenNeeded: false,
      };
      
      // Target $12.99 delivered, naive item = $4.49, below min
      // Without free shipping enabled, we can't compete
      const result = splitDeliveredPrice(1299, settings);
      
      expect(result.canCompete).toBe(false);
      expect(result.warnings).toContain('cannotCompete');
    });

    it('uses free shipping to compete on low-price items', () => {
      const settings: DeliveredPricingSettings = {
        ...DEFAULT_PRICING_SETTINGS,
        shippingEstimateCents: 600,
        minItemCents: 499,
        allowFreeShippingWhenNeeded: true,
        freeShippingMaxSubsidyCents: 600,
      };
      
      // Market: $7.00 delivered with free shipping
      // With our free shipping: item = $7.00, ship = $0, subsidy = $6.00
      const result = splitDeliveredPrice(700, settings);
      
      expect(result.itemCents).toBe(700);
      expect(result.shipCents).toBe(0);
      expect(result.freeShipApplied).toBe(true);
      expect(result.canCompete).toBe(true);
    });
  });

  describe('smart shipping integration', () => {
    it('detects beauty category for haircare products', () => {
      const category = detectCategory('Olaplex', 'No 3 Hair Perfector 3.3oz');
      expect(category).toBe('haircare');
    });

    it('uses category-based shipping for beauty products', () => {
      const estimate = getShippingEstimate('Olaplex', 'No 3 Hair Perfector', []);
      
      expect(estimate.cents).toBe(CATEGORY_SHIPPING['haircare']);
      expect(estimate.source).toBe('category');
    });

    it('uses comp-based shipping when enough data', () => {
      const estimate = getShippingEstimate(
        'Olaplex',
        'No 3 Hair Perfector',
        OLAPLEX_COMPS,
        { preferredSource: 'comps' }
      );
      
      // Comps have: 499, 0, 550 → median = 499
      expect(estimate.cents).toBe(499);
      expect(estimate.source).toBe('comp-median');
    });

    it('lowers shipping when most comps offer free', () => {
      const freeShipComps: CompetitorPrice[] = [
        { source: 'ebay', itemCents: 1000, shipCents: 0, deliveredCents: 1000, title: '', url: null, inStock: true, seller: '' },
        { source: 'ebay', itemCents: 1100, shipCents: 0, deliveredCents: 1100, title: '', url: null, inStock: true, seller: '' },
        { source: 'ebay', itemCents: 1200, shipCents: 0, deliveredCents: 1200, title: '', url: null, inStock: true, seller: '' },
        { source: 'ebay', itemCents: 900, shipCents: 500, deliveredCents: 1400, title: '', url: null, inStock: true, seller: '' },
      ];
      
      const estimate = getShippingEstimate(
        'Generic',
        'Product',
        freeShipComps,
        { preferredSource: 'comps' }
      );
      
      // 75% free shipping → lower estimate
      expect(estimate.cents).toBe(400); // $4.00 when most free
      expect(estimate.confidence).toBe('high');
    });
  });

  describe('fallback behavior', () => {
    it('falls back to retail at 60% when no eBay comps', () => {
      const result = calculateTargetDelivered(
        'market-match',
        null,  // no eBay floor
        null,
        null,
        0,
        2995,  // Amazon $29.95
        null,
        100,
        1099
      );
      
      // 60% of $29.95 = $17.97
      expect(result.targetCents).toBe(1797);
      expect(result.fallbackUsed).toBe(true);
      expect(result.warnings).toContain('noEbayComps');
      expect(result.warnings).toContain('usingRetailFallback');
    });

    it('returns 0 with noPricingData warning when no data', () => {
      const result = calculateTargetDelivered(
        'market-match',
        null,
        null,
        null,
        0,
        null,
        null,
        100,
        1099
      );
      
      expect(result.targetCents).toBe(0);
      expect(result.warnings).toContain('noPricingData');
    });
  });

  describe('end-to-end scenarios', () => {
    it('prices Neuro Mints competitively (mock)', () => {
      // Simulate the full pipeline with mock data
      const ebayComps = NEURO_MINTS_COMPS.filter(c => c.source === 'ebay');
      const retailComps = NEURO_MINTS_COMPS.filter(c => c.source !== 'ebay');
      
      // Step 1: Find floor
      const activeFloor = Math.min(...ebayComps.map(c => c.deliveredCents));
      expect(activeFloor).toBe(1895);
      
      // Step 2: Calculate target (market-match)
      const targetResult = calculateTargetDelivered(
        'market-match',
        activeFloor,
        2195, // median
        null,
        0,
        retailComps[0]?.deliveredCents ?? null,
        null,
        100,
        1099
      );
      expect(targetResult.targetCents).toBe(1895);
      
      // Step 3: Get shipping estimate (supplements = $5.00)
      const shippingEstimate = getShippingEstimate(
        'Neuro',
        'Vita+Mints D3 K2 90 Pieces',
        ebayComps
      );
      expect(shippingEstimate.cents).toBe(500); // supplements
      
      // Step 4: Split into item + shipping
      const settings: DeliveredPricingSettings = {
        ...DEFAULT_PRICING_SETTINGS,
        shippingEstimateCents: shippingEstimate.cents,
      };
      const splitResult = splitDeliveredPrice(targetResult.targetCents, settings);
      
      // Verify final pricing
      expect(splitResult.itemCents).toBe(1395); // $13.95
      expect(splitResult.shipCents).toBe(500);  // $5.00
      expect(splitResult.itemCents + splitResult.shipCents).toBe(1895); // $18.95 total
    });

    it('prices Olaplex competitively (mock)', () => {
      const ebayComps = OLAPLEX_COMPS;
      
      // Step 1: Find floor
      const activeFloor = Math.min(...ebayComps.map(c => c.deliveredCents));
      expect(activeFloor).toBe(2799); // $27.99 delivered
      
      // Step 2: Get shipping estimate (haircare = $5.00)
      const shippingEstimate = getShippingEstimate(
        'Olaplex',
        'No 3 Hair Perfector 3.3oz',
        ebayComps
      );
      expect(shippingEstimate.cents).toBe(500); // haircare
      
      // Step 3: Split
      const settings: DeliveredPricingSettings = {
        ...DEFAULT_PRICING_SETTINGS,
        shippingEstimateCents: shippingEstimate.cents,
      };
      const splitResult = splitDeliveredPrice(activeFloor, settings);
      
      // Verify
      expect(splitResult.itemCents).toBe(2299); // $22.99
      expect(splitResult.shipCents).toBe(500);  // $5.00
      expect(splitResult.itemCents + splitResult.shipCents).toBe(2799);
    });
  });
});
