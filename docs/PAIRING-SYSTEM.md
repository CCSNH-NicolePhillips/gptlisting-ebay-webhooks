# Pairing System - Production Ready ✅

**Last Updated**: November 17, 2025

## Overview

Two-prompt image pairing system with **visual-first matching**, achieving **92%+ pair rates** on real-world data with intelligent auto-pairing and GPT tiebreaker for ambiguous cases.

## Architecture

### Visual-First Matching (November 2025)

**Philosophy**: Match by appearance first (like a 2-year-old would), then validate with text.

**Visual Scoring** (Primary):
- **Packaging match**: +3 points (bottle+bottle, box+box, tube+tube, etc.)
- **Exact color match**: +2.5 points (white+white, navy-blue+navy-blue)
- **Close color match**: +2 points (blue vs light-blue, amber vs dark-amber)
- **Total visual max**: 5.5 points

**Text Scoring** (Secondary):
- Brand exact match: +3 points
- Product Jaccard ≥ 0.5: +2 points
- Variant Jaccard ≥ 0.5: +1 point
- Size canonical equality: +1 point

**Key Features**:
- **Reduced empty brand penalty**: -0.5 (was -3) - visual can compensate
- **Role="other" inclusion**: Captures Vision API mislabeled backs
- **Candidate pool K=8**: Shows top 8 candidates per front (62% of backs)
- **Color normalization**: "light-blue" matches "blue", "dark-amber" matches "amber"

### Phase 1-3: Core Pairing System
- **Prompt 1 (Vision)**: Role classification with weighted scoring + evidence triggers
- **Prompt 2 (Pairing)**: Uses Prompt 1 JSON + pre-computed candidate hints
- **Auto-pair Fallbacks**:
  - General: `preScore ≥ 3.0`, `gap ≥ 1.0` (supplements/food)
  - Hair/Cosmetics: `preScore ≥ 2.4`, `gap ≥ 0.8` (INCI-based products)

### Phase 4: Production Hardening

#### 4.1-4.2: Observability & Tunability
- **Metrics System** (`src/pairing/metrics.ts`):
  - Totals: images, fronts, backs, candidates, autoPairs, modelPairs, singletons
  - Per-brand breakdown with pair rates
  - Reason histogram for singleton analysis
  - Threshold snapshot for reproducibility
  - Timestamp + duration tracking
  - Output: `pairing-metrics.json`

- **Config System** (`src/pairing/config.ts`):
  - All thresholds centralized with env overrides
  - `PAIR_AUTO_SCORE`, `PAIR_AUTO_GAP`, `PAIR_AUTO_HAIR_SCORE`, etc.
  - Packaging boosts: dropper-bottle +2.0, pouch +1.5, bottle +1.0
  - Safety valve limits: max build time, max back-front ratio

#### 4.3: Filename/Folder Proximity
- **Levenshtein distance** ≤ 2 for stem matching
- **Same folder detection** (exact path match)
- **+0.5 boost** when proximity detected
- Shows in PRE logs as `proximity:+0.5`

#### 4.4: Barcode Certainty Nudge
- **Barcode detection** in back text (UPC, barcode, etc.)
- **Front uniqueness check** (brand+product signature)
- **+0.5 boost** when both conditions met
- Shows in PRE logs as `barcode:+0.5`

#### 4.5: Safety Valves
- **Cycle detection**: WARN when back appears under ≥3 fronts
- **Build timeout**: WARN if candidate building > 30s
- **Graceful degradation**: All checks working

### Phase 5: Multi-Image Products

- **ProductGroup schema**: `{productId, frontUrl, backUrl, extras[], evidence}`
- **Deterministic matching** for SIDE/OTHER images:
  - Brand match (or unknownRescue)
  - Packaging agreement
  - Category tail overlap
  - Filename/folder proximity
  - Minimum 2 signals required
- **Limit ≤4 extras** per product to avoid bloat
- **EXTRA logs**: `EXTRA front=... + side=... reason=packagingMatch+nameProximity`

### Phase 6: Regression Suite

- **Golden dataset**: `tests/golden/` with frozen inputs/outputs
- **npm run verify:golden**: Compares current vs expected
- **Exit code 1** on regression:
  - Pair count changes
  - Singleton count changes
  - Product count changes
  - AutoPair/ModelPair counts change
- **Clear delta reporting**: `REGRESSION pairs: 4 -> 3 ; singletons: 0 -> 1`

## Current Performance

**Real-World Test (26 images, 13 products - November 2025):**
- ✅ **12/13 pairs achieved** (92.3% success)
- ✅ **11 auto-pairs** (visual+text strong signals)
- ✅ **1 GPT pair** (tiebreaker for ambiguous case)
- ⚡ **15-22 second execution** (well under 26s timeout)
- 🎯 **Visual-first matching working**: Navy boxes, colored bottles pairing by appearance

