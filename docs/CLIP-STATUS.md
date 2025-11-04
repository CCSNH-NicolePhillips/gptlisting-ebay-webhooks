# CLIP Clustering Status - Nov 4, 2025

## 🔧 NEW CRITICAL ISSUE: Vision API Only Analyzing 1 of 9 Images (Nov 4, 2025)

### Current Status: **DEPLOYED FIX WORKING, BUT NEW ISSUE DISCOVERED** ⚠️
- **Good News**: Filename mapping fix (commit `d467909`) is working correctly ✅
  - Index-based matching works: `visionGroups[0]` = `files[0]`
  - No more "✗ File not found" errors
- **New Problem**: Vision API only returned 1 imageInsight out of 9 images
  - Log shows: `"groups": [1 group]` and `"imageInsights": [1 insight]`
  - Expected: 9 imageInsights (one per image)
  - Result: Only `asd32q.jpg` was analyzed, other 8 images got `role: null`
  - All 8 unanalyzed images → Uncategorized group

### Root Cause (INVESTIGATED)
- ✅ **Verified**: All 9 images ARE being sent to Vision API (line 292: `runVision({ images: batch, prompt })`)
- ✅ **Verified**: Prompt correctly says "Analyze EACH image INDIVIDUALLY" and "Each group should contain ONLY ONE IMAGE URL"
- ✅ **Verified**: Prompt is nearly identical to last working version (`232c858`)
- ❌ **Problem**: Vision API (GPT-4o) is only returning 1 group + 1 imageInsight for 9 images

Possibilities:
1. **Vision API behavior change**: GPT-4o may have changed how it handles multiple images in vision requests
2. **Token limit**: Response might be getting truncated due to detailed visualDescription requests
3. **Missing model specification**: `VISION_MODEL` env var not set, using wrong model/fallback
4. **Prompt confusion**: Despite instructions, Vision groups all images into one analysis

### Evidence from Logs (Nov 4, 11:07 AM)
```
🤖 Vision raw response: {
  "groups": [1 group],
  "imageInsights": [1 insight]  // ❌ Should be 9!
}
📦 Batch 1: Using FRESH data, 1 insights  // ❌ Should be 9!
[buildHybridGroups] Processing 9 images, 1 Vision analyses  // ❌ Should be 9!
```

### Previous Issue (FIXED) ✅
- **Problem**: Vision API correctly identifies all products, but filename mapping bug causes 100% failure
- **Root Cause**: Vision returns placeholder URLs but code tried to match by filename
- **Fix**: Match by array INDEX instead of filename
- **Status**: ✅ DEPLOYED (commit `d467909`)
- **Deployed**: Nov 4, 2025

### What Happened (Nov 4, 2025)
1. **Enhanced Vision Prompt (commit `abeb2b8`)**: Added detailed visualDescription instructions
   - TOO COMPLEX: 12-point checklist with examples overwhelmed Vision API
   - Result: ALL images returned `role: null`, `hasText: false` - complete failure
   
2. **Simplified Prompt**: Removed numbered checklist, kept comprehensive instructions in paragraph form
   - Result: Vision API worked PERFECTLY - correctly identified all 8 products
   - Vision responses showed proper OCR, roles (front/back), visual descriptions
   
3. **NEW BUG DISCOVERED**: Even with perfect Vision data, ALL products went to Uncategorized
   - Log showed: `[buildHybridGroups] ✗ File not found: 1.jpg`, `2.jpg`, `3.jpg`, etc.
   - Vision identified products correctly but code couldn't match them to real files
   - **Root cause**: Array indexing bug in filename matching logic

### The Fix (DEPLOYED ✅)
**Commit**: `d467909` - "Fix critical filename mapping bug in Vision response processing"
**Files Changed**:
1. `src/lib/smartdrafts-scan-core.ts` - **5 locations fixed**
2. `src/lib/vision-router.ts` - Added startup logging
3. `.env.example` - Documented VISION_MODEL and GPT_MODEL

