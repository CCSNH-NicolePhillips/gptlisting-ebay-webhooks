# Pairing System Issue Analysis - Nov 18, 2025

## Problem Summary
Pairing system is only creating 10 paired products out of 13 expected products (26 images total). Vision API correctly detects front/back roles, but the pairing system is not utilizing all detected images correctly.

## Expected vs Actual Results

### Expected (13 Products)
- **26 total images** from /newStuff folder
- **13 product pairs** (each with front + back image)
- Vision should detect: ~13 fronts + ~13 backs

### Actual (10 Products)
- **26 total images** processed
- **10 paired products** created (8 auto-pairs + 2 model-pairs)
- **2 singletons** (fronts without backs)
- **METRICS:** `images=26 fronts=12 backs=14 candidates=44 autoPairs=8 modelPairs=2 singletons=2`

## Vision API Analysis Results

### Vision Correctly Detected (from logs.txt lines 1-3440)

**FRONTS (13 images):**
1. `20251115_142814.jpg` - role="front" (ROOT Zero-In)
2. `20251115_142857.jpg` - role="front" (oganacell DERX Cleanser)
3. `20251115_143002.jpg` - role="front" (maude soak)
4. `20251115_143138.jpg` - role="front" (RKMD Glutathione)
5. `20251115_143234.jpg` - role="front" (Naked Nutrition Collagen)
6. `20251115_143304.jpg` - role="front" (Jocko Fuel Creatine)
7. `20251115_143335.jpg` - role="front" (Jocko Fish Oil)
8. `20251115_143348.jpg` - role="front" ⚠️ (ROOT Sculpt - **MISUSED AS BACK IN PAIRING**)
9. `20251115_143418.jpg` - role="front" (ROOT Clean Slate)
10. `20251115_143446.jpg` - role="front" (Vita Inositol)
11. `20251115_143521.jpg` - role="front" (evereden Kids Face Duo)
12. `20251115_143552.jpg` - role="front" (RYSE Loaded Pre)
13. `20251115_143629.jpg` - role="front" (Prequel Vitamin C Serum) - **SINGLETON**

**BACKS (12 images):**
1. `20251115_142824.jpg` - role="back" (ROOT Zero-In back)
2. `20251115_143030.jpg` - role="back" (maude soak back)
3. `20251115_142904.jpg` - role="back" (oganacell back)
4. `20251115_143143.jpg` - role="back" (RKMD back)
5. `20251115_143241.jpg` - role="back" (Naked Nutrition back)
6. `20251115_143310.jpg` - role="back" (Jocko Creatine back)
7. `20251115_143340.jpg` - role="back" ⚠️ (Jocko Fish Oil back - **MISUSED AS BACK FOR 143335**)
8. `20251115_143353.jpg` - role="back" (ROOT Sculpt back)
9. `20251115_143422.jpg` - role="back" (ROOT Clean Slate back)
10. `20251115_143458.jpg` - role="back" (Vita Inositol back - **NOT PAIRED**)
11. `20251115_143527.jpg` - role="back" (evereden back)
12. `20251115_143556.jpg` - role="back" (RYSE back)

**OTHER (1 image):**
1. `20251115_143638.jpg` - role="other" (Prequel box side panel) - **SINGLETON**

## Pairing Results Analysis

### Successfully Auto-Paired (8 products)
1. `142814.jpg` (front) ↔ `142824.jpg` (back) - ROOT Zero-In ✅
2. `143002.jpg` (front) ↔ `143030.jpg` (back) - maude soak ✅
3. `143138.jpg` (front) ↔ `143143.jpg` (back) - RKMD Glutathione ✅
4. `143234.jpg` (front) ↔ `143241.jpg` (back) - Naked Nutrition Collagen ✅
5. `143304.jpg` (front) ↔ `143310.jpg` (back) - Jocko Fuel Creatine ✅
6. `143418.jpg` (front) ↔ `143422.jpg` (back) - ROOT Clean Slate ✅
7. `143521.jpg` (front) ↔ `143527.jpg` (back) - evereden Kids Duo ✅
8. `143552.jpg` (front) ↔ `143556.jpg` (back) - RYSE Loaded Pre ✅

### Model-Paired (2 products - AI similarity matching)
9. `143335.jpg` (front) ↔ `143340.jpg` (back) - Jocko Fish Oil ⚠️ **CORRECT**
10. `143446.jpg` (front) ↔ `143348.jpg` (back) - Vita Inositol ⚠️ **WRONG PAIRING**

### Singletons (2 unpaired fronts)
- `143629.jpg` (front) - Prequel Vitamin C Serum - declined despite candidates
- `143638.jpg` (other) - Prequel box side - declined despite candidates

