# Pricing Overhaul: Delivered-Price-First Strategy

> **North Star**: Price to delivered-to-door, not item-only. Then back into item price + shipping.

## Problem Statement

Current 70% MSRP algorithm fails because:
- Market prices at 40-60% of retail with free shipping
- We compare item price when buyers compare delivered price
- 28% of products priced HIGHER than eBay competition (pricing-analysis.csv)

**Example**: Neuro Vita Mints D3+K2
- Amazon MSRP: $29.95
- Our algo: $29.95 × 0.70 = $20.97 + $6 ship = **$26.97 delivered**
- eBay competitor: $19.95 + free ship = **$19.95 delivered**
- We're $7.02 overpriced!

---

## Phase 1: Get Sales Now (Foundation)

**Goal**: Replace 70% algo with competitive delivered pricing using Google Shopping data.

**ETA**: 2-3 hours

**Status**: ✅ COMPLETE (2026-01-03)

### Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1.1 | Create `src/lib/delivered-pricing.ts` | ✅ | Core pricing engine (renamed from competitive-pricing) |
| 1.2 | Implement `getDeliveredPricing()` | ✅ | Uses Google Shopping adapter |
| 1.3 | Calculate `targetDeliveredCents` | ✅ | From activeFloorDelivered |
| 1.4 | Split into item + shipping | ✅ | `itemCents = delivered - 600` |
| 1.5 | Add min item price guardrail | ✅ | `max(itemCents, 499)` = $4.99 floor |
| 1.6 | Create evidence log structure | ✅ | `DeliveredPricingDecision` with full audit trail |
| 1.7 | Wire into draft creation pipeline | ✅ | Feature flag: `DELIVERED_PRICING_V2=true` |
| 1.8 | Unit tests | ✅ | 26 tests passing in `tests/lib/delivered-pricing.test.ts` |

### Completion Notes (2026-01-03)

**Files Created:**
- `src/lib/delivered-pricing.ts` - Core pricing engine with all helper functions
- `tests/lib/delivered-pricing.test.ts` - 26 unit tests covering all edge cases

**Files Modified:**
- `netlify/functions/smartdrafts-create-drafts.ts` - Wired in with feature flag

**Feature Flag:**
```bash
# Enable delivered-price-first pricing
DELIVERED_PRICING_V2=true
```

**Key Decisions:**
1. Named file `delivered-pricing.ts` to avoid collision with existing `competitive-pricing.ts` (old Amazon HTML approach)
2. Default shipping estimate: $6.00 (configurable)
3. Default min item price: $4.99 (configurable)
4. Fallback: 60% of retail when no eBay comps found
5. Free shipping subsidy cap: $5.00 (configurable)

### Data Structures

```typescript
// Input from Google Shopping
interface CompetitorPrice {
  source: 'amazon' | 'walmart' | 'ebay' | 'target' | 'other';
  itemCents: number;
  shipCents: number;        // 0 if free shipping
  deliveredCents: number;   // item + ship
  title: string;
  url: string;
  inStock: boolean;
}

// Pricing decision output
interface PricingDecision {
  // Inputs
  brand: string;
  productName: string;
  comps: CompetitorPrice[];
  
  // Calculated
  activeFloorDeliveredCents: number;   // lowest eBay comp delivered
  activeMedianDeliveredCents: number;  // median eBay comp delivered
  amazonPriceCents: number | null;
  
  // Decision
  mode: 'market-match' | 'fast-sale' | 'max-margin';
  targetDeliveredCents: number;
  
  // Output
  finalItemCents: number;
  finalShipCents: number;
  freeShipApplied: boolean;
  subsidyCents: number;
  
  // Warnings
  warnings: string[];
  matchConfidence: 'high' | 'medium' | 'low';
  fallbackUsed: boolean;
}

// Evidence log (stored in Redis)
interface PricingLog {
  jobId: string;
  groupId: string;
  timestamp: string;
  decision: PricingDecision;
}
```

### Unit Tests (Phase 1)

