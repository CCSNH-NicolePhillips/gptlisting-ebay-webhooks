# Pricing V2 Pipeline — Full Analysis & Fix Plan

## Table of Contents
1. [Pipeline Overview](#pipeline-overview)
2. [V1 vs V2 Comparison](#v1-vs-v2-comparison)
3. [Root Cause Analysis](#root-cause-analysis)
4. [Product Test Matrix (8 Products)](#product-test-matrix)
5. [Detailed Pipeline Walkthrough per Product](#detailed-pipeline-walkthrough)
6. [The Fix: Graduated Tiers](#the-fix-graduated-tiers)
7. [Implementation Plan](#implementation-plan)

---

## Pipeline Overview

### Entry Point
`getDeliveredPricing(brand, productName, settings, additionalContext)`
in `src/lib/delivered-pricing.ts`

When `DP_PRICING_V2=true`, dispatches to `getDeliveredPricingV2()`.

### V2 Pipeline Steps (10 stages)

```
Step 1: Fetch comps from all sources
  ├── 1a. Google Shopping → eBay comps + retail comps
  ├── 1b. eBay Browse API (if DP_EBAY_BROWSE_ACTIVE=true) → active comps
  └── 1c. Sold comps (eBay Sold API via SearchAPI)

Step 2: Identity-based comp filtering (if DP_IDENTITY_FILTER=true)
  ├── buildIdentity({ brand, productName }) → CanonicalIdentity
  ├── matchComps(identity, candidates) → match/ambiguous/reject
  └── Filter to only matching comps

Step 3: Compute robust stats (IQR outlier removal)
  ├── computeRobustStats(activeCompSamples) → activeStats
  └── computeRobustStats(soldSamples) → soldStats

Step 4: Retail anchors
  ├── Google Shopping → Amazon / Walmart / Target / Brand Site
  ├── Direct Amazon API + Direct Walmart API (cross-validated)
  ├── Brave Amazon fallback (if no retail found)
  └── Variant detection (exclude prices <50% of anchor)

Step 5: V2 target selection ← THIS IS WHERE THE BUG IS
  ├── if soldStrong (≥10 cleaned): base = SoldP35
  ├── elif activeStrong (≥12 cleaned): base = ActiveP20
  ├── elif retail exists: base = retail × 0.70
  └── else: MANUAL_REVIEW ($0)

Step 6: Safety floor (if DP_SAFETY_FLOOR=true)
  └── enforceSafetyFloor() → min net payout guarantee

Step 7: Smart shipping
  └── getShippingEstimate() → category/comp/size-heuristic

Step 8: Split into item + shipping
  └── splitDeliveredPrice() → itemCents + shipCents

Step 9: Confidence scoring (if DP_CONFIDENCE_SCORING=true)
  └── computeConfidence() → 0-100 score + review triggers

Step 10: Return DeliveredPricingDecision
```

---

## V1 vs V2 Comparison

| Aspect | V1 (`calculateTargetDelivered`) | V2 (`calculateTargetDeliveredV2`) |
|--------|------|------|
| Sold threshold | ≥5 raw samples | ≥10 IQR-cleaned samples |
| Active threshold | Any eBay comps | ≥12 IQR-cleaned samples |
| Sold anchor | Raw median | P35 (35th percentile) |
| Active anchor | Floor (min) | P20 (20th percentile) |
| Outlier removal | None | IQR + too-good-to-be-true |
| Retail fallback | 60% (Amazon/Walmart) or 80% (brand) | 70% of lowest trusted retail |
| No data fallback | $0 (noPricingData) | $0 (manualReviewRequired) |
| Retail cap | 80% of lowest trusted | 80% of lowest trusted |
| Retail floor | 65% of trusted (soldStrong only) | N/A |
| Variant detection | Brand site cross-check | Brand site + soldP50 cross-check |

### Key Difference: V1 trusts smaller datasets

V1 considers 5 raw sold samples as "strong" and uses the raw median.
V2 requires 10 samples *after* IQR outlier removal — which typically
strips 20-40% of a dataset, meaning you need 13-17 raw samples to qualify.

For niche health supplements with 7-9 sold listings in 90 days, V2 almost
always falls through to the retail×0.70 path, which produces ruinous pricing.

---

## Root Cause Analysis

### The Failure Chain (MaryRuth's example)

```
Raw sold data: 8 samples → $24, $26, $29, $32, $35, $38, $42, $55

Step 1: IQR Calculation
  Q1 (P25) = $28, Q3 (P75) = $40
  IQR = $40 - $28 = $12
  Lower fence = $28 - 1.5×$12 = $10
  Upper fence = $40 + 1.5×$12 = $58
  After IQR: all 8 pass (all within $10-$58)

Step 2: Too-Good-To-Be-True filter
  P35 of remaining 8 = ~$29
  Threshold = 0.70 × $29 = $20.30
  After TGTB: still 8 (all ≥ $20.30)

Step 3: soldStrong check
  cleaned count = 8 → isSoldStrong(8) = 8 ≥ 10? NO ❌
  
Step 4: Fallback
  No soldStrong → check activeStrong → also fails (only 6 active)
  → retail × 0.70 = $15.99 × 0.70 = $11.19

  THE $15.99 RETAIL IS FROM A WRONG VARIANT (single serving packet)
  but variant detection missed it because no brand site anchor existed.

RESULT: $11.09 listing price for a product that sells for $29-38 on eBay ❌
```

### Why V1 gets it right

```
Same data: 8 raw sold samples, median = $33.50

V1: soldCount ≥ 5? YES → soldStrong = true
V1: market-match mode → targetCents = min(soldMedian, activeFloor)
    = min($33.50, $29.95) = $29.95
    + retail cap (80% of Amazon $38.97 = $31.18) → $29.95 ✓
    + retail floor (65% of $38.97 = $25.33) → $29.95 ✓

RESULT: $29.95 listing price ✓
```

---

## Product Test Matrix

### 8 Products covering different scenarios:

| # | Brand | Product | Amazon | eBay Range | Expected | Scenario |
|---|-------|---------|--------|------------|----------|----------|
| 1 | MaryRuth Organics | Womens Multivitamin Hair Growth Liposomal | ~$38.97 | $25-$42 | $25-$35 | **KNOWN FAILURE** — niche supplement, <10 sold comps |
| 2 | Panda's Promise | Batana Oil Shampoo & Conditioner Set | $23.90 | TBD | $18-$22 | New/niche brand, possibly minimal eBay history |
| 3 | Milamend | Hormone Balance Mixed Berry Powder | $77.00 | TBD | $55-$70 | High-price supplement, likely very few comps |
| 4 | Global Healing | Lithium Orotate 10mg Capsules | $19.96 | TBD | $15-$19 | Mid-range supplement, likely some comps |
| 5 | Pump Sauce | Shooters Watermelon Margarita Liquid Supplement | $37.99 | TBD | $28-$35 | Niche brand, likely <5 comps |
| 6 | Peach & Lily | Glass Skin Discovery Kit | $39.00 | TBD | $30-$36 | K-beauty, moderate eBay presence |
| 7 | HumanN | SuperBeets Heart Chews Pomegranate Berry | $39.95 | TBD | $30-$37 | Established supplement brand |
| 8 | BioDance | Bio Collagen Real Deep Mask | $19.00 | TBD | $14-$18 | K-beauty mask, good eBay presence |

### Additional products from prior bugs:
| # | Brand | Product | Expected | Scenario |
|---|-------|---------|----------|----------|
| 9 | r.e.m. beauty | Wicked Luxury Beautification Undereye Masks | $22-$28 | Brand site $30, limited edition |

---

## Detailed Pipeline Walkthrough

### Product 1: MaryRuth Organics — Womens Multivitamin (KNOWN FAILURE)

**Data Sources:**
- Amazon: ~$38.97
- eBay Sold (90d): ~8 samples, range $24-$55, median ~$33

**V2 Current (BROKEN):**
```
Step 3: computeRobustStats(8 sold samples)
  → IQR removes 0-1 outliers → 7-8 cleaned
  → isSoldStrong(7) = 7 ≥ 10? NO
  
Step 3: computeRobustStats(~6 active)
  → isActiveStrong(~5) = 5 ≥ 12? NO

Step 5: Falls to retail × 0.70
  → lowestRetail ($15.99 from wrong variant) × 0.70 = $11.19
  → OR if retail properly validated: $38.97 × 0.70 = $27.28

Step 6: Safety floor: $11.19 → ~$11.09 (after split)

RESULT: $11.09 ❌ (should be $25-$35)
```

**V2 Fixed (with graduated tiers):**
```
Step 3: computeRobustStats(8 sold samples)
  → IQR keeps 7-8 → isSoldStrong(7) = 7 ≥ 5? YES ✅

Step 5: soldStrong → base = SoldP35 
  → sorted cleaned: $24, $26, $29, $32, $35, $38, $42
  → P35 = $29 (aggressive but safe — 35th percentile)

Caps:
  → Retail cap: 80% of $38.97 = $31.18 → $29 passes ✅
  → Active cap: P65 → ~$38 → $29 passes ✅

RESULT: $29.00 ✅ (competitive, profitable)
```

---

### Product 2: Panda's Promise — Batana Oil Shampoo & Conditioner Set

**Expected scenario:** Very new/niche brand. Likely <3 eBay sold comps.

**V2 Current (BROKEN):**
```
Sold: 0-2 samples → computeRobustStats → count 0-2
  → isSoldStrong? NO
Active: 0-3 → isActiveStrong? NO
Retail: Amazon $23.90

→ Falls to retail × 0.70 = $23.90 × 0.70 = $16.73
→ Target: $16.73 (reasonable for this specific case!)
```

**V2 Fixed:** Same behavior (too few comps for any tier), but this is actually
a correct outcome — with <3 comps we should use retail anchor.

Target ~$16.73 = 70% of Amazon. Reasonable for a new product.

---

### Product 3: Milamend — Hormone Balance ($77 on Amazon)

**Expected scenario:** High-price niche supplement. Few eBay sellers.

**V2 Current (BROKEN):**
```
Sold: 0-3 samples → soldStrong? NO
Active: 0-5 → activeStrong? NO
Retail: Amazon $77.00

→ Falls to retail × 0.70 = $77.00 × 0.70 = $53.90
→ This is actually reasonable for a $77 product!
```

**V2 Fixed:** If any sold comps exist (3-4), the Weak tier kicks in:
```
Sold: 3 samples (e.g., $55, $60, $65) → isSoldWeak? YES
→ base = SoldP50 = $60
→ Retail cap: 80% of $77 = $61.60 → $60 passes ✅

RESULT: $60.00 ✅ (better than $53.90, uses real market data)
```

---

### Product 4: Global Healing — Lithium Orotate ($19.96 on Amazon)

**Expected scenario:** Established brand, moderate eBay presence.

**V2 Current:**
```
Sold: ~6-8 samples (range $14-$22) → after IQR: ~6
  → isSoldStrong(6) = 6 ≥ 10? NO ❌

→ Falls to retail × 0.70 = $19.96 × 0.70 = $13.97

RESULT: $13.97 ❌ (should be $15-$18 based on sold comps)
```

**V2 Fixed:**
```
Sold: 6 cleaned → isSoldStrong(6) = 6 ≥ 5? YES ✅
→ base = SoldP35 ≈ $16
→ Retail cap: 80% of $19.96 = $15.97 → caps at $15.97

RESULT: $15.97 ✅
```

---

### Product 5: Pump Sauce — Shooters Watermelon ($37.99 on Amazon)

**Expected scenario:** Very niche. Likely 0-2 sold comps.

**V2 Current and Fixed (same behavior):**
```
Sold: 0-1 → no tier qualifies
→ retail × 0.70 = $37.99 × 0.70 = $26.59

RESULT: $26.59 (reasonable for ultra-niche)
```

This is actually fine — with no eBay data, 70% of retail is a safe entry point.

---

### Product 6: Peach & Lily — Glass Skin Kit ($39 on Amazon)

**Expected scenario:** Popular K-beauty brand, moderate eBay presence.

**V2 Current (likely broken):**
```
Sold: ~5-8 → after IQR: ~5-7 → isSoldStrong? NO (< 10)
Active: ~6-10 → after IQR: ~5-8 → isActiveStrong? NO (< 12)
→ Falls to retail × 0.70 = $39 × 0.70 = $27.30

RESULT: $27.30 ❌ (might be too low if eBay median is $33-36)
```

**V2 Fixed:**
```
Sold: 6 cleaned → isSoldStrong(6) ≥ 5? YES ✅
→ base = SoldP35 ≈ $31
→ Retail cap: 80% of $39 = $31.20 → passes or caps

RESULT: $31.00 ✅
```

---

### Product 7: HumanN — SuperBeets Heart Chews ($39.95 on Amazon)

**Expected scenario:** Well-known brand, good eBay presence, possibly 10+ sold.

**V2 Current (may work for this product):**
```
Sold: ~10-15 → after IQR: ~10 → isSoldStrong(10)? YES ✅
→ base = SoldP35 ≈ $30-33
→ Retail cap: 80% of $39.95 = $31.96

RESULT: $30-32 ✅ (V2 works when it has enough data)
```

**V2 Fixed:** Same result — threshold change doesn't affect products with plenty of data.

---

### Product 8: BioDance — Bio Collagen Mask ($19 on Amazon)

**Expected scenario:** Very popular K-beauty, lots of eBay sellers.

**V2 Current (may work):**
```
Sold: ~12-20 → after IQR: ~10-16 → isSoldStrong? likely YES
Active: ~15-30 → after IQR: ~12-25 → isActiveStrong? likely YES
→ base = SoldP35 → should work

RESULT: $14-17 ✅
```

**V2 Fixed:** Same — high-volume products are unaffected.

---

## The Fix: Graduated Tiers

### Current thresholds (BROKEN)

```typescript
export function isSoldStrong(stats: RobustStats, minCount = 10): boolean {
  return stats.count >= minCount;
}

export function isActiveStrong(stats: RobustStats, minCount = 12): boolean {
  return stats.count >= minCount;
}
```

### New thresholds (FIX)

```typescript
// Strong: enough data for aggressive percentile-based pricing
export function isSoldStrong(stats: RobustStats, minCount = 5): boolean {
  return stats.count >= minCount;
}
export function isActiveStrong(stats: RobustStats, minCount = 5): boolean {
  return stats.count >= minCount;
}

// Weak: some data, use conservative percentiles (median)
export function isSoldWeak(stats: RobustStats): boolean {
  return stats.count >= 3 && !isSoldStrong(stats);
}
export function isActiveWeak(stats: RobustStats): boolean {
  return stats.count >= 3 && !isActiveStrong(stats);
}
```

### Updated `calculateTargetDeliveredV2()` fallback chain

```
if soldStrong (≥5 cleaned):
  market-match → SoldP35 (aggressive)
  fast-sale    → min(ActiveP20, SoldP35) - undercut
  max-margin   → min(SoldP50, ActiveP35)

elif soldWeak (3-4 cleaned):
  market-match → SoldP50 (conservative — use median, not P35)
  fast-sale    → SoldP50 - undercut
  max-margin   → SoldP50

elif activeStrong (≥5 cleaned):
  market-match → ActiveP20
  fast-sale    → ActiveP20 - undercut
  max-margin   → ActiveP35

elif activeWeak (3-4 cleaned):
  market-match → ActiveP35 (conservative — not P20)
  fast-sale    → ActiveP35 - undercut
  max-margin   → ActiveP50

elif retail exists:
  → retail × 0.70 (unchanged)

else:
  → $0 (manual review)
```

### Impact Analysis

| Product | V2 Current | V2 Fixed | Change |
|---------|-----------|----------|--------|
| MaryRuth's (8 sold) | $11.09 ❌ | ~$29.00 ✅ | +$17.91 |
| Panda's Promise (0 sold) | $16.73 | $16.73 | No change |
| Milamend (3 sold) | $53.90 | ~$60.00 | +$6.10 (uses market data) |
| Global Healing (6 sold) | $13.97 ❌ | ~$15.97 ✅ | +$2.00 |
| Pump Sauce (0-1 sold) | $26.59 | $26.59 | No change |
| Peach & Lily (6 sold) | $27.30 ❌ | ~$31.00 ✅ | +$3.70 |
| SuperBeets (10+ sold) | ~$31.00 ✅ | ~$31.00 ✅ | No change |
| BioDance (15+ sold) | ~$15.00 ✅ | ~$15.00 ✅ | No change |

**Key insight:** Products with plenty of data (≥10 sold) are unaffected.
Products with moderate data (5-9 sold) go from BROKEN → CORRECT.
Products with minimal data (3-4 sold) get improved (use market data vs retail fallback).

---

## Implementation Plan

### Files to Modify

1. **`src/lib/pricing/robust-stats.ts`**
   - Lower `isSoldStrong` default from 10 → 5
   - Lower `isActiveStrong` default from 12 → 5
   - Add `isSoldWeak()` and `isActiveWeak()` predicates

2. **`src/lib/delivered-pricing.ts`**
   - Update `calculateTargetDeliveredV2()` to handle weak tier
   - Add `soldWeak` and `activeWeak` to return type
   - Add logging for weak tier decisions

3. **`tests/lib/pricing/robust-stats.test.ts`**
   - Update threshold expectations
   - Add tests for weak predicates

4. **`tests/integration/pricing-pipeline.test.ts`**
   - Add V2 test scenarios with mock data
   - Validate graduated tier behavior

### Test Verification

After implementation, run the full test suite:
```
npm test
```

Then verify with real products by calling the pricing endpoint or running
a local test script.