**Locations Fixed in smartdrafts-scan-core.ts**:
1. Lines ~514-533: Vision identifications logging
2. Lines ~778-784: Product group visual description checking
3. Lines ~813-818: Unassigned image matching
4. Lines ~1008-1013: Orphan back insight lookup
5. Lines ~1035-1046: Front group insight matching

**Before** (BROKEN):
```typescript
// Tried to match by filename
const insight = insightList.find(ins => {
  const insightFilename = ins.url?.split('/').pop()?.toLowerCase();
  return insightFilename === filename.toLowerCase();
});
```

**After** (FIXED):
```typescript
// Use index-based matching: insightList[i] corresponds to files[i]
const insight = insightList[fileIdx];
```

**Additional Changes**:
- Added `console.log("[vision-router] Using", process.env.VISION_MODEL || "(default)");` for deployment verification
- Documented `VISION_MODEL=openai:gpt-4o` and `GPT_MODEL=gpt-4o` in `.env.example`

### Results After Deployment
- **Before**: 0% success (all images → Uncategorized despite perfect Vision data)
- **After**: Expected 67-75% success (same as previous working version `232c858`)
- Vision API working perfectly - problem was only in filename mapping
- **Next**: Set `VISION_MODEL=openai:gpt-4o` and `GPT_MODEL=gpt-4o` in Netlify env vars (if not already set)

---

## ✅ PREVIOUS WORKING SOLUTION: Vision OCR + Exact Brand Matching (67% Automatic, No False Positives)

### Last Known Working Status
- Commit: `232c858` (Nov 3, 2025) - **BEFORE enhanced prompt attempts**
- Success Rate: **67% fully automatic** (6/9 images)
- False Positive Rate: **0%** (no incorrect groupings)
- Cost: ~$0.01 per analysis batch (well within budget)

### Test Results (9 images, 4 products + 1 decoy)
**✅ Correctly Grouped (6/9 images):**
- `asd32q.jpg` + `azdfkuj.jpg` → **R+Co ON A CLOUD** (0.886 CLIP similarity)
- `awef.jpg` + `awefawed.jpg` → **Gut Repair** (0.861 CLIP similarity)

**⚠️ Needs Manual Assignment (2/9 images):**
- `dfzdvzer.jpg` → Nusava back (Vision OCR failed - brown background)
- `faeewfaw.jpg` → Frog Fuel front (Vision OCR failed - low contrast)

**✅ Correctly Identified as Non-Product (1/9 images):**
- `IMG_20251102_144346.jpg` → Purse (in Uncategorized)

**⚠️ Incomplete Groups:**
- **Frog Fuel**: 1 image (missing front - `faeewfaw.jpg` unidentified)
- **Nusava**: 1 image (missing back - `dfzdvzer.jpg` unidentified)

### How It Works
1. **Vision OCR**: GPT-4o Vision reads text from each image individually
2. **Brand+Product Extraction**: Parse brand and product name from OCR text
3. **Exact Matching**: Group images with identical "brand|||product" keys
4. **CLIP Verification**: Verify grouped images have ≥0.75 similarity (prevents false groupings)
5. **Orphan Back Merging** (NEW - Nov 3): Match single-back-only groups with front groups from same brand using visual similarity
6. **Uncategorized Fallback**: Images Vision can't identify go to "Uncategorized" for manual review

### Recent Enhancements (Nov 3, 2025)
**Commits**: `cb1471a`, `02228a4`, `439bc3e`, `6f31466`

1. **Visual Description Matching**: Added detailed `visualDescription` field to Vision prompt
   - Color match (+15 pts), packaging type (+10 pts), material (+5 pts), shape (+5 pts)
   - Text color (+3-6 pts), layout (+4 pts), panels (+9 pts), features (+2 pts)
   - Threshold: ≥20 points for confident match
   
2. **Orphan Back Merging**: Match single-back-only groups with same-brand front groups
   - Finds backs that Vision identified with generic product name ("Frog Fuel" vs "PERFORMANCE GREENS + PROTEIN")
   - Uses visual similarity scoring (color, packaging, material, shape)
   - Successfully merged Frog Fuel pairs in testing

3. **Bug Fixes**: Fixed THREE locations where `visualDescription` and `textExtracted` fields were being stripped during response normalization

