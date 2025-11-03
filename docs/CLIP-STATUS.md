# CLIP Clustering Status - Nov 3, 2025

## Current Issue
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
