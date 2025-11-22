# Pairing V2 - Phase 2 Handoff (Nov 21, 2025)

## 🎯 Goal
Implement **deterministic pre-matching + LLM fallback** in pairing-v2 sandbox to achieve 13/13 pairs on `/newStuff` with hybrid approach.

## ✅ What We Completed (Phase 2.1-2.3)

### Phase 2.1 - V2Feature Struct (Commit: 9b431b9)
**File**: `src/pairing/pairing-v2.ts`

Added lightweight normalized feature representation:

```typescript
interface V2Feature {
  key: string;        // unique image key (url)
  filename: string;   // full filename
  basename: string;   // filename only (no path)
  brandKey: string;   // normalized brand
  colorKey: string;   // normalized color
  packagingKey: string; // normalized packaging
  sizeText: string;   // canonical size
  productText: string; // joined product tokens
}

function buildV2Feature(img: FeatureRow, idx: number): V2Feature | null
```

**Purpose**: Convert FeatureRow to normalized keys for grouping/matching.

---

### Phase 2.2 - Deterministic Pre-Match (Commit: ccfa6ab)
**File**: `src/pairing/pairing-v2.ts`

Added heuristic matching function:

```typescript
interface V2PreMatchResult {
  pairs: Pair[];
  remaining: FeatureRow[];
  debug: string[];
}

function deterministicPreMatch(
  images: FeatureRow[],
  log: (line: string) => void
): V2PreMatchResult
```

**Logic**:
1. Build V2Feature array from images
2. Bucket by `(brandKey, packagingKey)`
3. Auto-pair **only** size-2 buckets where:
   - Same brandKey (non-empty)
   - Same packagingKey (non-empty)
   - **Either**: productOverlap ≥ 0.2 **OR** exact colorKey match
4. Mark used images, return remaining for LLM

**Conservative thresholds**:
- Jaccard similarity: 0.2 (20% token overlap)
- Bucket size: exactly 2 images
- Evidence tag: `PAIRING-V2-PRE-HEURISTIC`
- Confidence: 0.95

**Helper**:
```typescript
function jaccardSimilarity(a: string, b: string): number
```
Simple token overlap: intersection/union.

---

### Phase 2.3 - Integration (Commit: 315e3b3)
**File**: `src/pairing/pairing-v2.ts`

Wired pre-match into `runPairingV2()`:

**Before** (Phase 1):
```typescript
const { pairs, singletons, rawText } = await unifiedGlobalLLMPairing({
  images: allImages,
  client,
  model,
  log,
});
```

**After** (Phase 2):
```typescript
// 1. Run heuristic pre-match
const pre = deterministicPreMatch(allImages, log);

// 2. Pass only remaining to LLM
const { pairs: llmPairs, singletons, rawText } = await unifiedGlobalLLMPairing({
  images: pre.remaining,  // ← only hard cases
  client,
  model,
  log,
});

// 3. Combine results
const combinedPairs = [...pre.pairs, ...llmPairs];
```

**Updated**:
- `engineVersion`: `"v2-phase2"` (was `"v2-phase1"`)
- `metrics.totals.autoPairs`: Heuristic pairs count
- `metrics.totals.modelPairs`: LLM pairs count
- `result.debugSummary`: Includes pre-match logs

---

## 📊 Phase 2 Architecture

```
┌─────────────────────────────────────────────────┐
│         runPairingV2(features, ...)             │
└──────────────────┬──────────────────────────────┘
                   │
                   ▼
         ┌─────────────────────┐
         │  deterministicPreMatch  │
         │  (brand + packaging)    │
         └──────┬─────────┬────────┘
                │         │
        ┌───────▼─────┐   │
        │ Auto-paired │   │
        │   (0.95)    │   │
        └─────────────┘   │
                          ▼
                  ┌───────────────┐
                  │  Remaining    │
                  │   images      │
                  └───────┬───────┘
                          │
                          ▼
                ┌──────────────────────┐
                │ unifiedGlobalLLMPairing │
                │   (LLM fallback)        │
                └──────────┬──────────────┘
                           │
                   ┌───────▼────────┐
                   │  LLM-paired    │
                   │  + singletons  │
                   └────────────────┘
                           │
                           ▼
                  ┌─────────────────┐
                  │ Combined pairs  │
                  │ [...pre, ...llm]│
                  └─────────────────┘
```