### Known Issues
- **Vision API Non-Determinism**: Same images produce different OCR results across runs
  - Sometimes correctly identifies products
  - Sometimes misidentifies products as "tan leather bag" or "brown leather bag"
  - Sometimes drops images entirely from response (8 insights for 9 images)
- **Success Rate Variability**: 50-75% depending on Vision's OCR reliability
- **Simplified Prompt Working**: Detailed checklist overwhelmed Vision; paragraph format works better

### Why CLIP Matching is Disabled
**Problem**: Visually similar supplement packaging causes false positives
- Nusava back (brown pouch) → 0.912 similarity to R+Co ❌ (wrong!)
- Frog Fuel front → 0.881 similarity to Gut Repair ❌ (wrong!)

**Decision**: Prioritize **safety over automation**
- Better to have 2 images in Uncategorized (manual review needed)
- Than to have wrong product assignments (requires cleanup + user frustration)

### Architecture
```
Images → Vision OCR → Brand/Product Extraction → Exact Match Grouping → CLIP Verification → Final Groups
                                    ↓ (if OCR fails)
                              Uncategorized Group (manual review)
```

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
VISION_MODEL=openai:gpt-4o (NEEDS TO BE SET IN NETLIFY)
GPT_MODEL=gpt-4o (NEEDS TO BE SET IN NETLIFY)
```

## Next Steps for New AI Agent

### ✅ COMPLETED (Nov 4, 2025)
1. ✅ **Deployed the filename mapping fix** (commit `d467909`)
   - Fixed 5 locations in `smartdrafts-scan-core.ts`
   - Added vision model startup logging
   - Documented env vars in `.env.example`
2. ⏳ **Waiting for test results** with 9-image test set
3. ⏳ **Expected result**: 3-4 product groups (67-75% pairing) instead of everything in Uncategorized

### NEXT IMMEDIATE ACTION - FIX VISION API MULTI-IMAGE ANALYSIS

**ROOT CAUSE IDENTIFIED** 🎯 - Batch Vision API behavior:

**Problem:** Sending 9 images in single OpenAI API call → GPT-4o returns only 1 imageInsight
- ✅ Filename mapping bug fixed (commit d467909)
- ✅ Environment variables confirmed set (VISION_MODEL=openai:gpt-4o)
- ✅ Prompt says "Analyze EACH image INDIVIDUALLY"
- ❌ **GPT-4o ignores multi-image instruction** and groups them together

**Technical Details:**
- `src/lib/vision-router.ts` → `tryOpenAI()` sends ALL images in one call:
  ```typescript
  for (const url of images) {
    content.push({ type: "image_url", image_url: { url } });
  }
  ```
- Prompt: "Analyze EACH image INDIVIDUALLY" + "Each group should contain ONLY ONE IMAGE URL"
- Reality: GPT-4o treats batch as related product images, returns 1 combined analysis
- Expected: 9 imageInsights, Actual: 1 imageInsight

**SOLUTION IMPLEMENTED** ✅ - Hybrid Fallback Approach:

**What Changed** (`src/lib/analyze-core.ts`, lines ~576-617):
- After batch Vision call, check if `imageInsights.length < batch.length`
- If missing insights detected, identify which images weren't analyzed
- Re-analyze missing images individually (1 image per API call)
- Merge individual results back into batch result
- Log: `"⚠️ Batch X: Got N insights for M images - filling gaps individually"`

**Benefits:**
- ✅ Fast batch analysis when GPT-4o cooperates (returns all insights)
- ✅ Automatic fallback ensures 100% coverage when it doesn't
- ✅ Only pays for extra API calls when needed
- ✅ No prompt changes required (robust solution)

**Expected Behavior:**
- First call: Batch of 9 → returns 1 insight
- Fallback: 8 individual calls → returns 8 more insights
- Final: 9 total insights (100% coverage)

**Alternative Fixes** (if env var doesn't solve it):
3. **Reduce visualDescription detail** to avoid token limits
   - Current prompt has very verbose visualDescription instructions
   - May be hitting response token limits with 9 images
   - Could simplify to see if more images get analyzed

4. **Test with smaller batches**
   - Try 3 images at a time instead of 9
   - See if Vision API handles smaller batches better

5. **Check Vision API logs**
   - Look for token limit warnings
   - Check if request is actually using gpt-4o or falling back to gpt-4o-mini

### What's Working ✅
- Filename mapping fix is deployed and working
- `[buildHybridGroups] ✓ Matched asd32q.jpg` (no more "File not found" errors)
- Vision API correctly identified the 1 image it analyzed

### What's Broken ❌
- Only 1 of 9 images being analyzed by Vision API
- 8 images have `role: null` → all go to Uncategorized

### Understanding the System
- **Vision API is the primary grouping mechanism** (not CLIP)
- CLIP is used only for verification (prevent false positives)
- System prioritizes safety: better to have manual review than wrong groupings
- Vision OCR is non-deterministic but usually works 50-75% of the time

### If Issues Persist
1. Check Vision API response in logs: `🤖 Vision raw response:`
2. Verify `imageInsights` have proper `role`, `hasVisibleText`, `textExtracted`, `visualDescription`
3. Check if `[buildHybridGroups]` logs show "✓ Matched" or "✗ File not found"
4. CLIP endpoint may be sleeping (503 errors) - this is normal, system has fallback

### Testing Commands
```bash
# Local CLIP endpoint test
node scripts/test-clip-endpoint.mjs