```typescript
// tests/lib/competitive-pricing.test.ts

describe('competitive-pricing', () => {
  describe('getCompetitivePricing', () => {
    it('calculates item price from delivered minus shipping', () => {
      // eBay comp: $19.95 delivered (free ship)
      // Our shipping: $6.00
      // Expected item: $13.95
      const result = calculateItemPrice({
        targetDeliveredCents: 1995,
        shippingEstimateCents: 600,
        minItemCents: 499
      });
      expect(result.itemCents).toBe(1395);
    });

    it('floors item price at minimum', () => {
      // eBay comp: $8.00 delivered
      // Our shipping: $6.00
      // Naive item: $2.00 (below floor)
      // Expected: $4.99 (floor) + warning
      const result = calculateItemPrice({
        targetDeliveredCents: 800,
        shippingEstimateCents: 600,
        minItemCents: 499
      });
      expect(result.itemCents).toBe(499);
      expect(result.warnings).toContain('minItemFloorHit');
    });

    it('picks lowest eBay comp as activeFloor', () => {
      const comps: CompetitorPrice[] = [
        { source: 'ebay', deliveredCents: 2195, ... },
        { source: 'ebay', deliveredCents: 1995, ... },
        { source: 'ebay', deliveredCents: 2495, ... },
      ];
      const floor = getActiveFloorDelivered(comps);
      expect(floor).toBe(1995);
    });

    it('falls back to Amazon when no eBay comps', () => {
      const comps: CompetitorPrice[] = [
        { source: 'amazon', deliveredCents: 2995, ... },
        { source: 'walmart', deliveredCents: 2795, ... },
      ];
      const result = getCompetitivePricing(comps, { mode: 'market-match' });
      expect(result.fallbackUsed).toBe(true);
      expect(result.targetDeliveredCents).toBe(2795); // Walmart lower
    });

    it('applies fast-sale undercut', () => {
      const result = getCompetitivePricing(comps, {
        mode: 'fast-sale',
        undercutCents: 100  // $1.00 undercut
      });
      expect(result.targetDeliveredCents).toBe(1895); // 1995 - 100
    });
  });
});
```

### Completion Notes

_To be filled in as tasks complete_

---

## Phase 2: eBay Comp Quality (Proper Data)

**Goal**: Use eBay Browse API for accurate active comps with match confidence scoring.

**ETA**: 3-4 days

**Dependency**: Phase 1 complete

**Status**: ✅ COMPLETE (Jan 2025)

### Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 2.1 | Add eBay Browse API search endpoint | ✅ | `src/lib/ebay-browse-search.ts` |
| 2.2 | Implement `searchEbayComps()` | ✅ | Returns active listings with match scores |
| 2.3 | Normalize eBay comps to delivered price | ✅ | `itemPriceCents + shippingCents` |
| 2.4 | Implement match confidence scoring | ✅ | `scoreMatch()` with Jaccard similarity |
| 2.5 | Extract size/variant from titles | ✅ | `extractSize()` with normalization |
| 2.6 | Detect bundle/lot mismatches | ✅ | `detectBundle()` patterns |
| 2.7 | Condition matching (NEW/USED) | ✅ | `conditionMatch` in scoring |
| 2.8 | Cache eBay comps (24hr TTL) | ⬜ | Deferred - not critical for launch |
| 2.9 | Fall back to Google Shopping when weak | ✅ | Integrated in `delivered-pricing.ts` |
| 2.10 | Unit tests | ✅ | 25 tests in `ebay-browse-search.test.ts` |

### Match Confidence Scoring

```typescript
interface MatchScore {
  brandMatch: boolean;           // Exact brand token match
  productTokenOverlap: number;   // 0-1 Jaccard similarity
  sizeMatch: boolean | null;     // null = couldn't extract
  conditionMatch: boolean;
  bundleDetected: boolean;
  
  overall: 'high' | 'medium' | 'low';
  usable: boolean;               // Above threshold?
}

// Scoring rules:
// HIGH: brandMatch + productOverlap >= 0.6 + conditionMatch + !bundleDetected
// MEDIUM: brandMatch + productOverlap >= 0.4 + conditionMatch
// LOW: anything else

// Threshold for using comp:
// - HIGH or MEDIUM with sizeMatch = usable
// - LOW = fall back to MSRP
```

### Unit Tests (Phase 2)