---

## 🔍 Key Files Modified

### `src/pairing/pairing-v2.ts`
**Lines added**: ~211 lines total across all phases

**New interfaces**:
- `V2Feature` (line ~31)
- `V2PreMatchResult` (line ~75)

**New functions**:
- `buildV2Feature()` (line ~44)
- `deterministicPreMatch()` (line ~84)
- `jaccardSimilarity()` (line ~219)

**Modified function**:
- `runPairingV2()` (line ~243): Now uses pre-match + LLM fallback

---

## 📈 Expected Behavior on /newStuff

**Dataset**: 26 images → 13 pairs expected

**Phase 2 flow**:
1. **Heuristic matching**: Auto-pairs obvious matches
   - Same brand + packaging + (product overlap OR color)
   - Example: "jocko + bottle + red" → auto-pair
2. **LLM fallback**: Handles hard cases
   - Different packaging types
   - Ambiguous brands
   - Complex variants
3. **Result**: Combined = 13/13 pairs

**Metrics breakdown**:
- `totals.autoPairs`: X pairs (heuristic)
- `totals.modelPairs`: Y pairs (LLM)
- `totals.autoPairs + totals.modelPairs`: 13 (total)

---

## 🧪 Testing Endpoint

**UI**: `/pairing-v2-labs.html`
**API**: `POST /.netlify/functions/pairing-v2-labs-run`

**Request**:
```json
{
  "folder": "/newStuff"
}
```

**Response**:
```json
{
  "ok": true,
  "folder": "/newStuff",
  "jobId": "...",
  "result": {
    "engineVersion": "v2-phase2",
    "pairs": [...],
    "singletons": [...],
    "debugSummary": [
      "V2 Phase 2: X heuristic pairs, Y LLM pairs, Z singletons",
      "[v2-pre] skip bucket=...",
      "[v2-pre] AUTO-PAIR brand=... pkg=...",
      ...
    ]
  },
  "metrics": {
    "totals": {
      "autoPairs": X,
      "modelPairs": Y,
      "singletons": Z
    },
    "durationMs": ...
  },
  "logLines": [...],
  "rawText": "..."
}
```

---

## 🎯 Next Steps (Phase 3?)

### Potential improvements:
1. **Tune thresholds**:
   - Lower Jaccard threshold if too conservative (0.2 → 0.15?)
   - Add size similarity check
   - Weight packaging type importance

2. **Multi-bucket logic**:
   - Handle buckets with >2 images
   - Use pairwise scoring within bucket
   - Pick best pairs greedily

3. **Variant handling**:
   - Use variantTokens for better matching
   - Handle "same product, different flavor" cases

4. **Confidence scoring**:
   - Calculate real confidence based on overlap
   - Pass to LLM as hints

5. **Performance tracking**:
   - A/B test: heuristic-only vs LLM-only vs hybrid
   - Track token savings from pre-match

---

## 🐛 Known Issues / Edge Cases

### Current limitations:
1. **Size-2 bucket only**: Won't auto-pair if 3+ images of same brand+packaging
2. **Conservative**: May under-pair obvious matches (LLM fallback catches them)
3. **No size check**: Doesn't verify sizes match/compatible
4. **Lexicographic front/back**: Arbitrary ordering (could use role if needed)

### Type safety notes:
- FeatureRow properties used:
  - `url`, `brandNorm`, `colorKey`, `packagingHint`, `sizeCanonical`, `productTokens`
- Pair requires `confidence` field (0.95 for heuristics)
- PairingResult requires `engineVersion`, `products`, `debugSummary`

