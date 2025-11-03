# CLIP Clustering Status - Nov 3, 2025

## CURRENT SOLUTION: Hybrid Vision + CLIP + Visual Description Fallback ✅

### Test Dataset (9 images)
- `asd32q.jpg` - R+Co front
- `azdfkuj.jpg` - R+Co back
- `awef.jpg` - Gut Repair front
- `awefawed.jpg` - Gut Repair back
- `frog_01.jpg` - Frog Fuel back (has text, Vision reads it)
- `faeewfaw.jpg` - **Frog Fuel front** (brown, Vision can't read text)
- `rgxbbg.jpg` - Nusava front
- `dfzdvzer.jpg` - **Nusava back** (brown, Vision can't read text)
- `IMG_20251102_144346.jpg` - Purse (non-product)

### Current Approach (Working)
1. **Vision OCR**: Extract brand/product from text (works for 6/9 images)
2. **Exact Brand+Product Matching**: Group images with matching identifications
3. **CLIP Verification**: Verify groups with 0.75 similarity threshold
4. **CLIP Fallback Matching**: Unidentified images matched to groups via CLIP (0.75 threshold)

### Future Enhancement: Visual Description Fallback
**Problem**: Some images have text Vision can't read (brown backgrounds, low contrast)
- Example: `dfzdvzer.jpg` and `faeewfaw.jpg` return `textExtracted=""`

**Proposed Solution (for future implementation)**:
1. When OCR fails (`textExtracted="" or confidence < 0.5`), ask Vision: **"Describe what you see in this image visually"**
2. Get response like: "Brown supplement pouch with green accents, nutritional information panel, ingredient list visible"
3. Feed descriptions + known product fronts back to GPT: **"Which of these products does this description match?"**
   - Known: "Frog Fuel - green supplement pouch with 'STAY UNBREAKABLE'"
   - Known: "Nusava - pink/purple bottle with B12/B6/B1"
   - Unknown description: "Brown pouch with nutritional facts, mentions collagen protein"
4. GPT matches description → "This is likely the back of Frog Fuel based on collagen mention and green accents"

**Benefits**:
- Works when OCR completely fails
- Uses visual features (color, shape, layout) instead of text
- Can match front/back pairs even when back has no readable brand name
- Relatively cheap (~2 extra Vision calls per unidentified image)

**Cost Analysis**:
- Current: 1 Vision call for all images (~$0.01/run)
- With fallback: +2 Vision calls for unidentified images (~$0.015/run)
- Still well within budget ($0.30/month target)

## Previous: Vision API is Better for Product Grouping ✅

**Conclusion after extensive testing**: CLIP visual similarity alone **cannot reliably group products** when they have similar shapes/packaging.

### Test Results (9 images, 4 supplement bottles + 1 purse)
- **Vision API**: ✅ Correctly identified all 4 products every time
- **CLIP similarity-only**: ❌ Confused similar-looking bottles even with:
  - Complete-linkage clustering (most conservative)
  - Multimodal signals (text keywords + color matching)
  - Thresholds from 0.75 to 0.90
  
### The Problem
Supplement bottles are visually **too similar** across different brands:
```
Same product:      0.86-0.89 similarity
Different products: 0.85-0.91 similarity  ← TOO MUCH OVERLAP!
```

No threshold can separate them reliably.

### What We Tried
1. ✅ **Single-linkage** → Chains unrelated products
2. ✅ **Average-linkage** → Better but still mixes products  
3. ✅ **Complete-linkage** → Most conservative, but:
   - Threshold 0.87: Still groups wrong products
   - Threshold 0.90: Splits valid pairs
4. ✅ **Multimodal (visual + text + color)**:
   - Text similarity (OCR keyword matching)
   - Color penalties for mismatches
   - Still not accurate enough

### Current Solution
**USE_NEW_SORTER = false** (disabled in netlify.toml)
- Use Vision API for product grouping (it reads text, understands brands)
- Use CLIP for image **sorting within groups** (which image is "front" vs "back")

### Future: Better Approach
If we want CLIP grouping to work, we'd need:
1. **Product-specific embeddings** (fine-tuned on product images)
2. **Text embeddings from actual OCR** (GPT Vision doesn't return OCR text)
3. **Hybrid: Vision API groups + CLIP refinement**

---

## Previous Testing History

### Environment Variable Issue (FIXED ✅)
CLIP clustering is not running in production even though:
- ✅ Local test shows CLIP endpoint is NOW WORKING (0.68 similarity for different products)
- ✅ `USE_NEW_SORTER=true` by default (should enable CLIP)
- ❌ No `[buildClipGroups]` logs appear in production runs
- ❌ No `[Phase R0]` logs appear (even with debug logging added)

## What We Fixed
1. **CLIP Endpoint Issue (FIXED)**: 
   - Problem: All embeddings were 99.9% similar (broken)
   - Solution: ChatGPT helped fix HuggingFace endpoint configuration
   - Test result: Now shows 0.68 similarity (healthy range for different products)

2. **Added Diagnostics**:
   - Sample embedding logging (first 5 values)
   - Hash per image to detect cache collisions
   - Degenerate matrix check (auto-fallback if similarity >0.98)
   - Phase R0 entry log (just added, not tested yet)

3. **Adjusted Threshold**:
   - Changed from 0.65 → 0.75

   - Rationale: Different products show ~0.68 similarity, same product should be 0.75-0.90

## Test Script
Use `node scripts/test-clip-endpoint.mjs` to test CLIP endpoint locally:
- Requires image paths in `testImages` array
- Shows embeddings, hashes, and similarity scores
- Last test: 0.679 similarity between different products ✓

## Next Steps
1. **Run analyze-images again** and look for:
   - `[Phase R0] Starting - USE_NEW_SORTER=...` log
   - `[buildClipGroups] Clustering X images...` log
   - If neither appears, Phase R0 isn't being reached

2. **If Phase R0 runs but CLIP fails**:
   - Check if embeddings return null (HF endpoint asleep?)
   - Check if degenerate matrix triggers (>0.98 similarity)
   - Look at hash values (should all be different)

3. **If Phase R0 doesn't run at all**:
   - Something wrong earlier in execution flow
   - Check if `runSmartDraftScan` is even being called
   - May need to add earlier diagnostic logs

## Environment Variables
```
HF_API_TOKEN=<in prod.env>
HF_TEXT_ENDPOINT_BASE=https://c4hp6rdkxs6bi333.us-east-1.aws.endpoints.huggingface.cloud
HF_IMAGE_ENDPOINT_BASE=https://c4hp6rdkxs6bi333.us-east-1.aws.endpoints.huggingface.cloud
USE_NEW_SORTER=true (default)
```

## Key Files
- `src/lib/clip-client-split.ts` - CLIP API client
- `src/lib/smartdrafts-scan-core.ts` - Main scan logic (Phase R0 at line ~873)
- `src/config.ts` - Feature flags (USE_NEW_SORTER default=true)
- `scripts/test-clip-endpoint.mjs` - Local CLIP endpoint tester
- `prod.env` - Environment variables (lines 63-66 for CLIP)

## Latest Commit
`bb63061` - "Add Phase R0 entry log to diagnose CLIP clustering execution"

## What ChatGPT Said (Summary)
The 99.9% similarity issue was caused by:
1. Embedding the wrong thing (text instead of images), OR
2. Cache key collision (same vector for every URL), OR  
3. Fallback returning constant vector

**They recommended (all implemented)**:
- Phase C1: Use image endpoint only ✓
- Phase C2: Hash vectors to catch cache bugs ✓
- Phase C3: Deduplicate imageInsights (not done - may not be needed)
- Phase C4: Degenerate matrix check ✓
- Phase C5: Folder-only guard (not done - may not be needed)
- Phase C6: Unit vector normalization (already done in toUnit())

After their help, endpoint now returns properly differentiated embeddings.
