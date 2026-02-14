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

    // ================================================================
    // Fix: Sold median contamination guard (Moon Brew bug)
    // When sold median >> active floor AND no retail validation,
    // cap target at 1.5x floor to prevent wildly inflated prices
    // ================================================================
    it('caps sold median at 1.5x floor when no retail validation (Moon Brew bug)', () => {
      // Moon Brew scenario: floor=$24, soldMedian=$80, no Amazon/Walmart/brandSite
      const result = calculateTargetDelivered(
        'market-match',
        2400, // activeFloor ($24 eBay listing)
        2400, // activeMedian (same, only 1 comp)
        8005, // soldMedian (~$80, contaminated with multi-packs)
        8,    // soldCount (strong: >= 5)
        null, // NO amazon
        null, // NO walmart
        100,
        minDelivered,
        [],   // no retail comps
        null, // no Target
        null  // no brand site
      );
      // Should cap at 1.5x floor = $36.00, NOT use soldMedian $80.05
      expect(result.targetCents).toBe(3600); // 2400 * 1.5
      expect(result.warnings).toContain('soldMedianCappedNoRetail');
    });

    it('uses sold median when retail validates it (outlier floor is real)', () => {
      // When Amazon confirms high price, trust soldMedian over floor
      const result = calculateTargetDelivered(
        'market-match',
        2400, // activeFloor ($24 - true outlier/auction)
        2400, // activeMedian
        8000, // soldMedian ($80)
        8,    // soldCount (strong)
        7500, // Amazon $75 - validates that soldMedian is correct
        null, // no walmart
        100,
        minDelivered,
        [],   // no retail comps
        null, // no Target
        null  // no brand site
      );
      // Amazon validates → retail cap = 80% of $75 = $60
      // soldMedian ($80) would be capped by retail cap ($60)
      expect(result.targetCents).toBeLessThanOrEqual(6000);
      expect(result.warnings).not.toContain('soldMedianCappedNoRetail');
    });

    it('detects contamination with single retail comp (relaxed from 2+)', () => {
      // Even 1 reliable retail comp at $48 should catch $80 sold median as contaminated
      const retailComps: CompetitorPrice[] = [{
        source: 'other',
        itemCents: 4800,
        shipCents: 0,
        deliveredCents: 4800,
        title: 'Moon Brew Mind Hot Cocoa',
        url: null,
        inStock: true,
        seller: 'Moon Brew Official',
      }];
      const result = calculateTargetDelivered(
        'market-match',
        2400, // activeFloor ($24)
        2400, // activeMedian
        8000, // soldMedian ($80 - 1.67x of $48 retail > 1.5x threshold)
        8,    // soldCount (strong)
        null, // no Amazon
        null, // no Walmart
        100,
        minDelivered,
        retailComps, // 1 retail comp at $48
        null, // no Target
        null  // no brand site
      );
      // Sold data should be marked contaminated, soldStrong reset to false
      // With soldStrong=false, should fall back to activeFloor
      expect(result.soldStrong).toBe(false);
      expect(result.targetCents).toBeLessThanOrEqual(4800); // Should not exceed retail
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

  // ========================================================================
  // PRICING FIX SPEC - Required scenarios (2026-01-06)
  // Tests the invariant: itemPriceCents + shippingChargeCents === targetDeliveredTotalCents
  // ========================================================================
  describe('splitDeliveredPrice - invariant enforcement', () => {
    
    /**
     * Scenario 1 — Free shipping mode
     * When shippingChargeCents = 0, item = full delivered price
     */
    it('Scenario 1: Free shipping - invariant holds', () => {
      const settings: DeliveredPricingSettings = {
        mode: 'market-match',
        shippingEstimateCents: 0,  // FREE_SHIPPING mode
        minItemCents: 499,
        undercutCents: 100,
        allowFreeShippingWhenNeeded: true,
        freeShippingMaxSubsidyCents: 500,
        lowPriceMode: 'FLAG_ONLY',
        useSmartShipping: false,
      };
      
      const result = splitDeliveredPrice(2038, settings);
      
      expect(result.shipCents).toBe(0);
      expect(result.itemCents).toBe(2038);
      expect(result.canCompete).toBe(true);
      
      // INVARIANT CHECK
      expect(result.itemCents + result.shipCents).toBe(2038);
    });

    /**
     * Scenario 2 — Buyer pays flat shipping
     * Normal split: item = delivered - shippingCharge
     */
    it('Scenario 2: Buyer pays flat shipping - invariant holds', () => {
      const settings: DeliveredPricingSettings = {
        mode: 'market-match',
        shippingEstimateCents: 600,  // BUYER_PAYS_FLAT: $6.00
        minItemCents: 499,
        undercutCents: 100,
        allowFreeShippingWhenNeeded: false,
        freeShippingMaxSubsidyCents: 500,
        lowPriceMode: 'FLAG_ONLY',
        useSmartShipping: false,
      };
      
      const result = splitDeliveredPrice(2038, settings);
      
      expect(result.shipCents).toBe(600);
      expect(result.itemCents).toBe(1438);  // 2038 - 600
      expect(result.canCompete).toBe(true);
      
      // INVARIANT CHECK
      expect(result.itemCents + result.shipCents).toBe(2038);
    });

    /**
     * Scenario 3 — Too-cheap under buyer pays, free-ship fallback ON
     * Item would be below min floor, so flip to FREE_SHIPPING
     */
    it('Scenario 3: Too cheap, free-ship fallback ON - flips to free shipping', () => {
      const settings: DeliveredPricingSettings = {
        mode: 'market-match',
        shippingEstimateCents: 600,  // BUYER_PAYS_FLAT: $6.00
        minItemCents: 499,           // $4.99 min
        undercutCents: 100,
        allowFreeShippingWhenNeeded: true,  // fallback ON
        freeShippingMaxSubsidyCents: 600,
        lowPriceMode: 'FLAG_ONLY',
        useSmartShipping: false,
      };
      
      // Target $8.00 delivered. With $6 shipping, item = $2.00 (below $4.99 min)
      const result = splitDeliveredPrice(800, settings);
      
      // Should flip to FREE_SHIPPING
      expect(result.shipCents).toBe(0);
      expect(result.itemCents).toBe(800);
      expect(result.freeShipApplied).toBe(true);
      expect(result.canCompete).toBe(true);
      expect(result.warnings).toContain('autoFreeShippingOnLowPrice');
      
      // INVARIANT CHECK
      expect(result.itemCents + result.shipCents).toBe(800);
    });

    /**
     * Scenario 4 — Too-cheap under buyer pays, free-ship fallback OFF
     * Cannot compete, must be explicit (not silent clamp)
     */
    it('Scenario 4: Too cheap, free-ship fallback OFF - cannotCompete explicit', () => {
      const settings: DeliveredPricingSettings = {
        mode: 'market-match',
        shippingEstimateCents: 600,  // BUYER_PAYS_FLAT: $6.00
        minItemCents: 499,           // $4.99 min
        undercutCents: 100,
        allowFreeShippingWhenNeeded: false,  // fallback OFF
        freeShippingMaxSubsidyCents: 500,
        lowPriceMode: 'FLAG_ONLY',
        useSmartShipping: false,
      };
      
      // Target $8.00 delivered. With $6 shipping, item = $2.00 (below $4.99 min)
      const result = splitDeliveredPrice(800, settings);
      
      // Should NOT silently clamp - must return cannotCompete
      expect(result.canCompete).toBe(false);
      expect(result.warnings).toContain('minItemFloorHit');
      expect(result.warnings).toContain('cannotCompete');
      
      // Returns minimum viable price (overpriced vs market)
      expect(result.itemCents).toBe(499);
      expect(result.shipCents).toBe(600);
      
      // Note: invariant does NOT hold for cannotCompete cases
      // This is explicit and expected - we're returning our floor, not market price
    });

    /**
     * Additional: Verify the same shippingChargeCents is used in split
     * This catches the "+ $6 then - $7.10" drift bug
     */
    it('uses same shippingChargeCents in split (no drift)', () => {
      const settings: DeliveredPricingSettings = {
        mode: 'market-match',
        shippingEstimateCents: 710,  // $7.10 flat rate
        minItemCents: 499,
        undercutCents: 100,
        allowFreeShippingWhenNeeded: false,
        freeShippingMaxSubsidyCents: 500,
        lowPriceMode: 'FLAG_ONLY',
        useSmartShipping: false,
      };
      
      const targetDelivered = 2500;  // $25.00 delivered
      const result = splitDeliveredPrice(targetDelivered, settings);
      
      // Item = 2500 - 710 = 1790
      expect(result.itemCents).toBe(1790);
      expect(result.shipCents).toBe(710);
      
      // INVARIANT: Must match exactly
      expect(result.itemCents + result.shipCents).toBe(targetDelivered);
    });
  });

  // ========================================================================
  // SPEC TESTS (from user request 2026-01-06)
  // Uses minItemCents=499 ($4.99), buyerShippingChargeCents=600 ($6.00)
  // ========================================================================
  describe('splitDeliveredPrice - spec acceptance tests', () => {
    
    /**
     * Test A (BUYER_PAYS_SHIPPING OK):
     * targetDeliveredCents=2038 ($20.38)
     * Expected: finalShip=600, finalItem=1438, total=2038, canCompete=true
     */
    it('Test A: BUYER_PAYS_SHIPPING OK - normal split', () => {
      const settings: DeliveredPricingSettings = {
        mode: 'market-match',
        shippingEstimateCents: 600,  // buyerShippingChargeCents
        minItemCents: 499,
        undercutCents: 100,
        allowFreeShippingWhenNeeded: false,
        freeShippingMaxSubsidyCents: 500,
        lowPriceMode: 'FLAG_ONLY',
        useSmartShipping: false,
      };
      
      const result = splitDeliveredPrice(2038, settings);
      
      expect(result.shipCents).toBe(600);
      expect(result.itemCents).toBe(1438);  // 2038 - 600
      expect(result.canCompete).toBe(true);
      expect(result.itemCents + result.shipCents).toBe(2038);
    });

    /**
     * Test B (BUYER_PAYS_SHIPPING cannotCompete):
     * targetDeliveredCents=900 ($9.00)
     * rawItem=300 -> clamped to 499
     * Expected: finalShip=600, finalItem=499, total=1099, canCompete=false
     */
    it('Test B: BUYER_PAYS_SHIPPING cannotCompete - clamped to min', () => {
      const settings: DeliveredPricingSettings = {
        mode: 'market-match',
        shippingEstimateCents: 600,  // buyerShippingChargeCents
        minItemCents: 499,
        undercutCents: 100,
        allowFreeShippingWhenNeeded: false,  // no fallback
        freeShippingMaxSubsidyCents: 500,
        lowPriceMode: 'FLAG_ONLY',
        useSmartShipping: false,
      };
      
      const result = splitDeliveredPrice(900, settings);
      
      expect(result.shipCents).toBe(600);
      expect(result.itemCents).toBe(499);  // clamped to min
      expect(result.canCompete).toBe(false);
      expect(result.warnings).toContain('minItemFloorHit');
      expect(result.warnings).toContain('cannotCompete');
      // total = 499 + 600 = 1099 (exceeds target 900)
      expect(result.itemCents + result.shipCents).toBe(1099);
    });

    /**
     * Test C (FREE_SHIPPING OK):
     * targetDeliveredCents=2038
     * Expected: finalShip=0, finalItem=2038, total=2038, canCompete=true
     */
    it('Test C: FREE_SHIPPING OK - full delivered as item', () => {
      const settings: DeliveredPricingSettings = {
        mode: 'market-match',
        shippingEstimateCents: 0,  // FREE_SHIPPING mode
        minItemCents: 499,
        undercutCents: 100,
        allowFreeShippingWhenNeeded: false,
        freeShippingMaxSubsidyCents: 500,
        lowPriceMode: 'FLAG_ONLY',
        useSmartShipping: false,
      };
      
      const result = splitDeliveredPrice(2038, settings);
      
      expect(result.shipCents).toBe(0);
      expect(result.itemCents).toBe(2038);
      expect(result.canCompete).toBe(true);
      expect(result.itemCents + result.shipCents).toBe(2038);
    });

    /**
     * Test D (Auto free-ship fallback fixes it):
     * mode starts BUYER_PAYS_SHIPPING, targetDeliveredCents=900
     * allowAutoFreeShippingOnLowPrice=true
     * Expected: fallback to FREE_SHIPPING
     * finalShip=0, finalItem=900, total=900, canCompete=true
     * warning includes 'autoFreeShippingOnLowPrice'
     */
    it('Test D: Auto free-ship fallback - flips to free shipping', () => {
      const settings: DeliveredPricingSettings = {
        mode: 'market-match',
        shippingEstimateCents: 600,  // starts as BUYER_PAYS_SHIPPING
        minItemCents: 499,
        undercutCents: 100,
        allowFreeShippingWhenNeeded: true,  // enables fallback
        freeShippingMaxSubsidyCents: 600,   // allows full subsidy
        lowPriceMode: 'FLAG_ONLY',
        useSmartShipping: false,
      };
      
      const result = splitDeliveredPrice(900, settings);
      
      // Should flip to FREE_SHIPPING
      expect(result.shipCents).toBe(0);
      expect(result.itemCents).toBe(900);
      expect(result.freeShipApplied).toBe(true);
      expect(result.canCompete).toBe(true);
      expect(result.warnings).toContain('autoFreeShippingOnLowPrice');
      expect(result.itemCents + result.shipCents).toBe(900);
    });
  });
});
