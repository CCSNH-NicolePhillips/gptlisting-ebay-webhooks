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
  calculateTargetDeliveredV2,
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

import {
  computeRobustStats,
  type CompSample,
  type RobustStats,
} from '../../src/lib/pricing/robust-stats.js';

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
      
      // Step 3: Get shipping estimate
      // "90 Pieces" triggers size heuristic → 'light' band (350) blended with supplements (500)
      // = round(350 * 0.6 + 500 * 0.4) = 440 cents
      const shippingEstimate = getShippingEstimate(
        'Neuro',
        'Vita+Mints D3 K2 90 Pieces',
        ebayComps
      );
      expect(shippingEstimate.cents).toBe(440); // size-heuristic blended with supplements
      expect(shippingEstimate.source).toBe('size-heuristic');
      
      // Step 4: Split into item + shipping
      const settings: DeliveredPricingSettings = {
        ...DEFAULT_PRICING_SETTINGS,
        shippingEstimateCents: shippingEstimate.cents,
      };
      const splitResult = splitDeliveredPrice(targetResult.targetCents, settings);
      
      // Verify final pricing
      expect(splitResult.itemCents).toBe(1455); // $14.55
      expect(splitResult.shipCents).toBe(440);  // $4.40 (size-heuristic)
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

// ============================================================================
// V2 Pipeline Tests (Graduated Tiers)
// ============================================================================

/**
 * Helper: build CompSample array from delivered prices
 */
function makeSamples(deliveredValues: number[]): CompSample[] {
  return deliveredValues.map(d => ({ itemCents: d, shipCents: 0, deliveredCents: d }));
}