### Missing Products (3 products not created)
1. **oganacell DERX Cleanser** - Front `142857.jpg` exists, Back `142904.jpg` exists - **NOT PAIRED**
2. **ROOT Sculpt** - Front `143348.jpg` exists, Back `143353.jpg` exists - **FRONT STOLEN BY 143446**
3. **Vita Inositol** - Front `143446.jpg` exists, Back `143458.jpg` exists - **PAIRED WITH WRONG BACK**

## Root Causes Identified

### Issue 1: Wrong Back Selected for Model Pairing
**Problem:** Front `143446.jpg` (Vita Inositol) was model-paired with `143348.jpg` (ROOT Sculpt **front**) instead of its correct back `143458.jpg`

**Evidence from logs:**
```
PAIR  front=20251115_143446.jpg  back=20251115_143348.jpg  score=2.00  brand=vita  product=myo & d-chiro inositol
EVID  productNameSimilarity: 0.00 | variantSimilarity: 0.00 | sizeMatch: 0 (60 mL vs 30g) | categoryCompat: +1.50 (identical leaf) | sharedOCR: 0.00 | packagingMatch: bottle | colorMatch: forest-green vs burgundy
```

**Why this happened:**
- Vision correctly classified `143348.jpg` as **front** (roleScore=-0.85)
- Vision correctly classified `143458.jpg` as **back** (roleScore=1.1)
- BUT pairing system treated `143348` as a back candidate for `143446`
- Model pairing scored it at 2.00 (very low) but still paired them