**Notable Success**: Prequel navy box auto-paired with score 3.0 on visual similarity alone (navy-blue+navy-blue, box+box, product overlap 0.80) despite empty brand field and role="other" mislabel.

**Test Batch (8 images, 4 products):**
- ✅ **100% pair rate** (4/4 fronts paired)
- ✅ **0 GPT calls** (all auto-paired)
- ✅ **0 singletons**
- ✅ **4 products** (ready for extras)
- ⚡ **2ms execution time**

**PreScores (with boosts):**
- myBrainCo Gut Repair: 9.0 (brand +3, prodJac +2, pkg +1.5, proximity +0.5, barcode +0.5)
- Frog Fuel Performance Greens: 6.5 (brand +3, prodJac +1, pkg +1.5, barcode +0.5)
- Nusava Liquid Supplement: 3.5 (unknownRescue +1, pkg +2, proximity +0.5)
- R+Co Hair Oil: 3.0 (unknownRescue +1, pkg +1, proximity +0.5, INCI hair fallback)

## Scoring Breakdown

### Visual-First Heuristics (Primary)
- **Packaging match**: **+3** (bottle, jar, tube, box, pouch, etc.)
- **Exact color match**: **+2.5** (white+white, navy-blue+navy-blue)
- **Close color match**: **+2** (blue vs light-blue, normalized)
- **Empty brand penalty**: **-0.5** (allows visual to compensate)
- **Role="other" penalty**: **-0.5** (captures mislabeled backs)

### Base Heuristics (Secondary)
- Brand exact match: **+3**
- Product Jaccard ≥ 0.5: **+2** (or +1 if ≥ 0.3)
- Variant Jaccard ≥ 0.5: **+1**
- Size canonical equality: **+1**
- Category tail overlap: **+1**
- Role mismatch: **-2**
- Category conflict (hair vs supplement): **-2**

### Packaging Boosts (configurable)
- Dropper-bottle match: **+2.0**
- Pouch match: **+1.5**
- Bottle match: **+1.0**

### Rescue Mechanisms
- Unknown brand + packaging match: **+1.0**
- Cosmetic/INCI back cue: **+0.5**
- Filename/folder proximity: **+0.5**
- Barcode + unique front: **+0.5**

## Configuration

All thresholds externalized via environment variables:

```bash
# General autopair
PAIR_AUTO_SCORE=3.0        # preScore threshold
PAIR_AUTO_GAP=1.0          # gap to runner-up

# Hair/cosmetics autopair
PAIR_AUTO_HAIR_SCORE=2.4
PAIR_AUTO_HAIR_GAP=0.8

# Packaging boosts
PAIR_PKG_DROPPER=2.0
PAIR_PKG_POUCH=1.5
PAIR_PKG_BOTTLE=1.0

# Candidate pool (November 2025: increased for visual-only matches)
PAIR_CANDIDATE_K=8         # Top K candidates per front (was 4)

# Safety limits
PAIR_MAX_BUILD_MS=30000
PAIR_MAX_BACK_FRONT_RATIO=3

# Candidate threshold
PAIR_MIN_PRESCORE=1.5
```

### Tuning Guidelines

**Candidate Pool (K)**:
- **K=4**: Fast, works when text+brand signals are strong (31% of backs)
- **K=8** (current): Better for visual-only matches, mixed brands (62% of backs)
- **K=12+**: Large datasets with many similar products or weak text signals
- **Trade-off**: Higher K = more candidates for GPT, slower but more thorough

**When to increase K**:
- Empty brand fields common in your dataset
- Many visual-only matches needed (white bottles, similar packaging)
- Products with similar names competing for same back
- Pair rate < 90% despite good visual matches

**When to decrease K**:
- Strong brand + product text in all images
- Auto-pair rate > 95%, minimal GPT calls needed
- Performance concerns (K=8 is still fast, though)

## Output Files

### pairing.json
```json
{
  "pairs": [
    {
      "frontUrl": "...",
      "backUrl": "...",
      "matchScore": 9.0,
      "brand": "...",
      "product": "...",
      "evidence": ["AUTO-PAIRED: preScore=9.00", ...],
      "confidence": 0.95
    }
  ],
  "products": [
    {
      "productId": "brand_product",
      "frontUrl": "...",
      "backUrl": "...",
      "extras": ["side1.jpg", "detail.jpg"],
      "evidence": {...}
    }
  ],
  "singletons": [],
  "debugSummary": []
}
```