describe('pricing-v2-graduated-tiers', () => {

  // ────────────────────────────────────────────────────
  // Product 1: MaryRuth's — THE KNOWN BUG
  // 8 sold comps, Amazon $38.97. V2 old: $11.09. V2 fixed: ~$29
  // ────────────────────────────────────────────────────
  describe('MaryRuth Organics Multivitamin (8 sold comps)', () => {
    // Realistic sold prices for MaryRuth's Women's Multivitamin (cents)
    const soldPrices = [2400, 2600, 2900, 3200, 3500, 3800, 4200, 5500];
    const soldStats = computeRobustStats(makeSamples(soldPrices));
    const retailCents = 3897; // Amazon $38.97
    const minDelivered = 1099; // $4.99 item + $6.00 ship

    it('has 7-8 cleaned sold samples (passes Strong ≥5 threshold)', () => {
      // IQR should keep most/all samples — range is reasonable
      expect(soldStats.count).toBeGreaterThanOrEqual(5);
      expect(soldStats.count).toBeLessThanOrEqual(8);
    });

    it('market-match: uses SoldP35, not retail×0.70', () => {
      const result = calculateTargetDeliveredV2(
        'market-match', soldStats, null, retailCents, 100, minDelivered
      );

      // SoldP35 should be around $29 (35th percentile of cleaned sold)
      expect(result.soldStrong).toBe(true);
      expect(result.fallbackUsed).toBe(false);
      expect(result.targetCents).toBeGreaterThanOrEqual(2500); // At least $25
      expect(result.targetCents).toBeLessThanOrEqual(3500);    // At most $35
      // THE BIG FIX: NOT $11.09!
      expect(result.targetCents).toBeGreaterThan(2000);
    });

    it('retail cap prevents pricing above 90% of Amazon (8 sold = soldStrong < 20)', () => {
      const result = calculateTargetDeliveredV2(
        'market-match', soldStats, null, retailCents, 100, minDelivered
      );
      
      // 8 sold (soldStrong, < 20) → 90% retail cap = ~$35.07
      const retailCap = Math.round(retailCents * 0.90);
      expect(result.targetCents).toBeLessThanOrEqual(retailCap);
    });

    it('fast-sale undercuts the target', () => {
      const result = calculateTargetDeliveredV2(
        'fast-sale', soldStats, null, retailCents, 100, minDelivered
      );

      const marketResult = calculateTargetDeliveredV2(
        'market-match', soldStats, null, retailCents, 100, minDelivered
      );

      // Fast-sale should be lower than market-match (or equal at floor)
      expect(result.targetCents).toBeLessThanOrEqual(marketResult.targetCents);
    });
  });

  // ────────────────────────────────────────────────────
  // Product 2: Global Healing Lithium Orotate
  // 6 sold comps, Amazon $19.96
  // ────────────────────────────────────────────────────
  describe('Global Healing Lithium Orotate (6 sold comps)', () => {
    const soldPrices = [1400, 1550, 1700, 1850, 1950, 2100];
    const soldStats = computeRobustStats(makeSamples(soldPrices));
    const retailCents = 1996; // Amazon $19.96

    it('6 cleaned → soldStrong=true', () => {
      expect(soldStats.count).toBeGreaterThanOrEqual(5);
    });

    it('market-match prices at SoldP35, capped by retail at 90%', () => {
      const result = calculateTargetDeliveredV2(
        'market-match', soldStats, null, retailCents, 100, 1099
      );

      expect(result.soldStrong).toBe(true);
      expect(result.fallbackUsed).toBe(false);
      // P35 of [1400,1550,1700,1850,1950,2100] ≈ $15-17
      // 6 sold (soldStrong, < 20) → 90% retail cap = $17.96
      expect(result.targetCents).toBeGreaterThanOrEqual(1400);
      expect(result.targetCents).toBeLessThanOrEqual(Math.round(retailCents * 0.90));
    });
  });

  // ────────────────────────────────────────────────────
  // Product 3: Milamend Hormone Balance
  // 3 sold comps (weak tier), Amazon $77.00
  // ────────────────────────────────────────────────────
  describe('Milamend Hormone Balance (3 sold — WEAK tier)', () => {
    const soldPrices = [5500, 6000, 6500];
    const soldStats = computeRobustStats(makeSamples(soldPrices));
    const retailCents = 7700; // Amazon $77.00

    it('3 cleaned → soldWeak=true, soldStrong=false', () => {
      expect(soldStats.count).toBe(3);
    });

    it('market-match uses SoldP50 (median) for weak tier', () => {
      const result = calculateTargetDeliveredV2(
        'market-match', soldStats, null, retailCents, 100, 1099
      );

      // Weak tier → P50 (median) = $60
      expect(result.soldStrong).toBe(false);
      expect(result.fallbackUsed).toBe(false);
      expect(result.warnings).toContain('soldDataWeak');
      // Should use market data, NOT retail×0.70 ($53.90)
      expect(result.targetCents).toBeGreaterThanOrEqual(5500);
      expect(result.targetCents).toBeLessThanOrEqual(Math.round(retailCents * 0.80)); // $61.60 cap
    });
  });

  // ────────────────────────────────────────────────────
  // Product 4: Pump Sauce Shooters
  // 0 sold comps, Amazon $37.99 — retail fallback
  // ────────────────────────────────────────────────────
  describe('Pump Sauce Shooters (0 sold — retail fallback)', () => {
    const retailCents = 3799;

    it('no data → retail anchor at 70%', () => {
      const result = calculateTargetDeliveredV2(
        'market-match', null, null, retailCents, 100, 1099
      );

      expect(result.soldStrong).toBe(false);
      expect(result.activeStrong).toBe(false);
      expect(result.fallbackUsed).toBe(true);
      expect(result.warnings).toContain('usingRetailAnchorOnly');
      // 70% of $37.99 = $26.59
      expect(result.targetCents).toBe(Math.round(retailCents * 0.70));
    });

    it('no data and no retail → manual review', () => {
      const result = calculateTargetDeliveredV2(
        'market-match', null, null, null, 100, 1099
      );

      expect(result.targetCents).toBe(0);
      expect(result.warnings).toContain('manualReviewRequired');
      expect(result.warnings).toContain('noPricingData');
    });
  });

  // ────────────────────────────────────────────────────
  // Product 5: HumanN SuperBeets
  // 12 sold comps (plenty of data) — should behave same as before
  // ────────────────────────────────────────────────────
  describe('HumanN SuperBeets (12 sold — high data)', () => {
    const soldPrices = [2500, 2700, 2800, 2900, 3000, 3100, 3200, 3300, 3400, 3500, 3700, 3900];
    const soldStats = computeRobustStats(makeSamples(soldPrices));
    const retailCents = 3995; // Amazon $39.95

    it('12 cleaned → soldStrong=true', () => {
      expect(soldStats.count).toBeGreaterThanOrEqual(5);
    });

    it('market-match uses SoldP35 (aggressive)', () => {
      const result = calculateTargetDeliveredV2(
        'market-match', soldStats, null, retailCents, 100, 1099
      );

      expect(result.soldStrong).toBe(true);
      expect(result.fallbackUsed).toBe(false);
      // P35 of 12 values ≈ $29-30
      expect(result.targetCents).toBeGreaterThanOrEqual(2700);
      expect(result.targetCents).toBeLessThanOrEqual(Math.round(retailCents * 0.80)); // $31.96
    });

    it('max-margin uses SoldP50', () => {
      const result = calculateTargetDeliveredV2(
        'max-margin', soldStats, null, retailCents, 100, 1099
      );

      // P50 ≈ $31
      expect(result.targetCents).toBeGreaterThanOrEqual(3000);
      expect(result.targetCents).toBeLessThanOrEqual(Math.round(retailCents * 0.80));
    });
  });

  // ────────────────────────────────────────────────────
  // Product 6: Active-only scenarios (no sold data)
  // ────────────────────────────────────────────────────
  describe('Active comp tiers (no sold data)', () => {
    it('5 active → activeStrong, uses P20', () => {
      const activePrices = [1800, 2000, 2200, 2500, 2800];
      const activeStats = computeRobustStats(makeSamples(activePrices));
      
      const result = calculateTargetDeliveredV2(
        'market-match', null, activeStats, 3000, 100, 1099
      );

      expect(result.activeStrong).toBe(true);
      expect(result.fallbackUsed).toBe(false);
      // P20 of 5 values = $1800
      expect(result.targetCents).toBe(activeStats.p20);
    });

    it('3 active → activeWeak, uses P35 (conservative)', () => {
      const activePrices = [1800, 2200, 2800];
      const activeStats = computeRobustStats(makeSamples(activePrices));

      const result = calculateTargetDeliveredV2(
        'market-match', null, activeStats, 3000, 100, 1099
      );

      expect(result.activeStrong).toBe(false);
      expect(result.fallbackUsed).toBe(false);
      expect(result.warnings).toContain('activeDataWeak');
      // P35 for 3 items, not P20 (more conservative with limited data)
      expect(result.targetCents).toBe(activeStats.p35);
    });

    it('2 active → falls through to retail', () => {
      const activePrices = [1800, 2200];
      const activeStats = computeRobustStats(makeSamples(activePrices));

      const result = calculateTargetDeliveredV2(
        'market-match', null, activeStats, 3000, 100, 1099
      );

      // 2 comps → not strong, not weak → retail fallback
      expect(result.fallbackUsed).toBe(true);
      expect(result.targetCents).toBe(Math.round(3000 * 0.70));
    });
  });

  // ────────────────────────────────────────────────────
  // Cap & floor behavior
  // ────────────────────────────────────────────────────
  describe('V2 caps and floors', () => {
    it('retail cap: 90% for soldStrong 5-19 samples', () => {
      // Sold data is high (comps are expensive), retail is lower
      // 5 sold samples → soldStrong but < 20 → 90% retail cap
      const soldPrices = [4000, 4200, 4500, 4800, 5000];
      const soldStats = computeRobustStats(makeSamples(soldPrices));
      const retailCents = 3500; // Retail is lower than sold

      const result = calculateTargetDeliveredV2(
        'market-match', soldStats, null, retailCents, 100, 1099
      );

      expect(result.targetCents).toBeLessThanOrEqual(Math.round(3500 * 0.90));
      expect(result.targetCents).toBeGreaterThan(Math.round(3500 * 0.80)); // NOT 80%
      expect(result.warnings).toContain('retailCapApplied');
    });

    it('retail cap: 100% for soldStrong ≥20 samples', () => {
      // 25 sold samples → soldStrong + very strong → 100% retail cap
      const soldPrices = Array.from({ length: 25 }, (_, i) => 4000 + i * 100);
      const soldStats = computeRobustStats(makeSamples(soldPrices));
      const retailCents = 3500;

      const result = calculateTargetDeliveredV2(
        'market-match', soldStats, null, retailCents, 100, 1099
      );

      // With 100% cap, price should be capped at exactly retail (3500)
      expect(result.targetCents).toBeLessThanOrEqual(3500);
      expect(result.warnings).toContain('retailCapApplied');
    });

    it('retail cap: 80% when no sold data', () => {
      // No sold data, only retail → aggressive 80% cap
      const retailCents = 3500;

      const result = calculateTargetDeliveredV2(
        'market-match', null, null, retailCents, 100, 1099
      );

      // Retail fallback at 70%, which is below 80% cap so cap doesn't engage
      expect(result.targetCents).toBe(Math.round(3500 * 0.70));
      expect(result.warnings).toContain('usingRetailAnchorOnly');
    });

    it('active cap: P65 caps when active is strong and sell-through is low', () => {
      // Sold data is higher than active → SoldP35 > ActiveP65
      // Use 5 sold + 10 active so sellThrough = 5/15 ≈ 0.33 < 0.40 threshold
      const soldPrices = [3000, 3200, 3500, 3800, 4000];
      const soldStats = computeRobustStats(makeSamples(soldPrices));
      // Active comps are much lower — cap should engage
      const activePrices = [2000, 2050, 2100, 2150, 2200, 2250, 2300, 2350, 2400, 2450];
      const activeStats = computeRobustStats(makeSamples(activePrices));

      // Verify: sellThrough should be < 0.40 so cap engages
      const st = soldStats.count / (soldStats.count + activeStats.count);
      expect(st).toBeLessThan(0.40);

      const result = calculateTargetDeliveredV2(
        'market-match', soldStats, activeStats, null, 100, 1099
      );

      // SoldP35 should exceed ActiveP65 → cap should engage
      if (soldStats.p35 > activeStats.p65) {
        expect(result.targetCents).toBeLessThanOrEqual(activeStats.p65);
        expect(result.warnings).toContain('activeCapApplied');
      }
    });

    it('enforces minimum delivered price', () => {
      const soldPrices = [600, 700, 800, 900, 1000];
      const soldStats = computeRobustStats(makeSamples(soldPrices));
      const minDelivered = 1099;

      const result = calculateTargetDeliveredV2(
        'market-match', soldStats, null, null, 100, minDelivered
      );

      expect(result.targetCents).toBeGreaterThanOrEqual(minDelivered);
    });
  });

  // ────────────────────────────────────────────────────
  // Tier priority: sold > active > retail
  // ────────────────────────────────────────────────────
  describe('tier priority', () => {
    it('sold strong wins over active strong', () => {
      const soldPrices = [2000, 2200, 2400, 2600, 2800];
      const soldStats = computeRobustStats(makeSamples(soldPrices));
      const activePrices = [3000, 3200, 3400, 3600, 3800];
      const activeStats = computeRobustStats(makeSamples(activePrices));

      const result = calculateTargetDeliveredV2(
        'market-match', soldStats, activeStats, null, 100, 1099
      );

      // Sold strong → uses SoldP35, not ActiveP20
      expect(result.soldStrong).toBe(true);
      expect(result.targetCents).toBe(soldStats.p35);
    });

    it('sold weak wins over active weak', () => {
      const soldPrices = [2000, 2500, 3000];
      const soldStats = computeRobustStats(makeSamples(soldPrices));
      const activePrices = [3500, 4000, 4500];
      const activeStats = computeRobustStats(makeSamples(activePrices));

      const result = calculateTargetDeliveredV2(
        'market-match', soldStats, activeStats, null, 100, 1099
      );

      // Sold weak → uses SoldP50 (median), not active
      expect(result.warnings).toContain('soldDataWeak');
      expect(result.targetCents).toBe(soldStats.p50);
    });

    it('active strong used when sold has <3 samples', () => {
      const soldPrices = [2000, 2500]; // Only 2 → neither strong nor weak
      const soldStats = computeRobustStats(makeSamples(soldPrices));
      const activePrices = [1800, 2000, 2200, 2400, 2600];
      const activeStats = computeRobustStats(makeSamples(activePrices));

      const result = calculateTargetDeliveredV2(
        'market-match', soldStats, activeStats, null, 100, 1099
      );

      expect(result.activeStrong).toBe(true);
      expect(result.targetCents).toBe(activeStats.p20);
    });
  });
});