**Impact:**
- `143348` stolen from its correct product (ROOT Sculpt)
- `143446` paired with wrong back
- `143353` (ROOT Sculpt's real back) left orphaned
- `143458` (Vita Inositol's real back) left orphaned

### Issue 2: Missing Product - oganacell DERX Cleanser
**Problem:** Front `142857.jpg` and Back `142904.jpg` both exist and were correctly classified by Vision, but they were **never paired**

**Evidence:**
- Vision logs show: `142857.jpg` role="front" and `142904.jpg` role="back"
- Neither appears in AUTOPAIR logs
- Neither appears in CANDIDATES logs
- Neither appears in model-paired results

**Why this happened:**
- `142857.jpg` is not in the list of fronts that participated in candidate matching
- Only 12 fronts participated in pairing: 142814, 143002, 143138, 143234, 143304, 143335, 143418, 143446, 143521, 143552, 143629, 143638
- `142857.jpg` is **completely missing from pairing process**

### Issue 3: Phase 5 Reconciliation Still Affecting Roles
**Problem:** Despite our fix to prevent backs→fronts conversion, some role confusion persists

**Evidence from Vision logs:**
```
"url": "newStuff/20251115_143348.jpg",
"role": "front",
"roleScore": -0.85
```

**Evidence from pairing logs:**
```
back=20251115_143348.jpg  (used as back for 143446)
```

**Why this happened:**
- Vision outputs correct role in imageInsights
- Phase 5 reconciliation may still be modifying roles in some edge cases
- Or pairing buildCandidates is not filtering fronts out of back candidates properly

### Issue 4: Pairing Metrics Discrepancy
**Vision detected:** 13 fronts + 12 backs + 1 other = 26 images
**Pairing counted:** 12 fronts + 14 backs = 26 images

**Discrepancy:**
- 1 front (143348) being counted as back in pairing
- 1 other (143638) being counted as back in pairing
- 1 front (142857) completely missing from pairing

## Data Flow Analysis

### Expected Flow
```
Vision API Analysis
  ↓ (26 images analyzed individually)
imageInsights[] created with role field
  ↓ (passed to scan-core)
Phase 5 Reconciliation (role confidence)
  ↓ (should preserve Vision roles)
imageInsightsRecord stored in cache
  ↓ (loaded by pairing function)
buildFeatures() extracts roles
  ↓ (creates features Map)
buildCandidates() filters fronts/backs
  ↓ (creates candidate pairs)
Pairing creates pairs
```

### Actual Issues in Flow

1. **Phase 5 Reconciliation** (line 3686-3689 in smartdrafts-scan-core.ts):
   ```typescript
   const insight = imageInsightsRecord[corr.imageKey];
   if (insight) {
     (insight as any).role = corr.correctedRole;  // ⚠️ Still mutating
   }
   ```
   - Our fix prevented backs→fronts for missing-front groups
   - But other reconciliation rules may still modify roles

2. **buildFeatures()** (line 202 in featurePrep.ts):
   ```typescript
   const role = (insight.role || 'other') as Role;
   ```
   - Takes role directly from insight
   - If insight.role was modified by reconciliation, wrong role is used

3. **Missing from pairing entirely:**
   - `142857.jpg` exists in imageInsights but never appears in features Map
   - Possible: skipped in buildFeatures matching process
   - Possible: filtered out before pairing starts

## Debugging Steps Needed

### Step 1: Check if 142857 made it to imageInsightsRecord
Look in logs for: `[responsePayload DEBUG] imageInsights sample`
- Does it include `142857.jpg`?
- What role does it have in the cached record?

### Step 2: Check if 143348 role was modified
Search logs for: `[pairing-phase5] Reconciliation: 20251115_143348`
- Was its role changed from front→back?
- Or was it left as front but still used as back candidate?

### Step 3: Check buildFeatures matching
Look in logs for: `[buildFeatures] SKIPPED`
- Was `142857.jpg` skipped?
- Why didn't it match to a group?

### Step 4: Check buildCandidates filtering
Look in buildCandidates code:
- Does it properly filter `role === 'front'` images out of back candidates?
- Or can a front image appear as a back candidate if other conditions match?

## Proposed Fixes

### Fix 1: Strengthen Role Filtering in buildCandidates
```typescript
// In buildCandidates, ensure fronts never appear as back candidates
const backs = Array.from(features.values())
  .filter(f => f.role === 'back' || f.role === 'other')
  .filter(f => f.role !== 'front');  // Extra safety check
```

### Fix 2: Add Validation After Reconciliation
```typescript
// After Phase 5 reconciliation, validate no fronts were converted to backs
for (const [key, insight] of Object.entries(imageInsightsRecord)) {
  const visionRole = originalInsights.get(key)?.role;
  const currentRole = insight.role;
  if (visionRole === 'front' && currentRole !== 'front') {
    console.warn(`[validation] Front ${key} was changed to ${currentRole} - reverting`);
    insight.role = 'front';
  }
}
```

### Fix 3: Debug Missing Images
```typescript
// In buildFeatures, log all skipped images with reason
if (!group) {
  skipped++;
  console.log(`[buildFeatures] SKIPPED: basename="${base}" url="${url}" - no matching group`);
  console.log(`[buildFeatures] Available groups:`, Array.from(groupByBase.keys()));
  continue;
}
```

### Fix 4: Model Pairing Threshold
```typescript
// In model pairing, set minimum score threshold
if (score < 3.0) {
  console.log(`[model-pairing] REJECTED: score ${score} below threshold 3.0`);
  continue;
}
```

## Test Case Verification

After fixes, pairing should produce:

**Expected Output:**
```
METRICS images=26 fronts=13 backs=13 candidates=X autoPairs=12 modelPairs=1 singletons=0
```

**Expected Pairs (13 products):**
1. 142814 ↔ 142824 (ROOT Zero-In)
2. 142857 ↔ 142904 (oganacell DERX Cleanser) ⬅️ **CURRENTLY MISSING**
3. 143002 ↔ 143030 (maude soak)
4. 143138 ↔ 143143 (RKMD Glutathione)
5. 143234 ↔ 143241 (Naked Nutrition Collagen)
6. 143304 ↔ 143310 (Jocko Fuel Creatine)
7. 143335 ↔ 143340 (Jocko Fish Oil)
8. 143348 ↔ 143353 (ROOT Sculpt) ⬅️ **CURRENTLY BROKEN**
9. 143418 ↔ 143422 (ROOT Clean Slate)
10. 143446 ↔ 143458 (Vita Inositol) ⬅️ **CURRENTLY WRONG BACK**
11. 143521 ↔ 143527 (evereden Kids Duo)
12. 143552 ↔ 143556 (RYSE Loaded Pre)
13. 143629 ↔ 143638 (Prequel Vitamin C Serum) ⬅️ **CURRENTLY SINGLETON**

**Note:** Item 13 may be legitimate singleton if 143638 is truly "other" role (side panel)

## Summary for ChatGPT

We implemented Phase 5 pairing refinement with role confidence scoring to improve front/back image pairing. The Vision API correctly detects 13 fronts and 12 backs (plus 1 "other"), but the pairing system only creates 10 product pairs instead of 13.

**Three specific failures:**

1. **Wrong Back Assignment:** Front `143446.jpg` (Vita Inositol) was paired with `143348.jpg` which Vision classified as a **front** (ROOT Sculpt), not the correct back `143458.jpg`

2. **Missing Product Entirely:** Front `142857.jpg` (oganacell) and its back `142904.jpg` both exist and were correctly classified by Vision, but never participated in pairing at all

3. **Stolen Front:** Because `143348.jpg` (a front) was used as a back for `143446`, the real ROOT Sculpt product (front=143348, back=143353) was never created

The root issue appears to be that Vision's role classifications in `imageInsights` are either being modified incorrectly during Phase 5 reconciliation, or the pairing candidate-building process is not properly filtering fronts out of back candidates.

We need to:
1. Trace why `142857.jpg` never appears in pairing logs
2. Understand why `143348.jpg` (classified as front) is being used as a back candidate
3. Add stricter validation to ensure Vision's role assignments are preserved through to pairing
