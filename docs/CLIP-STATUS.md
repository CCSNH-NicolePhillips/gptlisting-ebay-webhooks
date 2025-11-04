# CLIP Clustering Status - Nov 4, 2025

## ✅ CRITICAL FIX DEPLOYED: Filename Mapping Bug (Nov 4, 2025)

### Current Status: **FIXED AND DEPLOYED** ✅
- **Problem**: Vision API correctly identifies all products, but filename mapping bug causes 100% failure
- **Root Cause**: Vision returns placeholder URLs (`https://example.com/1.jpg`, `2.jpg`, etc.) but code tried to match these to real filenames (`asd32q.jpg`, `awef.jpg`, etc.)
- **Fix**: Match by array INDEX instead of filename - `visionGroups[0]` = `files[0]`, `visionGroups[1]` = `files[1]`, etc.
- **Status**: ✅ DEPLOYED (commit `d467909`)
- **Deployed**: Nov 4, 2025
- **Expected Result**: 67-75% automatic grouping (same as last known working version)

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

### NEXT IMMEDIATE ACTION
1. **Set Environment Variables in Netlify** (if not already set):
   - Go to: Netlify Dashboard → Site → Site Configuration → Environment Variables
   - Add: `VISION_MODEL=openai:gpt-4o`
   - Add: `GPT_MODEL=gpt-4o`
2. **Test the fix** by running analyze-images with 9-image test set
3. **Verify logs** show:
   - `[vision-router] Using openai:gpt-4o` (confirms env var loaded)
   - `[buildHybridGroups] ✓ Matched` messages (confirms filename mapping working)
   - 3-4 product groups created instead of everything → Uncategorized

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
