/**
 * Unit tests for Delivered-Price-First Pricing Engine
 * 
 * @see docs/PRICING-OVERHAUL.md - Phase 1 test cases
 */

import {
  parseShippingFromDelivery,
  googleResultToCompetitor,
  median,
  getActiveFloorDelivered,
  getActiveMedianDelivered,
  calculateTargetDelivered,
  splitDeliveredPrice,
  DEFAULT_PRICING_SETTINGS,
  type CompetitorPrice,
  type DeliveredPricingSettings,
} from '../../src/lib/delivered-pricing.js';

describe('delivered-pricing', () => {
  // ========================================================================
  // parseShippingFromDelivery
  // ========================================================================
  describe('parseShippingFromDelivery', () => {
    it('returns 0 for free shipping', () => {
      expect(parseShippingFromDelivery('Free delivery')).toBe(0);
      expect(parseShippingFromDelivery('Free delivery by Fri')).toBe(0);
      expect(parseShippingFromDelivery('FREE shipping')).toBe(0);
    });

    it('extracts dollar amount from shipping text', () => {
      expect(parseShippingFromDelivery('+$5.99 shipping')).toBe(599);
      expect(parseShippingFromDelivery('$4.99 delivery')).toBe(499);
      expect(parseShippingFromDelivery('Shipping: $6.00')).toBe(600);
    });

    it('returns 0 for undefined or unparseable', () => {
      expect(parseShippingFromDelivery(undefined)).toBe(0);
      expect(parseShippingFromDelivery('')).toBe(0);
      expect(parseShippingFromDelivery('Delivery available')).toBe(0);
    });
  });

  // ========================================================================
  // googleResultToCompetitor
  // ========================================================================
  describe('googleResultToCompetitor', () => {
    it('correctly identifies Amazon seller', () => {
      const result = googleResultToCompetitor({
        position: 1,
        title: 'Test Product',
        price: '$29.95',
        extracted_price: 29.95,
        seller: 'Amazon.com',
        delivery: 'Free delivery',
      });
      expect(result.source).toBe('amazon');
      expect(result.itemCents).toBe(2995);
      expect(result.shipCents).toBe(0);
      expect(result.deliveredCents).toBe(2995);
    });

    it('correctly identifies eBay seller', () => {
      const result = googleResultToCompetitor({
        position: 1,
        title: 'Test Product',
        price: '$19.95',
        extracted_price: 19.95,
        seller: 'eBay',
        delivery: 'Free delivery',
      });
      expect(result.source).toBe('ebay');
      expect(result.deliveredCents).toBe(1995);
    });

    it('calculates delivered with shipping', () => {
      const result = googleResultToCompetitor({
        position: 1,
        title: 'Test Product',
        price: '$14.99',
        extracted_price: 14.99,
        seller: 'eBay',
        delivery: '+$5.99 shipping',
      });
      expect(result.itemCents).toBe(1499);
      expect(result.shipCents).toBe(599);
      expect(result.deliveredCents).toBe(2098);
    });

    it('marks out of stock correctly', () => {
      const result = googleResultToCompetitor({
        position: 1,
        title: 'Test Product',
        price: '$19.95',
        extracted_price: 19.95,
        seller: 'eBay',
        stock_information: 'Out of stock',
      });
      expect(result.inStock).toBe(false);
    });
  });

  // ========================================================================
  // median
  // ========================================================================
  describe('median', () => {
    it('returns median of odd-length array', () => {
      expect(median([1, 3, 5])).toBe(3);
      expect(median([10, 20, 30, 40, 50])).toBe(30);
    });

    it('returns average of middle two for even-length', () => {
      expect(median([1, 2, 3, 4])).toBe(3); // (2+3)/2 rounded
      expect(median([10, 20, 30, 40])).toBe(25);
    });

    it('handles single value', () => {
      expect(median([42])).toBe(42);
    });

    it('returns 0 for empty array', () => {
      expect(median([])).toBe(0);
    });
  });

  // ========================================================================
  // getActiveFloorDelivered
  // ========================================================================
  describe('getActiveFloorDelivered', () => {
    it('returns lowest eBay delivered price', () => {
      const comps: CompetitorPrice[] = [
        { source: 'ebay', deliveredCents: 2195, itemCents: 2195, shipCents: 0, title: '', url: null, inStock: true, seller: 'eBay' },
        { source: 'ebay', deliveredCents: 1995, itemCents: 1995, shipCents: 0, title: '', url: null, inStock: true, seller: 'eBay' },
        { source: 'ebay', deliveredCents: 2495, itemCents: 2495, shipCents: 0, title: '', url: null, inStock: true, seller: 'eBay' },
      ];
      expect(getActiveFloorDelivered(comps)).toBe(1995);
    });

    it('excludes out of stock items', () => {
      const comps: CompetitorPrice[] = [
        { source: 'ebay', deliveredCents: 1000, itemCents: 1000, shipCents: 0, title: '', url: null, inStock: false, seller: 'eBay' },
        { source: 'ebay', deliveredCents: 2000, itemCents: 2000, shipCents: 0, title: '', url: null, inStock: true, seller: 'eBay' },
      ];
      expect(getActiveFloorDelivered(comps)).toBe(2000);
    });

    it('returns null when no eBay comps', () => {
      const comps: CompetitorPrice[] = [
        { source: 'amazon', deliveredCents: 2995, itemCents: 2995, shipCents: 0, title: '', url: null, inStock: true, seller: 'Amazon' },
      ];
      expect(getActiveFloorDelivered(comps)).toBeNull();
    });
  });

  // ========================================================================
  // calculateTargetDelivered
  // ========================================================================
  describe('calculateTargetDelivered', () => {
    const minDelivered = 499 + 600; // $4.99 item + $6.00 ship

    it('market-match uses activeFloor', () => {
      const result = calculateTargetDelivered(
        'market-match',
        1995, // activeFloor
        2495, // activeMedian
        null, // soldMedian
        0,    // soldCount
        2995, // amazon
        2795, // walmart
        100,  // undercut
        minDelivered
      );
      expect(result.targetCents).toBe(1995);
      expect(result.fallbackUsed).toBe(false);
    });

    it('fast-sale undercuts activeFloor', () => {
      const result = calculateTargetDelivered(
        'fast-sale',
        1995,
        2495,
        null, // soldMedian
        0,    // soldCount
        null,
        null,
        150, // $1.50 undercut
        minDelivered
      );
      expect(result.targetCents).toBe(1845); // 1995 - 150
    });

    it('fast-sale respects minimum delivered', () => {
      const result = calculateTargetDelivered(
        'fast-sale',
        1200, // activeFloor
        1500,
        null, // soldMedian
        0,    // soldCount
        null,
        null,
        500, // $5 undercut would go below min
        minDelivered
      );
      expect(result.targetCents).toBe(minDelivered); // Floored at min
    });

    it('max-margin uses activeMedian', () => {
      const result = calculateTargetDelivered(
        'max-margin',
        1995,
        2495, // activeMedian (higher)
        null, // soldMedian
        0,    // soldCount
        null,
        null,
        100,
        minDelivered
      );
      expect(result.targetCents).toBe(2495);
    });

    it('falls back to retail when no eBay comps', () => {
      const result = calculateTargetDelivered(
        'market-match',
        null, // no eBay floor
        null,
        null, // soldMedian
        0,    // soldCount
        2995, // amazon
        2795, // walmart (lower)
        100,
        minDelivered
      );
      // Should use 60% of walmart (lower retail)
      expect(result.targetCents).toBe(Math.round(2795 * 0.60));
      expect(result.fallbackUsed).toBe(true);
      expect(result.warnings).toContain('noEbayComps');
      expect(result.warnings).toContain('usingRetailFallback');
    });

    it('returns 0 when no pricing data', () => {
      const result = calculateTargetDelivered(
        'market-match',
        null,
        null,
        null, // soldMedian
        0,    // soldCount
        null,
        null,
        100,
        minDelivered
      );
      expect(result.targetCents).toBe(0);
      expect(result.warnings).toContain('noPricingData');
    });

    // Phase 3: Sold comps tests
    it('market-match uses min(soldMedian, activeFloor) when sold strong', () => {
      const result = calculateTargetDelivered(
        'market-match',
        1995, // activeFloor
        2495, // activeMedian
        1895, // soldMedian (LOWER than activeFloor)
        12,   // soldCount (strong: >= 5)
        null,
        null,
        100,
        minDelivered
      );
      expect(result.targetCents).toBe(1895); // sold median wins
      expect(result.soldStrong).toBe(true);
    });

    it('market-match uses activeFloor when sold weak', () => {
      const result = calculateTargetDelivered(
        'market-match',
        1995, // activeFloor
        2495, // activeMedian
        1795, // soldMedian (lower but weak)
        3,    // soldCount (weak: < 5)
        null,
        null,
        100,
        minDelivered
      );
      expect(result.targetCents).toBe(1995); // falls back to activeFloor
      expect(result.soldStrong).toBe(false);
    });

    it('max-margin uses min(activeMedian, soldMedian) when sold strong', () => {
      const result = calculateTargetDelivered(
        'max-margin',
        1995, // activeFloor
        2495, // activeMedian
        2295, // soldMedian (lower than activeMedian)
        8,    // soldCount (strong)
        null,
        null,
        100,
        minDelivered
      );
      expect(result.targetCents).toBe(2295); // sold median wins
      expect(result.soldStrong).toBe(true);
    });
  });

  // ========================================================================
  // splitDeliveredPrice
  // ========================================================================
  describe('splitDeliveredPrice', () => {
    const defaultSettings: DeliveredPricingSettings = {
      mode: 'market-match',
      shippingEstimateCents: 600,
      minItemCents: 499,
      undercutCents: 100,
      allowFreeShippingWhenNeeded: false,
      freeShippingMaxSubsidyCents: 500,
      lowPriceMode: 'FLAG_ONLY',
      useSmartShipping: false,
    };

    it('calculates item price from delivered minus shipping', () => {
      // eBay comp: $19.95 delivered
      // Our shipping: $6.00
      // Expected item: $13.95
      const result = splitDeliveredPrice(1995, defaultSettings);
      expect(result.itemCents).toBe(1395);
      expect(result.shipCents).toBe(600);
      expect(result.freeShipApplied).toBe(false);
      expect(result.canCompete).toBe(true);
    });

    it('uses free shipping when needed and enabled', () => {
      const settings: DeliveredPricingSettings = { 
        ...defaultSettings, 
        allowFreeShippingWhenNeeded: true,
        freeShippingMaxSubsidyCents: 600,
      };
      // Target: $8.00 delivered
      // Naive item: $2.00 (too low)
      // With free ship: item = $8.00, ship = $0
      const result = splitDeliveredPrice(800, settings);
      expect(result.itemCents).toBe(800);
      expect(result.shipCents).toBe(0);
      expect(result.subsidyCents).toBe(600);
      expect(result.freeShipApplied).toBe(true);
      expect(result.canCompete).toBe(true);
    });

    it('marks cannotCompete when subsidy exceeds cap', () => {
      const settings: DeliveredPricingSettings = { 
        ...defaultSettings, 
        allowFreeShippingWhenNeeded: true,
        shippingEstimateCents: 850,
        freeShippingMaxSubsidyCents: 500,
      };
      // Target: $6.00 delivered
      // Needs $8.50 subsidy but max is $5.00
      const result = splitDeliveredPrice(600, settings);
      expect(result.canCompete).toBe(false);
      expect(result.warnings).toContain('cannotCompete');
    });

    it('skips listing when lowPriceMode is AUTO_SKIP', () => {
      const settings: DeliveredPricingSettings = { 
        ...defaultSettings, 
        allowFreeShippingWhenNeeded: true,
        freeShippingMaxSubsidyCents: 300,
        lowPriceMode: 'AUTO_SKIP',
      };
      // Target: $6.00 delivered (can't compete with $3.00 subsidy cap)
      const result = splitDeliveredPrice(600, settings);
      expect(result.canCompete).toBe(false);
      expect(result.skipListing).toBe(true);
    });

    it('flags but does not skip when lowPriceMode is FLAG_ONLY', () => {
      const settings: DeliveredPricingSettings = { 
        ...defaultSettings, 
        allowFreeShippingWhenNeeded: true,
        freeShippingMaxSubsidyCents: 300,
        lowPriceMode: 'FLAG_ONLY',
      };
      // Target: $6.00 delivered
      const result = splitDeliveredPrice(600, settings);
      expect(result.canCompete).toBe(false);
      expect(result.skipListing).toBe(false);
      expect(result.warnings).toContain('cannotCompete');
    });

    it('returns cannotCompete when target below minimum item', () => {
      // Target: $3.00 delivered (below $4.99 min item)
      const result = splitDeliveredPrice(300, defaultSettings);
      expect(result.warnings).toContain('cannotCompete');
      expect(result.canCompete).toBe(false);
      expect(result.itemCents).toBe(499);
      expect(result.shipCents).toBe(600);
    });
  });

  // ========================================================================
  // Integration-style test (using mocked data)
  // ========================================================================
  describe('pricing flow integration', () => {
    it('prices Neuro Vita Mints competitively', () => {
      // Simulate: eBay comp at $19.95 free ship
      // Our shipping: $6.00
      // Expected: $13.95 item + $6.00 ship = $19.95 delivered
      
      const comps: CompetitorPrice[] = [
        { source: 'ebay', deliveredCents: 1995, itemCents: 1995, shipCents: 0, title: 'Neuro Vita Mints', url: null, inStock: true, seller: 'eBay' },
        { source: 'amazon', deliveredCents: 2995, itemCents: 2995, shipCents: 0, title: 'Neuro Vita Mints', url: null, inStock: true, seller: 'Amazon' },
      ];
      
      const activeFloor = getActiveFloorDelivered(comps);
      expect(activeFloor).toBe(1995);
      
      const targetResult = calculateTargetDelivered(
        'market-match',
        activeFloor,
        activeFloor, // median = floor for single comp
        null, // soldMedian
        0,    // soldCount
        2995,
        null,
        100,
        1099
      );
      expect(targetResult.targetCents).toBe(1995);
      
      const splitResult = splitDeliveredPrice(1995, DEFAULT_PRICING_SETTINGS);
      expect(splitResult.itemCents).toBe(1395);
      expect(splitResult.shipCents).toBe(600);
      
      // Final delivered matches market
      const ourDelivered = splitResult.itemCents + splitResult.shipCents;
      expect(ourDelivered).toBe(1995);
    });
  });
});