```typescript
describe('match-confidence', () => {
  it('scores HIGH for exact match', () => {
    const score = scoreMatch(
      { brand: 'Neuro', product: 'Vita Mints D3 K2 90ct' },
      { title: 'Neuro Vita+Mints D3 & K2 90 Pieces New Sealed' }
    );
    expect(score.overall).toBe('high');
    expect(score.usable).toBe(true);
  });

  it('scores LOW for bundle mismatch', () => {
    const score = scoreMatch(
      { brand: 'Neuro', product: 'Vita Mints D3 K2 90ct' },
      { title: 'Lot of 3 Neuro Vita Mints D3 K2 90ct' }
    );
    expect(score.bundleDetected).toBe(true);
    expect(score.usable).toBe(false);
  });

  it('scores LOW for size mismatch', () => {
    const score = scoreMatch(
      { brand: 'Neuro', product: 'Vita Mints D3 K2 90ct' },
      { title: 'Neuro Vita Mints D3 K2 30ct Travel Size' }
    );
    expect(score.sizeMatch).toBe(false);
    expect(score.usable).toBe(false);
  });

  it('detects "pack of" bundles', () => {
    expect(detectBundle('Pack of 2 Neuro Mints')).toBe(true);
    expect(detectBundle('2-Pack Neuro Mints')).toBe(true);
    expect(detectBundle('Neuro Mints Single')).toBe(false);
  });
});
```

### Completion Notes

**Completed Jan 2025:**

1. Created `src/lib/ebay-browse-search.ts` with:
   - `searchEbayComps()` - queries eBay Browse API for active listings
   - `scoreMatch()` - Jaccard similarity + brand/size/bundle detection
   - `extractSize()` - extracts and normalizes sizes (90ct, 3.3oz, etc)
   - `detectBundle()` - catches "lot of", "pack of", "multipack" patterns
   - `getEbayCompPricing()` - convenience function for floor/median

2. Integrated into `delivered-pricing.ts`:
   - eBay Browse API is tried first (accurate, direct API)
   - Falls back to Google Shopping eBay results if Browse API fails
   - New `compsSource: 'ebay-browse' | 'google-shopping'` tracking

3. Tests: 25 unit tests in `tests/lib/ebay-browse-search.test.ts`

4. Match scoring thresholds:
   - HIGH: brand + 50%+ token overlap + condition + no bundle
   - MEDIUM: brand + 35%+ token overlap + condition
   - Size mismatches and bundles marked unusable

---

## Phase 3: Sold Comps (Market Truth)

**Goal**: Add eBay sold items lookup for "what market actually paid" pricing.

**ETA**: 2-3 days

**Dependency**: Phase 2 complete

**Status**: ✅ COMPLETE (Jan 2025)

### Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 3.1 | eBay Browse API sold items filter | ✅ | Uses SearchAPI.io `LH_Sold:1` |
| 3.2 | Implement `getSoldComps()` | ✅ | `fetchSoldPriceStats()` in `ebay-sold-prices.ts` |
| 3.3 | Calculate soldMedianDelivered | ✅ | Adds $6 shipping to sold item price |
| 3.4 | Calculate soldCount | ✅ | Track sample count for confidence |
| 3.5 | Update Market Match: `min(soldMedian, activeFloor)` | ✅ | Only when soldStrong (>=5 samples) |
| 3.6 | Cache sold comps (7 day TTL) | ⬜ | Deferred - not critical |
| 3.7 | Add soldComps to evidence log | ✅ | `soldMedianDeliveredCents`, `soldCount`, `soldStrong` |
| 3.8 | Unit tests | ✅ | 3 new tests in `delivered-pricing.test.ts` |

### Pricing Mode Logic (Updated)

```typescript
function calculateTargetDelivered(
  mode: 'market-match' | 'fast-sale' | 'max-margin',
  activeFloor: number,
  activeMedian: number,
  soldMedian: number | null,
  soldCount: number,
  undercutCents: number = 100
): number {
  const soldStrong = soldMedian !== null && soldCount >= 5;

  switch (mode) {
    case 'market-match':
      if (soldStrong) {
        return Math.min(soldMedian, activeFloor);
      }
      return activeFloor;

    case 'fast-sale':
      return Math.max(activeFloor - undercutCents, 499); // floor at $4.99

    case 'max-margin':
      if (soldStrong) {
        return Math.min(activeMedian, soldMedian);
      }
      return activeMedian;
  }
}
```