---

## 💡 Design Decisions

### Why conservative thresholds?
- **Phase 2 goal**: Prove hybrid works, don't break LLM fallback
- Better to under-pair with heuristics (LLM catches it)
- Than to over-pair with heuristics (creates wrong pairs)

### Why bucket by brand + packaging?
- Most discriminative features from analysis
- Color can vary (same product, different flavors)
- Size can vary (same product, different volumes)
- Brand + packaging + product overlap = high confidence

### Why Jaccard similarity?
- Simple, interpretable
- Works well with tokenized product names
- Threshold 0.2 = "at least some overlap"
- Can upgrade to cosine/embeddings later

---

## 🔗 Related Files

### Core pairing v2:
- `src/pairing/pairing-v2.ts` (main logic)
- `src/pairing/featurePrep.ts` (FeatureRow interface)
- `src/pairing/schema.ts` (Pair, PairingResult types)
- `src/pairing/metrics.ts` (PairingMetrics interface)

### Testing:
- `netlify/functions/pairing-v2-labs-run.ts` (endpoint)
- `public/pairing-v2-labs.html` (UI)

### Reference (Phase 1):
- `src/pairing/runPairing.ts` (original HP2 + direct-llm modes)
- `public/new-smartdrafts/App.js` (production UI with mode toggle)

---

## 📝 Git History

```bash
# Phase 2.1 - V2Feature struct
git show 9b431b9  # Nov 21, 2025

# Phase 2.2 - Deterministic pre-match
git show ccfa6ab  # Nov 21, 2025

# Phase 2.3 - Integration
git show 315e3b3  # Nov 21, 2025
```

---

## 🚀 How to Continue

### Option A: Test Phase 2
1. Wait for Netlify deployment (~2 min)
2. Open `/pairing-v2-labs.html`
3. Run with `/newStuff` folder
4. Verify: 13/13 pairs, check autoPairs vs modelPairs breakdown
5. Review debug logs for heuristic decisions

### Option B: Tune Phase 2
1. Adjust thresholds in `deterministicPreMatch()`:
   - Line ~152: `if (productOverlap < 0.2 && !colorMatch)`
   - Try 0.15, 0.1, or add size check
2. Test on /newStuff, compare results
3. Track token savings (pre.remaining.length vs allImages.length)

### Option C: Implement Phase 3
1. Add multi-bucket logic (handle size >2)
2. Add size similarity check
3. Add variant token matching
4. Calculate dynamic confidence scores

---

## ✅ Phase 2 Success Criteria

- [x] V2Feature struct created with normalized keys
- [x] deterministicPreMatch() implemented with conservative logic
- [x] Integrated into runPairingV2() with LLM fallback
- [x] TypeScript compiles without errors
- [x] Metrics track autoPairs vs modelPairs
- [x] Debug logs show pre-match decisions
- [x] Committed and pushed to GitHub (3 commits)
- [ ] **PENDING**: Test on /newStuff dataset
- [ ] **PENDING**: Verify 13/13 pairs total
- [ ] **PENDING**: Validate autoPairs + modelPairs breakdown

---

## 🤝 Handoff Summary

**Current state**: Phase 2 complete, ready for testing
**Next action**: Test `/pairing-v2-labs.html` with `/newStuff` folder
**Expected result**: 13/13 pairs (some heuristic, some LLM)
**Success metric**: autoPairs > 0, total pairs = 13, singletons = 0

**Questions to answer**:
1. How many pairs came from heuristics vs LLM?
2. Are heuristic pairs correct (high quality)?
3. Did we save LLM tokens (smaller pre.remaining)?
4. Should we tune thresholds (too conservative/aggressive)?

---

**Last updated**: Nov 21, 2025  
**Phase**: 2.3 complete (deterministic pre-match + LLM fallback)  
**Status**: ✅ Ready for testing  
**Commits**: 9b431b9, ccfa6ab, 315e3b3