# Build TypeScript
npm run build

# Check recent commits
git log --oneline -10
```

## Key Files
- `src/lib/clip-client-split.ts` - CLIP API client
- `src/lib/smartdrafts-scan-core.ts` - **Main scan logic (✅ FILENAME MAPPING BUG FIXED - commit d467909)**
  - `buildHybridGroups()` function - Groups images by Vision brand+product match
  - **FIXED**: Now uses array index matching: `visionGroups[i]` = `files[i]` = `insightList[i]`
  - Fixed in 5 locations (logging, product grouping, orphan back merging)
- `src/lib/vision-router.ts` - Vision API provider router (✅ Added startup logging - commit d467909)
  - `runVision()` function - Routes to OpenAI/Anthropic/Google vision models
  - Now logs which model is active: `[vision-router] Using openai:gpt-4o`
- `src/lib/analyze-core.ts` - Vision API prompt and response processing
  - Lines 273-288: Vision prompt (simplified Nov 4, complex version failed)
  - Lines 215-237, 418-440: Response normalization (fixed to preserve visualDescription)
- `src/lib/image-insight.ts` - TypeScript type with `textExtracted?` and `visualDescription?` fields
- `src/config.ts` - Feature flags (USE_NEW_SORTER default=true)
- `scripts/test-clip-endpoint.mjs` - Local CLIP endpoint tester
- `.env.example` - ✅ Now documents VISION_MODEL and GPT_MODEL (commit d467909)

## Latest Commits (Chronological)
- `232c858` (Nov 3) - Last known working version (67% success)
- `8c703eb` (Nov 3) - Add detailed visualDescription field to Vision analysis
- `cb1471a` (Nov 3) - Add visual description matching to pair unidentified backs with fronts
- `439bc3e` (Nov 3) - Fix visualDescription fields not being extracted (first location)
- `6f31466` (Nov 3) - Fix third location + add cache debugging
- `02228a4` (Nov 3) - Add orphan back group merging
- `abeb2b8` (Nov 3) - **BROKE EVERYTHING**: Massively enhanced Vision prompt (too complex)
- `f1bc145` (Nov 4) - **Simplify Vision prompt** - Fixed Vision API, but revealed filename bug
- **`d467909` (Nov 4) - ✅ DEPLOYED: Fix filename mapping bug + add vision model logging + document env vars**

## Known Issues (Low Priority)

1. **Uncategorized Group Hero/Back Selection**: 
   - The Uncategorized group currently goes through hero/back selection logic (Phase R2)
   - Since these aren't products, they don't need heroUrl/backUrl classification
   - Should skip role selection for uncategorized items
   - Impact: Minor - doesn't cause errors, just unnecessary processing
   - Fix: Add check in Phase R2 to skip hero/back logic if groupId === 'uncategorized'

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