### Unit Tests (Phase 3)

```typescript
describe('sold-comps-pricing', () => {
  it('Market Match uses min(soldMedian, activeFloor) when sold strong', () => {
    const target = calculateTargetDelivered('market-match', 
      1995,  // activeFloor
      2495,  // activeMedian
      1895,  // soldMedian (lower!)
      12     // soldCount (strong)
    );
    expect(target).toBe(1895); // sold median wins
  });

  it('Market Match uses activeFloor when sold weak', () => {
    const target = calculateTargetDelivered('market-match',
      1995,  // activeFloor
      2495,  // activeMedian
      1795,  // soldMedian
      3      // soldCount (weak, < 5)
    );
    expect(target).toBe(1995); // falls back to activeFloor
  });

  it('Fast Sale undercuts activeFloor', () => {
    const target = calculateTargetDelivered('fast-sale',
      1995, 2495, null, 0, 150
    );
    expect(target).toBe(1845); // 1995 - 150
  });

  it('Max Margin picks higher of activeMedian/soldMedian', () => {
    const target = calculateTargetDelivered('max-margin',
      1995, 2495, 2295, 10
    );
    expect(target).toBe(2295); // min(2495, 2295)
  });
});
```

### Completion Notes

**Completed Jan 2025:**

1. Integrated `fetchSoldPriceStats()` from `src/lib/pricing/ebay-sold-prices.ts`:
   - Uses SearchAPI.io with `ebay_tbs: 'LH_Complete:1,LH_Sold:1'`
   - Returns median, p10, p35, p90 percentiles
   - Rate limited to 1 call/second

2. Updated `calculateTargetDelivered()` in `delivered-pricing.ts`:
   - New parameters: `soldMedian`, `soldCount`
   - `soldStrong = soldCount >= 5`
   - Market-match: `min(soldMedian, activeFloor)` when strong
   - Max-margin: `min(activeMedian, soldMedian)` when strong

3. Updated `DeliveredPricingDecision` interface:
   - Added `soldMedianDeliveredCents`, `soldCount`, `soldStrong`
   - Added shipping estimate ($6) to sold item prices

4. Tests: 3 new tests for sold comps integration (29 total)

5. Live validation shows:
   - Neuro Mints: 64 sold samples, median $22.99 item → $28.99 delivered
   - activeFloor ($18.99) < soldMedian → uses activeFloor ✓

---

## Phase 4: User Controls & Shipping

**Goal**: Add user-selectable pricing modes, free shipping toggle, and smarter shipping estimates.

**ETA**: 2 days

**Dependency**: Phase 3 complete (but can start shipping table in parallel)

**Status**: ✅ COMPLETE (Jan 2025)

### Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 4.1 | Add pricing mode to user settings | ✅ | Already in `DeliveredPricingSettings` |
| 4.2 | Add free shipping toggle | ✅ | `allowFreeShipping: boolean` |
| 4.3 | Add max shipping subsidy cap | ✅ | `maxSubsidyCents: 500` |
| 4.4 | Implement free shipping logic | ✅ | `splitDeliveredPrice()` |
| 4.5 | Category shipping estimate table | ✅ | `src/lib/shipping-estimates.ts` |
| 4.6 | Comp-based shipping hint | ✅ | `analyzeCompShipping()` |
| 4.7 | Add min item price setting | ✅ | `minItemCents: 499` |
| 4.8 | Add undercut amount setting | ✅ | `undercutCents: 100` |
| 4.9 | UI: Pricing settings panel | ⬜ | Deferred - settings via API |
| 4.10 | Unit tests | ✅ | 17 tests in `shipping-estimates.test.ts` |

### Category Shipping Table