### pairing-metrics.json
```json
{
  "totals": {
    "images": 8,
    "fronts": 4,
    "backs": 4,
    "candidates": 8,
    "autoPairs": 4,
    "modelPairs": 0,
    "singletons": 0
  },
  "byBrand": {
    "mybrainco": { "fronts": 1, "paired": 1, "pairRate": 1 }
  },
  "reasons": {},
  "thresholds": {
    "minPreScore": 1.5,
    "autoPairScore": 3,
    "autoPairGap": 1,
    "autoPairHairScore": 2.4,
    "autoPairHairGap": 0.8
  },
  "timestamp": "2025-11-04T23:48:13.000Z",
  "durationMs": 2
}
```

## Console Logs

```
PRE   front=EBAY/awef.jpg
 - EBAY/awefawed.jpg preScore=9.00 prodJac=1.00 varJac=0.20 sizeEq=false 
   pkg=pouch boost=1.5 brand=equal proximity:+0.5 barcode:+0.5

WARN back=EBAY/awefawed.jpg appears under 3 fronts; consider lowering thresholds

AUTOPAIR front=EBAY/awef.jpg back=EBAY/awefawed.jpg preScore=9.0 Δ=5.5 
         brand=equal pkg=pouch sizeEq=false prodJac=1.00 varJac=0.20

EXTRA front=EBAY/awef.jpg + side=EBAY/awef_side.jpg reason=brandMatch+packagingMatch+sameFolder

GROUPED: 4 products with 2 total extras

METRICS images=8 fronts=4 backs=4 candidates=8 autoPairs=4 modelPairs=0 singletons=0

SUMMARY frontsWithCandidates=4/4 autoPairs=4 modelPairs=0 singletons=0
```

## Testing

```bash
# Run pairing on test batch
npm run pairing

# Verify against golden dataset
npm run verify:golden

# Test config override
PAIR_AUTO_SCORE=3.2 npm run pairing

# Run unit tests
npm test
```

## Phase 7 Roadmap (Optional)

### Ops Niceties
- **Rate-limit guard**: Chunk massive jobs by 200 images
- **Backfill mode**: Re-run pairing when images arrive in different batches
- **Telemetry**: Push metrics to Datadog/Grafana
- **Anomaly alerts**: Fire when singletons > 2% or contract violations > 0

### CI Integration
- Add canary run on each PR
- Fail if pair count drops or singletons rise
- Auto-comment with metrics diff

## Files Modified/Created

### November 2025 - Visual-First Matching
- `src/prompt/pairing-prompt.ts` - Visual-first scoring rules (packaging +3, color +2.5)
- `src/pairing/candidates.ts` - Role="other" inclusion, K=8 default, color normalization
- `src/pairing/metrics.ts` - Count "other" role as backs
- `src/pairing/runPairing.ts` - Hallucination prevention, performance optimization
- `netlify/functions/smartdrafts-pairing.ts` - Integration with new runPairing system

### Phase 4 (Hardening)
- `src/pairing/metrics.ts` (NEW) - Metrics calculation + formatting
- `src/pairing/config.ts` (NEW) - Centralized configuration
- `src/pairing/candidates.ts` - Wired to config, added proximity/barcode boosts
- `src/pairing/runPairing.ts` - Integrated metrics, safety valves
- `scripts/run-pairing.ts` - Added metrics output

### Phase 5 (Multi-Image)
- `src/pairing/schema.ts` - Added ProductGroup type
- `src/pairing/groupExtras.ts` (NEW) - Side/detail matching logic
- `src/pairing/runPairing.ts` - Integrated product grouping

### Phase 6 (Golden Dataset)
- `tests/golden/analysis.json` - Frozen test input
- `tests/golden/pairing-expected.json` - Expected output
- `tests/golden/metrics-expected.json` - Expected metrics
- `scripts/verify-golden.ts` (NEW) - Regression test script
- `package.json` - Added `verify:golden` script

## Success Criteria ✅

- [x] Centralized config with thresholds & boosts
- [x] metrics.json persisted + METRICS console line
- [x] Filename proximity + barcode unique boosts
- [x] Golden dataset + npm run verify:golden
- [x] Multi-image grouping (sides/details)
- [x] 100% pair rate on test batch
- [x] Zero GPT calls via auto-pairing
- [x] Safety valves with clear warnings
- [x] Per-brand metrics breakdown

## Next Steps

1. **Gather larger batch** (50-200 images, mixed categories)
2. **Sanity-check distribution** (skincare tubes, jars, weird pouches, multi-flavor lines)
3. **Category-specific tweaks** if pair rate drops below 95%
4. **Deploy to production** with telemetry
5. **Monitor metrics** for anomalies