```typescript
const SHIPPING_ESTIMATES: Record<string, number> = {
  'beauty':       450,  // $4.50 - skincare, supplements, small items
  'cosmetics':    450,  // $4.50 - makeup, small beauty
  'supplements':  500,  // $5.00 - vitamins, mints, pills
  'clothing':     550,  // $5.50 - shirts, light apparel
  'shoes':        850,  // $8.50 - heavier, larger boxes
  'bags':         750,  // $7.50 - purses, backpacks
  'electronics':  650,  // $6.50 - varies widely
  'books':        400,  // $4.00 - media mail eligible
  'default':      600,  // $6.00 - fallback
};

function getShippingEstimate(
  category: string,
  comps: CompetitorPrice[],
  settings: { source: 'default' | 'category' | 'comps' }
): { cents: number; source: string } {
  
  if (settings.source === 'comps' && comps.length >= 3) {
    const compShips = comps.map(c => c.shipCents);
    const median = getMedian(compShips);
    return { cents: median, source: 'comp-median' };
  }
  
  if (settings.source === 'category') {
    const estimate = SHIPPING_ESTIMATES[category] ?? SHIPPING_ESTIMATES.default;
    return { cents: estimate, source: `category:${category}` };
  }
  
  return { cents: 600, source: 'default' };
}
```

### Free Shipping Logic

```typescript
function applyFreeShipping(
  targetDeliveredCents: number,
  shippingEstimateCents: number,
  settings: {
    allowFreeShipping: boolean;
    maxSubsidyCents: number;
    minItemCents: number;
  }
): { itemCents: number; shipCents: number; subsidyCents: number; applied: boolean } {
  
  const naiveItem = targetDeliveredCents - shippingEstimateCents;
  
  // If we can't compete even with free shipping, don't bother
  if (targetDeliveredCents < settings.minItemCents) {
    return {
      itemCents: settings.minItemCents,
      shipCents: shippingEstimateCents,
      subsidyCents: 0,
      applied: false
    };
  }
  
  // Normal case: charge shipping
  if (!settings.allowFreeShipping) {
    return {
      itemCents: Math.max(naiveItem, settings.minItemCents),
      shipCents: shippingEstimateCents,
      subsidyCents: 0,
      applied: false
    };
  }
  
  // Free shipping requested: can we absorb it?
  const subsidy = shippingEstimateCents;
  if (subsidy <= settings.maxSubsidyCents) {
    return {
      itemCents: targetDeliveredCents,  // Full delivered as item price
      shipCents: 0,
      subsidyCents: subsidy,
      applied: true
    };
  }
  
  // Can't fully absorb, partial subsidy up to cap
  const partialSubsidy = settings.maxSubsidyCents;
  return {
    itemCents: targetDeliveredCents - (shippingEstimateCents - partialSubsidy),
    shipCents: shippingEstimateCents - partialSubsidy,
    subsidyCents: partialSubsidy,
    applied: false  // Partial, not full free ship
  };
}
```

### Unit Tests (Phase 4)

```typescript
describe('free-shipping', () => {
  it('applies free shipping when toggle on and within cap', () => {
    const result = applyFreeShipping(1995, 600, {
      allowFreeShipping: true,
      maxSubsidyCents: 600,
      minItemCents: 499
    });
    expect(result.itemCents).toBe(1995);
    expect(result.shipCents).toBe(0);
    expect(result.subsidyCents).toBe(600);
    expect(result.applied).toBe(true);
  });

  it('does not apply free shipping when toggle off', () => {
    const result = applyFreeShipping(1995, 600, {
      allowFreeShipping: false,
      maxSubsidyCents: 600,
      minItemCents: 499
    });
    expect(result.itemCents).toBe(1395);
    expect(result.shipCents).toBe(600);
    expect(result.applied).toBe(false);
  });

  it('caps subsidy at max', () => {
    const result = applyFreeShipping(1995, 850, {
      allowFreeShipping: true,
      maxSubsidyCents: 500,  // Can only absorb $5, ship is $8.50
      minItemCents: 499
    });
    expect(result.subsidyCents).toBe(500);
    expect(result.shipCents).toBe(350);  // 850 - 500
    expect(result.applied).toBe(false);  // Partial
  });

  it('uses category estimate when configured', () => {
    const result = getShippingEstimate('supplements', [], { source: 'category' });
    expect(result.cents).toBe(500);
    expect(result.source).toBe('category:supplements');
  });

  it('uses comp median when enough comps', () => {
    const comps = [
      { shipCents: 0 },
      { shipCents: 0 },
      { shipCents: 500 },
      { shipCents: 0 },
    ];
    const result = getShippingEstimate('default', comps, { source: 'comps' });
    expect(result.cents).toBe(0);  // Median of [0,0,0,500] = 0
    expect(result.source).toBe('comp-median');
  });
});
```

### Completion Notes

**Completed Jan 2025:**

1. Created `src/lib/shipping-estimates.ts` with:
   - `CATEGORY_SHIPPING` table: 20+ categories with USPS/UPS estimates
   - `detectCategory()` - keyword-based category detection from product title
   - `analyzeCompShipping()` - extracts median, mode, free-ship percentage from comps
   - `getShippingEstimate()` - smart shipping with fallback chain: comps → category → default
   - `estimateShipping()` - convenience function returning cents only

2. Updated `DeliveredPricingSettings` interface:
   - Added `useSmartShipping: boolean` (default: true)
   - Added `shippingSettings?: ShippingSettings` for category/comps tuning
   - All user control settings already existed (4.1-4.4, 4.7-4.8)

3. Integrated smart shipping into `getDeliveredPricing()`:
   - When `useSmartShipping: true`, calls `getShippingEstimate()` 
   - Falls back to fixed `shippingEstimateCents` when disabled
   - New output field: `shippingEstimateSource: 'default' | 'category' | 'comps' | 'fixed'`

4. Category shipping rates (in cents):
   - Beauty/Skincare: 450 (lightweight)
   - Supplements/Vitamins: 500
   - Shoes: 850 (large boxes)
   - Books: 400 (media mail)
   - Default: 600

5. Comp-based shipping logic:
   - Needs 3+ comps to activate
   - If 70%+ offer free shipping → lower estimate to $4.00
   - Otherwise uses median of comp shipping values

6. Tests: 17 unit tests in `tests/lib/shipping-estimates.test.ts`
   - Category detection (6 tests)
   - Comp analysis (4 tests) 
   - Smart estimate selection (4 tests)
   - Convenience function (2 tests)
   - Min/max bounds (1 test)

---

## Phase 5: Integration & Rollout

**Goal**: Wire everything together, add integration tests, deploy safely.

**ETA**: 1-2 days

**Dependency**: Phases 1-4 complete

### Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 5.1 | Integration test: full pipeline | ✅ | 16 tests in `tests/integration/pricing-pipeline.test.ts` |
| 5.2 | Add "Reprice" button to existing drafts | ⬜ | Don't auto-update |
| 5.3 | Deploy to sandbox | ⬜ | Test with real eBay sandbox |
| 5.4 | Smoke test with 10 real products | ✅ | `scripts/smoke-pricing.ts` |
| 5.5 | Deploy to production | ⬜ | Default: market-match |
| 5.6 | Monitor evidence logs | ⬜ | Check for warnings |
| 5.7 | Document API changes | ✅ | See below |

### Integration Test

```typescript
describe('pricing-pipeline-integration', () => {
  it('prices product competitively end-to-end', async () => {
    // Seed: Neuro Vita Mints
    const product = {
      brand: 'Neuro',
      productName: 'Vita+Mints D3 K2 90 Pieces',
      images: ['test-image.jpg']
    };
    
    // Mock comps
    const mockComps = [
      { source: 'ebay', deliveredCents: 1995, shipCents: 0 },
      { source: 'ebay', deliveredCents: 2195, shipCents: 599 },
      { source: 'amazon', deliveredCents: 2995, shipCents: 0 },
    ];
    
    // Run pipeline
    const result = await priceDraft(product, { mode: 'market-match' });
    
    // Assert
    expect(result.targetDeliveredCents).toBe(1995);  // eBay floor
    expect(result.finalItemCents + result.finalShipCents).toBeLessThanOrEqual(1995);
    expect(result.warnings).not.toContain('overpriced');
  });
});
```

### Rollout Checklist

- [ ] Default mode = Market Match
- [ ] Existing drafts unchanged (require manual "Reprice")
- [ ] Evidence logs enabled
- [ ] Monitoring dashboard for warnings
- [ ] Rollback plan documented

### Completion Notes

**Completed Jan 2025:**

1. **Integration Tests** (`tests/integration/pricing-pipeline.test.ts`):
   - 16 comprehensive tests covering all pricing modes
   - Tests market-match, fast-sale, max-margin modes
   - Tests item/shipping split, free shipping logic
   - Tests smart shipping integration
   - Tests fallback behavior when no comps
   - End-to-end scenarios for Neuro Mints and Olaplex

2. **Smoke Test Script** (`scripts/smoke-pricing.ts`):
   - Tests 10 real beauty/health products
   - Uses live API calls (SearchAPI.io, eBay Browse)
   - Validates pricing competitiveness
   - Run with: `npx tsx scripts/smoke-pricing.ts`

3. **Smoke Test Results** (Jan 2025):
   - **5/10 passed**: Higher-priced items work well
   - **5/10 failed**: Low-price items hit `minItemFloorHit`
   
   Working well ($15+ products):
   - Neuro Mints: $20.63 target → $15.63 + $5.00 ✓
   - Olaplex: $14.00 target → $9.00 + $5.00 ✓
   - CeraVe: $19.99 target → $15.49 + $4.50 ✓
   - L'Oreal: $21.69 target → $16.69 + $5.00 ✓
   
   Cannot compete (under $10 delivered):
   - e.l.f. Primer: $4.89 floor (free ship sellers)
   - NYX Butter Gloss: $7.00 floor
   - Maybelline Mascara: $7.99 floor
   - Neutrogena Gel: $9.20 floor
   - Garnier Micellar: $6.00 floor

4. **Key Insight**: Low-price items require either:
   - Enable `allowFreeShipping: true` to absorb shipping
   - Lower `minItemCents` below $4.99
   - Flag as "cannot compete" and skip

5. **API Changes**:
   - `getDeliveredPricing()` now returns `shippingEstimateSource` field
   - New `useSmartShipping` setting (default: true)
   - New `shippingSettings` option for category/comps tuning

---

## Appendix A: Evidence Log Schema

Every pricing decision writes a log entry to Redis:

```typescript
// Key: pricinglog:{userId}:{jobId}:{groupId}
// TTL: 30 days

interface PricingLogEntry {
  version: '1.0';
  timestamp: string;  // ISO 8601
  
  // Identification
  userId: string;
  jobId: string;
  groupId: string;
  brand: string;
  productName: string;
  
  // Inputs
  inputs: {
    mode: 'market-match' | 'fast-sale' | 'max-margin';
    compsCount: number;
    compsSource: 'ebay-api' | 'google-shopping' | 'fallback';
    
    activeFloorDeliveredCents: number | null;
    activeMedianDeliveredCents: number | null;
    soldMedianDeliveredCents: number | null;
    soldCount: number;
    
    shippingEstimateCents: number;
    shippingEstimateSource: string;
    
    amazonPriceCents: number | null;
    walmartPriceCents: number | null;
  };
  
  // Decision
  decision: {
    targetDeliveredCents: number;
    finalItemCents: number;
    finalShipCents: number;
    freeShipApplied: boolean;
    subsidyCents: number;
  };
  
  // Quality
  quality: {
    matchConfidence: 'high' | 'medium' | 'low';
    fallbackUsed: boolean;
    warnings: string[];
  };
}
```

---

## Appendix B: Warning Codes

| Code | Meaning | Action |
|------|---------|--------|
| `minItemFloorHit` | Item price floored at minimum | Review shipping or enable free ship |
| `noEbayComps` | No eBay comps found | Used Amazon/Walmart fallback |
| `lowMatchConfidence` | Comp titles don't match well | Manual review recommended |
| `bundleMismatch` | Comp appears to be bundle/lot | Excluded from pricing |
| `sizeMismatch` | Comp size differs (30ct vs 90ct) | Excluded from pricing |
| `soldCompsWeak` | < 5 sold comps in 90 days | Using active comps only |
| `cannotCompete` | Even free ship exceeds market | Consider not listing |
| `staleComps` | Comps older than 24 hours | Refresh recommended |

---

## Appendix C: API Cost Tracking

| API | Cost | Rate Limit | Cache TTL |
|-----|------|------------|-----------|
| Google Shopping (SearchAPI) | $0.004/search | 100/min | 24 hours |
| eBay Browse API | Free | 5000/day | 24 hours (active), 7 days (sold) |
| OpenAI GPT-4o-mini | ~$0.003/product | N/A | N/A |

**Estimated cost per product**: $0.007 (vision + shopping search)

---

## Changelog

| Date | Phase | Change | Author |
|------|-------|--------|--------|
| 2026-01-03 | Setup | Created pricing overhaul document | Copilot |

