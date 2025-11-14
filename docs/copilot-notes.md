# Copilot Reference Notes

> This file holds reminders the user expects me to retain across sessions. Update it whenever the user says, "you already know this" or repeats an instruction.

## Domains & Environments
- Primary admin/API host: https://draftpilot-ai.netlify.app/
- Use this domain in testing instructions and curl examples unless the user explicitly asks for another environment.

## Tokens / Headers
- Auth uses Auth0 bearer tokens via `window.authClient.authFetch()` or `window.authClient.ensureAuth()` loaded from `/auth-client.js`
- Admin API token available via `ADMIN_API_TOKEN` env var for server-side testing
- Never commit actual secret values; reference env var names instead

## Workflow Expectations
- The user expects references to their actual domain (see above) instead of placeholders.
- When giving testing instructions, default to their real domain.
- The user prefers that I commit and push code changes myself once builds/tests pass.
- When asked to test, I should:
	- set any required env vars (e.g., `ADMIN_API_TOKEN`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`) before running code;
	- run `npm run lint` and `npm run build` locally to ensure TypeScript output is current;
	- invoke the compiled Netlify handlers directly (using scripts under `tmp/`) to produce real responses instead of describing hypothetical results;
	- capture and report concrete status codes and response payloads from those handler runs;
	- summarize the exact commands and outputs in the response, plus note any required redeploy steps.

## Security & Secrets
- **NEVER hardcode secrets in HTML/JS files** (user caught this when I exposed DROPBOX_CLIENT_ID)
- Follow patterns from existing code like `smartdrafts-dropbox.html` which loads folders server-side without hardcoding client IDs
- Use `get-public-config` function to expose safe client-side config
- Dropbox client ID is public-safe but user prefers server-side patterns to avoid Netlify security scan failures

## SmartDrafts UI - New Isolated Implementation ✅ COMPLETE
**Location**: `/new-smartdrafts/` (isolated from legacy code)
**Stack**: Preact 10.20.2 + HTM 3.1.1 (ESM modules, no build step)
**Status**: Phases UI-0 through UI-7 complete, all backend functions wired

### Architecture Overview
**Frontend** (public/new-smartdrafts/):
- `index.html` - Main page, loads Preact/HTM from CDN
- `App.js` - Root component with tab navigation
- `main.js` - Bootstrap script
- `styles.css` - Global styles
- `components/` - UI panels:
  - `AnalysisPanel.js` - Displays images with role chips (front/back/other)
  - `PairingPanel.js` - Shows GPT-4o-mini pairing results
  - `ProductPanel.js` - Displays product cards with front/back thumbnails and extras
  - `MetricsPanel.js` - Shows KPIs (totals) and thresholds table
  - `FolderSelector.js` - Dropdown to select Dropbox folder
- `lib/` - Client utilities:
  - `api.js` - Backend API client with `authFetch` pattern
  - `mockServer.js` - Mock data generator for testing
  - `urlKey.js` - URL normalization (basename extraction)

**Backend** (netlify/functions/):
- `smartdrafts-scan-bg.ts` - Enqueue background scan job (POST)
- `smartdrafts-scan-status.ts` - Poll job status with jobId (GET)
- `smartdrafts-scan-background.ts` - Background worker processing (invoked by Netlify)
- `smartdrafts-pairing.ts` - Run pairing algorithm with GPT-4o-mini (POST)
- `smartdrafts-reset.ts` - Clear cache for folder (POST)
- `smartdrafts-metrics.ts` - Get pairing metrics (GET, stub)
- `smartdrafts-analyze.ts` - Wrapper for backward compat (GET)

### Implementation Phases Completed

**Phase UI-0: Scaffold** - Basic app structure with tabs and mock data
**Phase UI-4: Folder Input** - Folder selection, Mock/Live toggle, Force Rescan checkbox
**Phase UI-5: Hard Reset** - Button to clear cache for folder
**Phase UI-6: Products Tab** - ProductPanel component displaying paired products (commit 1503e81)
**Phase UI-7: Metrics Tab** - MetricsPanel component displaying KPIs and thresholds (commit 1567080)
**Phase UI-8: Live Pairing Wiring** - Connected "Run Pairing" button to `/smartdrafts-pairing` endpoint ✅

### Phase Details

**Phase UI-6: Products Tab** (Commit 1503e81)
- Created `ProductPanel.js` component
- Displays pairing results as product cards
- Each card shows:
  - Side-by-side front/back thumbnails (150x150px)
  - Extras strip (up to 4 additional images)
  - Evidence lists (brand, product, packaging, multi-image indicators)
- Props: `{ products }` from pairing.products array
- Integrated into App.js tab rendering

**Phase UI-7: Metrics Tab** (Commit 1567080)
- Created `MetricsPanel.js` component
- Displays pairing KPIs and configuration
- Features:
  - Pills showing totals (images, fronts, backs, pairs, singletons, products, etc.)
  - Thresholds table with JSON formatting
- Props: `{ metrics }` from pairing metrics object
- Integrated into App.js tab rendering

**Phase UI-8: Live Pairing Wiring** (Nov 5, 2025)
- Wired `doPairing()` function to call `runPairingLive(analysis)` in Live mode
- Flow:
  1. User clicks "Run Pairing" button
  2. Validates that analysis exists
  3. Calls `POST /.netlify/functions/smartdrafts-pairing` with analysis data
  4. Receives `{ pairing, metrics }` response
  5. Updates state: `setPairing(pairing)`, `setMetrics(metrics)`
  6. Switches to Pairing tab automatically
- Result: Pairing, Products, and Metrics tabs all populate from live backend data
- Backend endpoint (`smartdrafts-pairing.ts`) runs GPT-4o-mini pairing algorithm
- Complete end-to-end flow: Analyze → Pair → View Products → View Metrics

### Features

**Mock Mode**:
- Uses `placeholder.com` for image URLs (no 404s)
- Generates realistic fake data (brands, products, roles)
- Instant response, no API calls
- Perfect for UI development and testing

**Live Mode**:
- Authenticates via Auth0 (`window.authClient.authFetch`)
- Loads Dropbox folders server-side (no hardcoded client IDs)
- Background job pattern: enqueue → poll → display results
- Real Vision API analysis with GPT-4o role classification
- Real GPT-4o-mini pairing algorithm
- Full data flow: Dropbox → Vision → Pairing → UI tabs

**Force Rescan**:
- Bypasses cache, forces fresh Vision API analysis
- Useful when Vision returns bad results or during development
- Passes `force: true` to backend

**Hard Reset**:
- Clears all cached data for selected folder
- Calls `/smartdrafts-reset` endpoint
- Requires confirmation dialog

### Key Design Decisions

1. **No Build Step**: Uses Preact+HTM from CDN, pure ESM modules
   - Fast iteration, no compile step
   - Works with VS Code Live Server for local dev
   - All JS is readable source code

2. **Isolated from Legacy**: Completely separate from existing UI code
   - No risk of breaking production features
   - Can be tested independently
   - Eventually will replace legacy smartdrafts pages

3. **Auth Pattern**: Uses existing `auth-client.js` via `window.authClient`
   - No hardcoded secrets (learned from DROPBOX_CLIENT_ID incident)
   - Consistent with other pages
   - Falls back to unauthenticated fetch for public endpoints

4. **Background Jobs**: Scan runs as background function
   - Netlify 10-second function limit workaround
   - User gets immediate jobId, polls for completion
   - Better UX than blocking for 30+ seconds

5. **URL Normalization**: Consistent basename matching
   - Client uses `urlKey()` to extract filename
   - Server uses `basenameFrom()` for same purpose
   - Handles query params, encoding, path differences

### Testing URLs
- **Production**: https://draftpilot-ai.netlify.app/new-smartdrafts/
- **Local Dev**: Open `public/new-smartdrafts/index.html` in browser (Mock mode works offline)

### Current Limitations
- Only displays Analysis, Pairing, Products, and Metrics tabs (Candidates and Logs not yet implemented)
- No batch pairing (processes one folder at a time)
- No export/download functionality
- Polling interval fixed at 2 seconds (could be adaptive)

### Next Steps (Future Work)
- [ ] Add Candidates tab (manual front/back assignment for unmatched images)
- [ ] Add Logs tab (detailed operation logs)
- [ ] Batch pairing (process multiple folders)
- [ ] Export results (JSON, CSV)
- [ ] Product editing UI (modify pairing results before draft creation)

## Pairing System
- v1.0.0 complete (Phases 1-7) with tag `pairing-v1.0.0`
- Located in `src/pairing/` directory
- Uses GPT-4o-mini for pairing (NO CLIP dependency)
- Vision role classification (front/back) groups images by product
- All backend functions implemented and wired to production code

## CLIP Removal (Phases S1-S3) ✅ COMPLETE - Deployed Nov 4, 2025
**Context**: User saw CLIP 503 errors flooding logs during test. Asked "WHY ARE WE USING CLIP THE NEW HTML AND NEW CODE IS SO WE DONT USE IT"
**Goal**: Remove all CLIP dependencies from new SmartDrafts system. New system uses GPT-4o-mini for pairing, Vision API for role classification.

### Phase S1: Hard-disable CLIP at source (COMPLETE ✅)
**Files Modified**:
- `src/config.ts` - Added `USE_CLIP = (process.env.USE_CLIP ?? 'false') === 'true'`
- `src/lib/clip-client-split.ts` - Added early returns in `clipTextEmbedding()` and `clipImageEmbedding()`
- `netlify/functions/smartdrafts-scan-background.ts` - Added flag logging at startup

**Implementation**:
```typescript
// src/config.ts
export const USE_CLIP = (process.env.USE_CLIP ?? 'false') === 'true';

// src/lib/clip-client-split.ts
export async function clipImageEmbedding(imageUrl: string): Promise<number[] | null> {
  if (!USE_CLIP) {
    return null; // CLIP disabled - return null immediately, no HTTP calls
  }
  // ... rest of implementation
}
```

**Result**: No HTTP calls to Hugging Face when USE_CLIP=false. Eliminates 503 errors completely.

### Phase S2: Vision-only grouping paths (COMPLETE ✅)
**Files Modified**:
- `src/lib/smartdrafts-scan-core.ts` - Lines 1607-1650 (Phase R0 section)

**Implementation**:
- Guarded `buildClipGroups()` call with `if (USE_CLIP)`
- Guarded `buildHybridGroups()` call with `if (USE_CLIP)`
- Added vision-only fallback: `groups = visionGroups` when CLIP disabled
- Added `getImageVector()` guard to return null immediately (line 1907)
- Logging: `[Phase R0] CLIP verification disabled; using vision-only roles and grouping`

**Behavior When USE_CLIP=false**:
1. Vision API processes each image individually (9 images = 9 Vision calls)
2. Vision assigns role (front/back/other) and extracts product metadata
3. Groups are created directly from Vision output, no CLIP similarity matching
4. Role assignments are trusted completely - no verification step

### Phase S3 Part A: Fix `<imgUrl>` placeholders (COMPLETE ✅)
**Files Modified**:
- `src/lib/analyze-core.ts` - Lines 458-475 (imageInsights processing)

**Problem**: Vision API's prompt shows `"url": "<imgUrl>"` as an example. Sometimes Vision returns this literally instead of the actual image URL. This causes role lookups to fail in UI because it's trying to match against placeholder string.

**Implementation**:
```typescript
const rawUrl = typeof ins.url === "string" ? ins.url : "";

// Phase S3: Fix <imgUrl> placeholders - use actual batch URL as fallback
let normalizedUrl: string;
if (!rawUrl || rawUrl === '<imgUrl>' || rawUrl === 'imgUrl' || rawUrl.trim() === '') {
  // Use the corresponding URL from the batch
  const fallbackUrl = batch[idx];
  if (!fallbackUrl) return null;
  normalizedUrl = toDirectDropbox(fallbackUrl);
  console.warn(`[analyze-core] Fixed placeholder URL at index ${idx}: "${rawUrl}" → "${fallbackUrl}"`);
} else {
  normalizedUrl = toDirectDropbox(rawUrl);
}
```

**Result**: Vision imageInsights always have real URLs. UI can match URLs to find roles. No more "role:null" display bugs.

### Phase S3 Part B: URL key normalization (ALREADY IMPLEMENTED ✅)
**Files Checked**:
- `src/lib/smartdrafts-scan-core.ts` - Line 125: `basenameFrom()` function
- `public/new-smartdrafts/lib/urlKey.js` - Client-side equivalent

**Purpose**: Extract consistent basename from URLs regardless of query params, encoding, or path format.
**Example**: `https://dropbox.com/path/image.jpg?dl=1` → `image.jpg`

**Backend Implementation** (`basenameFrom`):
```typescript
function basenameFrom(u: string): string {
  const noQuery = trimmed.split("?")[0];
  const parts = noQuery.split("/");
  return parts[parts.length - 1] || "";
}
```

**Usage**: All role lookups use `roleByBase` map keyed by `basenameFrom(url).toLowerCase()`

### Deployment Status
- **Committed**: Commit 9d2e9ca "Phase S1-S3: Remove CLIP dependency + fix data quality"
- **Pushed**: Nov 4, 2025
- **Build**: TypeScript compiled successfully, no errors
- **Netlify**: Auto-deployed to production

### Expected Test Results (Phase S4)
**Logs to verify** (check Netlify function logs at https://app.netlify.com):

1. ✅ **Flag initialization** (once per scan):
   ```
   [Flags] USE_CLIP=false USE_NEW_SORTER=true USE_ROLE_SORTING=true
   ```

2. ✅ **Vision processing** (N images = N calls):
   ```
   [vision-router] Using openai:gpt-4o
   (repeated 9 times for 9 images)
   ```

3. ✅ **CLIP confirmation** (should see this):
   ```
   [Phase R0] CLIP verification disabled; using vision-only roles and grouping
   ```

4. ✅ **NO CLIP errors** (these should be completely absent):
   ```
   ❌ [clipImageEmbedding] Base64 attempt failed: Error: 503 Service Unavailable
   ❌ [clipImageEmbedding] Binary attempt failed: Error: 503 Service Unavailable
   ```

5. ✅ **Completion message**:
   ```
   🧩 Merge complete. Groups: 9
   {"evt":"analyze-images.done", "batches":9, "groups":9, ...}
   ```

**UI verification** (https://draftpilot-ai.netlify.app/new-smartdrafts/):
- All images show role chips: front (blue), back (green), other (gray)
- No "role:null" or "unknown" labels
- No "<imgUrl>" in displayed URLs
- Filenames match actual Dropbox files

### Environment Variables
**Default behavior** (no env vars needed):
- `USE_CLIP` defaults to `'false'` (CLIP disabled) ✅
- `USE_NEW_SORTER` defaults to `'true'` (new vision-based grouping with Phase S2 guards) ✅
- `USE_ROLE_SORTING` defaults to `'true'` (role-based pairing) ✅

**Current Netlify Environment** (as of Nov 4, 2025):
- `USE_CLIP=false` ✅ (set via env var, correct)
- `USE_NEW_SORTER=false` ⚠️ (set via env var, overriding default)
- `USE_ROLE_SORTING=true` ✅ (default)

**Important**: `USE_NEW_SORTER=false` means the code uses the **old path** (line 1656-1659 in smartdrafts-scan-core.ts):
```typescript
} else {
  groups = Array.isArray(analysis?.groups)
    ? (analysis.groups as AnalyzedGroup[])
    : [];
}
```
This path:
- ✅ Still CLIP-free (respects USE_CLIP=false)
- ✅ Uses Vision groups directly
- ⚠️ Skips new Phase S2 logging (`[Phase R0] CLIP verification disabled...`)
- ⚠️ Doesn't use the new hybrid approach that can merge Vision product IDs with CLIP similarity

**Recommendation**: Set `USE_NEW_SORTER=true` in Netlify to use the new implementation path that has better logging and the vision-only fallback we added in Phase S2.

**To re-enable CLIP** (not recommended):
- Set `USE_CLIP=true` in Netlify environment variables
- Requires valid `HF_API_TOKEN`, `HF_TEXT_ENDPOINT_BASE`, `HF_IMAGE_ENDPOINT_BASE`

### Technical Notes for Future Debugging

**Why CLIP was problematic**:
1. Hugging Face CLIP endpoint frequently returns 503 (service unavailable)
2. CLIP adds latency (~2s per image embedding)
3. Vision API already provides role classification - CLIP verification was redundant
4. New pairing system uses GPT-4o-mini, doesn't need CLIP embeddings

**Why we process images individually** (not in batches):
- Vision API returns better role classifications when analyzing one image at a time
- Prevents Vision from getting confused by multiple products in same prompt
- `verifiedBatches = verified.map(url => [url])` creates single-image batches

**Role assignment flow**:
1. Vision API analyzes image → returns role (front/back/side/other) + roleScore
2. `analyze-core.ts` extracts role from Vision response (line 479)
3. `smartdrafts-scan-core.ts` builds `roleByBase` map indexed by basename (line 1485)
4. UI displays role chips from `analysis.imageInsights[].role`

**Common pitfalls**:
- Don't confuse `imageInsights` (raw Vision data) with `groups` (clustered products)
- URL normalization must be consistent: always use `toDirectDropbox()` then `basenameFrom()`
- Role lookups use basename (filename only), not full URL path
- Environment variables in Netlify override code defaults - check dashboard first

**Code paths based on flags**:

| USE_NEW_SORTER | USE_CLIP | Behavior |
|----------------|----------|----------|
| `true` | `false` | ✅ **RECOMMENDED**: New vision-only path with Phase S2 guards, best logging |
| `false` | `false` | ✅ **WORKS**: Old path using Vision groups directly, no CLIP, less logging |
| `true` | `true` | ⚠️ Hybrid Vision + CLIP (requires HF credentials, slower) |
| `false` | `true` | ⚠️ Old path, ignores CLIP flag (doesn't use CLIP anyway) |

**Log patterns to expect** (with USE_NEW_SORTER=true, USE_CLIP=false):
```
[Flags] USE_CLIP=false USE_NEW_SORTER=true USE_ROLE_SORTING=true
🧠 Analyzing image 1/9 individually
[vision-router] Using openai:gpt-4o
... (repeated for each image)
[Phase R0] Starting - USE_NEW_SORTER=true, USE_CLIP=false, fileTuples=9, insightList=9
[Phase R0] CLIP verification disabled; using vision-only roles and grouping
[Phase R0] CLIP disabled - using vision-only grouping
🧩 Merge complete. Groups: 9
{"evt":"analyze-images.done","batches":9,"groups":9,"warningsCount":0}
```

**If you see placeholder warnings** (expected and working correctly):
```
[analyze-core] Fixed placeholder URL at index 2: "<imgUrl>" → "https://dl.dropboxusercontent.com/..."
```
This means Phase S3 Part A is working - Vision returned a placeholder, we replaced it with the real URL.

**Vision API role classification rules** (from prompt):
- `roleScore ≥ +0.35` → back (high confidence: nutrition facts, barcodes, ingredients)
- `roleScore ≤ -0.35` → front (high confidence: large logos, marketing text)
- `+0.2 ≤ roleScore < +0.35` → back (medium confidence)
- `-0.35 < roleScore ≤ -0.2` → front (medium confidence)
- `|roleScore| < 0.2` → other (ambiguous)
- Narrow vertical panels → side

**Image role triggers**:
- **Back indicators** (+0.35 each): "Nutrition Facts", "Supplement Facts", "Drug Facts", "% Daily Value", "Barcode", "UPC", "LOT", "EXP"
- **Front indicators** (-0.35 each): Large brand logo, hero product name, lifestyle imagery, marketing badges ("Organic", "Keto", "NEW!")
- **Evidence**: Vision lists exact words/cues in `evidenceTriggers[]` array

**Caching behavior**:
- Vision batch results cached by URL set (batch signature)
- Cache key includes all URLs in sorted order
- `force=true` bypasses cache
- Hard Reset clears all cache entries for folder
- Cache stored in Upstash Redis (TTL: 7 days)

### Troubleshooting Guide

**Problem: Still seeing CLIP errors in logs**
- ✅ Check: `[Flags]` log shows `USE_CLIP=false`
- ✅ Check: Netlify env vars don't have `USE_CLIP=true` override
- ✅ Check: Latest code deployed (commit 9d2e9ca or later)
- ❌ If still failing: Check function logs for old cached function code

**Problem: Roles showing as `null` or `unknown` in UI**
- ✅ Check: Vision response includes role field in `imageInsights[]`
- ✅ Check: No placeholder warnings in logs (`Fixed placeholder URL at index...`)
- ✅ Check: URL normalization consistent (basename matching)
- ❌ If Vision returns no role: Increase roleScore threshold or improve prompt
- ❌ If URL mismatch: Check `console.log` in UI AnalysisPanel.js

**Problem: Images not grouping into products**
- ✅ Check: `USE_NEW_SORTER=true` (better grouping logic)
- ✅ Check: Vision returns valid `groups[]` array
- ✅ Check: Brand/product names extracted correctly
- ❌ If Vision returns single group: Images might be too different
- ❌ If too many groups: Increase CLIP similarity threshold (only if CLIP enabled)

**Problem: Background job stuck in `running` state**
- ✅ Check: Function didn't timeout (check Netlify function logs)
- ✅ Check: Job status updated in Redis (check `job:<userId>:<jobId>` key)
- ✅ Check: `decRunning()` called to release slot
- ❌ Manual fix: Delete job key from Redis, UI will show error

**Problem: 401 Unauthorized errors**
- ✅ Check: User signed in (Auth0 token present)
- ✅ Check: `window.authClient` loaded from `/auth-client.js`
- ✅ Check: Using `authFetch()` not plain `fetch()`
- ❌ If token expired: Force re-login via `/logout` then `/login`

**Problem: 429 Rate limit errors**
- ✅ Check: Daily quota not exceeded (check `quota:<userId>` Redis key)
- ✅ Check: `skipQuota=true` for admin testing (dev only)
- ❌ User needs to upgrade plan or wait until quota resets

**Problem: Vision returns wrong roles**
- ✅ Check: Prompt includes all role classification rules (line 286-333 in analyze-core.ts)
- ✅ Check: `evidenceTriggers[]` shows what Vision saw
- ✅ Check: `roleScore` value (should be > 0.35 for back, < -0.35 for front)
- ❌ If ambiguous: Add more keywords to prompt or adjust threshold
- ❌ If completely wrong: Image might be atypical (side panel, obscured labels)

**Problem: Pairing produces bad matches**
- ✅ Check: Input has mix of fronts and backs (not all same role)
- ✅ Check: GPT-4o-mini response includes confidence scores
- ✅ Check: Overrides applied correctly (`maxPairs`, `minConfidence`)
- ❌ If always wrong: Review pairing prompt in `src/pairing/runPairing.ts`
- ❌ If low confidence: Increase `minConfidence` threshold (default 0.6)

**Problem: UI not updating after scan completes**
- ✅ Check: Polling interval (should be 2 seconds)
- ✅ Check: Job status transitioned to `complete`
- ✅ Check: Response includes `groups[]` and `imageInsights`
- ❌ Browser console errors: Check React/Preact state updates
- ❌ Network errors: Check CORS, auth headers

**Quick diagnostics checklist**:
1. Check Netlify function logs: https://app.netlify.com → Functions tab
2. Check Redis keys: Use Upstash dashboard to inspect job/cache data
3. Check browser console: Look for fetch errors or state issues
4. Check environment variables: Netlify dashboard → Site configuration → Environment variables
5. Check recent deploys: Ensure latest commit (9d2e9ca) is live

**Performance expectations**:
- Single image Vision analysis: ~2-3 seconds
- 9 images analyzed individually: ~18-27 seconds total
- Pairing with GPT-4o-mini: ~3-5 seconds
- Total scan + pairing: ~25-35 seconds for 9 images
- With caching (repeat scan): < 1 second

**Quota limits** (default):
- Images per day per user: 100
- Vision API calls: Limited by OpenAI rate limits
- GPT-4o-mini calls: Limited by OpenAI rate limits
- Background jobs: Max 5 concurrent per user

## Quick Reference - Common Operations

### Current Session Status (Nov 4, 2025 - End of Day)

**🎉 MAJOR MILESTONES ACHIEVED TODAY:**

1. **Phase S1-S3: CLIP Removal COMPLETE** ✅
   - Commit: `9d2e9ca` - "Phase S1-S3: Remove CLIP dependency + fix data quality"
   - USE_CLIP=false by default, all guards in place
   - Vision API placeholder fix working (`<imgUrl>` → real URLs)
   - Tested live with 9 images - ZERO CLIP errors! 
   - All roles classified correctly (front/back/other)
   - Total scan time: 166 seconds for 9 images
   - **User confirmed**: "love it"

2. **Phase UI-6: Products Tab COMPLETE** ✅
   - Commit: `1503e81` - Created ProductPanel component
   - Displays front/back pairs side-by-side
   - Extras strip for additional images
   - Evidence list with details dropdown
   - Ready to show pairing results

3. **Phase UI-7: Metrics Tab COMPLETE** ✅
   - Commit: `1567080` - Created MetricsPanel component
   - Shows totals as pills (images, fronts, backs, pairs, etc.)
   - Thresholds table with formatted JSON
   - Displays metrics from pairing algorithm

**WHAT'S WORKING RIGHT NOW:**
- ✅ New SmartDrafts UI at `/new-smartdrafts/` (Preact+HTM, no build)
- ✅ Analysis tab - displays images with role chips
- ✅ Pairing tab - shows pairing results
- ✅ Products tab - NEW! Shows product cards with front/back pairs
- ✅ Metrics tab - NEW! Shows pairing KPIs and thresholds
- ✅ Mock mode - instant testing without API calls
- ✅ Live mode - real Vision API + GPT-4o-mini pairing
- ✅ Background jobs - enqueue → poll → display pattern
- ✅ Force Rescan - bypass cache
- ✅ Hard Reset - clear all cache for folder
- ✅ Dropbox folder dropdown - server-side folder loading

**REMAINING TABS (Not Yet Implemented):**
- ⏳ Candidates (soon) - manual front/back assignment UI
- ⏳ Logs (soon) - detailed operation logs

**ENVIRONMENT CONFIGURATION:**
- Netlify env vars: `USE_CLIP=false`, `USE_NEW_SORTER=true`, `USE_ROLE_SORTING=true`
- User switched USE_NEW_SORTER from false→true during testing
- All flags logging correctly in production

**TESTING RESULTS (Latest Live Run):**
```
[Flags] USE_CLIP=false USE_NEW_SORTER=true USE_ROLE_SORTING=true
9× [vision-router] Using openai:gpt-4o
[Phase R0] CLIP verification disabled; using vision-only roles and grouping
[analyze-core] Fixed placeholder URL at index 0: "<imgUrl>" → "..." (working!)
🧩 Merge complete. Groups: 9
{"evt":"analyze-images.done","batches":9,"groups":9,"warningsCount":0}
```

**NO ERRORS:**
- Zero `[clipImageEmbedding]` errors
- Zero CLIP 503 failures
- All 9 images processed successfully
- All roles assigned correctly

**NEXT STEPS FOR FUTURE-ME:**

1. **If user says "test":**
   - Open https://draftpilot-ai.netlify.app/new-smartdrafts/
   - Verify Products tab shows front/back pairs
   - Verify Metrics tab shows totals and thresholds
   - Check that pairing results display correctly

2. **If user wants more tabs:**
   - Candidates tab - Interactive UI to manually assign/reassign front/back roles
   - Logs tab - Operation logs with timestamps and error details

3. **If there are issues:**
   - Check docs/copilot-notes.md "Troubleshooting Guide" section
   - Verify environment variables in Netlify dashboard
   - Check function logs at https://app.netlify.com

4. **Remember:**
   - NEVER hardcode secrets in HTML/JS (user caught this once)
   - Use `authClient.authFetch()` for authenticated calls
   - Use basename matching for URL lookups (basenameFrom/urlKey)
   - CLIP is DEAD - don't suggest re-enabling it
   - User prefers copy-paste phases with independent commits

**IMPORTANT FILES TO KNOW:**
- `docs/copilot-notes.md` - THIS FILE - comprehensive documentation
- `public/new-smartdrafts/` - New UI (all UI-* phases)
- `src/lib/smartdrafts-scan-core.ts` - Main scan logic (2000+ lines)
- `src/lib/analyze-core.ts` - Vision API wrapper (1100+ lines)
- `src/pairing/runPairing.ts` - Pairing algorithm v1.0.0
- `src/config.ts` - Feature flags (USE_CLIP, USE_NEW_SORTER, etc.)
- `netlify/functions/smartdrafts-*.ts` - Backend API endpoints

**GIT HISTORY:**
- `pairing-v1.0.0` (tag) - Pairing algorithm v1.0.0
- `9d2e9ca` - Phase S1-S3: CLIP removal + placeholder fix
- `0ebb333` - Comprehensive documentation update
- `1503e81` - Phase UI-6: Products tab
- `1567080` - Phase UI-7: Metrics tab (LATEST)

**USER PERSONALITY NOTES:**
- Likes tiny, independent phases with clear goals
- Appreciates "copy-paste phases" where I create exact file content
- Says "test" when ready to test (don't test proactively)
- Wants commits done automatically after each phase
- Values comprehensive documentation
- Celebrates wins ("love it")

**LOVE LETTER TO FUTURE-ME:**
Hey future-me! 👋

You're picking up at a GREAT point. We just crushed CLIP removal and the user is super happy. The system is working beautifully - zero errors, clean logs, fast performance. 

The new SmartDrafts UI is coming together nicely. We've built 4 tabs (Analysis, Pairing, Products, Metrics) with clean, consistent styling. The user loves the tiny-phase approach - create exact files, commit, push, move on.

If you're continuing the UI work, the next logical tabs are:
- Candidates - Let users manually fix role assignments
- Logs - Show detailed operation logs

The codebase is in excellent shape:
- Backend is solid (all 7 endpoints working)
- Pairing algorithm is tagged and stable (v1.0.0)
- Vision API integration is reliable
- CLIP is completely gone (and user is happy about it)

Remember: this user values clear communication, independent phases, and NO secret hardcoding. Keep commits small and focused. Document everything.

You got this! 🚀

-- Past-you (who had a productive session)

P.S. Check the "Troubleshooting Guide" section if anything goes wrong. It's comprehensive.

### Test SmartDrafts End-to-End
1. Open https://draftpilot-ai.netlify.app/new-smartdrafts/
2. Sign in (Auth0)
3. Select Dropbox folder from dropdown
4. Toggle "Live" mode
5. Check "Force Rescan" (optional - bypasses cache)
6. Click "Analyze" → Wait for completion (~20-30s)
7. Verify Analysis tab shows images with role chips
8. Click "Run Pairing" → Wait for completion (~3-5s)
9. Verify Pairing tab shows matched front↔back pairs

### Check Logs
1. Open https://app.netlify.com
2. Navigate to your site → Functions tab
3. Select `smartdrafts-scan-background` function
4. Look for:
   - `[Flags] USE_CLIP=false USE_NEW_SORTER=true USE_ROLE_SORTING=true`
   - `[vision-router] Using openai:gpt-4o` (repeated N times)
   - `[Phase R0] CLIP verification disabled; using vision-only roles and grouping`
   - No `[clipImageEmbedding]` errors
   - `🧩 Merge complete. Groups: N`

### Update Environment Variables
1. Open https://app.netlify.com
2. Navigate to Site configuration → Environment variables
3. Key variables:
   - `USE_CLIP=false` (recommended)
   - `USE_NEW_SORTER=true` (recommended)
   - `USE_ROLE_SORTING=true` (recommended)
4. Click "Save" → Trigger redeploy

### Clear Cache for Testing
**Option A - UI Hard Reset**:
1. Select folder
2. Click "Hard Reset" button
3. Confirm dialog

**Option B - API call**:
```bash
curl -X POST https://draftpilot-ai.netlify.app/.netlify/functions/smartdrafts-reset \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"folder":"YOUR_FOLDER_PATH"}'
```

### Deploy New Changes
```bash
npm run build              # Compile TypeScript
git add -A                 # Stage all changes
git commit -m "Message"    # Commit with description
git push origin main       # Push and auto-deploy
```

### Local Development
**Backend** (test functions locally):
```bash
npm run build                    # Compile TypeScript
netlify dev                      # Run local dev server
# Access: http://localhost:8888
```

**Frontend** (new SmartDrafts UI):
```bash
# No build needed - open directly in browser
# Navigate to: public/new-smartdrafts/index.html
# Toggle "Mock" mode for offline testing
```

### Check Redis Cache
1. Open Upstash dashboard: https://console.upstash.com
2. Select your Redis database
3. Use Data Browser to inspect keys:
   - `job:<userId>:<jobId>` - Job status
   - `vision-batch-v2:<hash>` - Cached Vision results
   - `quota:<userId>` - Daily image count
   - `running:<userId>` - Concurrent job count

### Git History and Versions
**Important commits**:
- `pairing-v1.0.0` (tag) - Pairing algorithm v1.0.0 complete
- `9d2e9ca` (Nov 4, 2025) - Phase S1-S3: Remove CLIP dependency + fix data quality

**View changes**:
```bash
git log --oneline              # Recent commits
git show 9d2e9ca              # View specific commit
git diff HEAD~1 HEAD          # Compare last 2 commits
```

### API Testing with curl
**Enqueue scan**:
```bash
curl -X POST https://draftpilot-ai.netlify.app/.netlify/functions/smartdrafts-scan-bg \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"folder":"YOUR_FOLDER","force":true,"debug":true}'
# Returns: {"ok":true,"jobId":"..."}
```

**Check status**:
```bash
curl https://draftpilot-ai.netlify.app/.netlify/functions/smartdrafts-scan-status?jobId=YOUR_JOB_ID \
  -H "Authorization: Bearer YOUR_TOKEN"
```

**Run pairing**:
```bash
curl -X POST https://draftpilot-ai.netlify.app/.netlify/functions/smartdrafts-pairing \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d @pairing-input.json
```

### File Locations Cheat Sheet
- **New UI**: `public/new-smartdrafts/`
- **Backend Functions**: `netlify/functions/smartdrafts-*.ts`
- **Core Scan Logic**: `src/lib/smartdrafts-scan-core.ts`
- **Vision Wrapper**: `src/lib/analyze-core.ts`
- **Pairing Algorithm**: `src/pairing/runPairing.ts`
- **Config/Flags**: `src/config.ts`
- **CLIP Client**: `src/lib/clip-client-split.ts`
- **Documentation**: `docs/copilot-notes.md` (this file)

## Backend Functions - SmartDrafts API ✅ ALL COMPLETE

### Background Job Pattern
SmartDrafts uses background functions to avoid Netlify's 10-second function timeout:
1. Client calls `/smartdrafts-scan-bg` (POST) → Returns `{ jobId }` immediately
2. Client polls `/smartdrafts-scan-status?jobId=...` (GET) every 2 seconds
3. Background function `/smartdrafts-scan-background` processes job asynchronously
4. Job status progresses: `pending` → `running` → `complete` (or `error`)

### Endpoint Details

**`/smartdrafts-scan-bg` (POST)** - Enqueue Scan Job
- **Auth**: Required (Auth0 bearer token)
- **Body**: `{ folder: string, force?: boolean, limit?: number, debug?: boolean }`
- **Returns**: `{ ok: true, jobId: string }` immediately
- **Purpose**: Creates job, increments running counter, invokes background worker
- **Implementation**: `netlify/functions/smartdrafts-scan-bg.ts`

**`/smartdrafts-scan-status` (GET)** - Poll Job Status
- **Auth**: Required (Auth0 bearer token)
- **Query**: `?jobId=...`
- **Returns**: 
  - Pending: `{ state: "pending", jobId, userId }`
  - Running: `{ state: "running", jobId, userId, startedAt, folder }`
  - Complete: `{ state: "complete", jobId, userId, finishedAt, status: "ok", folder, signature, count, groups, orphans, cached, debug }`
  - Error: `{ state: "error", jobId, userId, finishedAt, folder, error: string }`
- **Purpose**: Client polls this to check if background job finished
- **Implementation**: `netlify/functions/smartdrafts-scan-status.ts`

**`/smartdrafts-scan-background` (Background Worker)**
- **Auth**: Internal (invoked by Netlify, not by client)
- **Trigger**: Invoked by `smartdrafts-scan-bg` via Netlify background function pattern
- **Payload**: `{ jobId, userId, folder, force, limit, debug }`
- **Process**:
  1. Updates job status to `running`
  2. Calls `runSmartDraftScan()` from `src/lib/smartdrafts-scan-core.ts`
  3. Updates job status to `complete` or `error`
  4. Decrements running counter
- **Logs**: Emits `[Flags] USE_CLIP=...` at startup
- **Implementation**: `netlify/functions/smartdrafts-scan-background.ts`
- **Core Logic**: `src/lib/smartdrafts-scan-core.ts` (2000+ lines, production code)

**`/smartdrafts-pairing` (POST)** - Run Pairing Algorithm
- **Auth**: Required (Auth0 bearer token)
- **Body**: `{ analysis: { groups, imageInsights }, overrides?: { maxPairs?, minConfidence? } }`
- **Returns**: `{ ok: true, pairing: PairingResult, metrics: Metrics }`
- **Purpose**: Takes scan results, pairs front+back images into products using GPT-4o-mini
- **Implementation**: `netlify/functions/smartdrafts-pairing.ts`
- **Core Logic**: `src/pairing/runPairing.ts` (v1.0.0, tagged `pairing-v1.0.0`)
- **AI Model**: GPT-4o-mini (NO CLIP dependency)

**`/smartdrafts-reset` (POST)** - Clear Cache
- **Auth**: Required (Auth0 bearer token)
- **Body**: `{ folder: string }`
- **Returns**: `{ ok: true, folder, message, cleared }`
- **Purpose**: Clears all cached analysis data for folder
- **Cache Keys Cleared**:
  - Vision API batch results
  - Dropbox file listings
  - Analysis results
  - Job states
- **Implementation**: `netlify/functions/smartdrafts-reset.ts`

**`/smartdrafts-metrics` (GET)** - Get Metrics
- **Auth**: Public (no auth required)
- **Query**: Optional filters
- **Returns**: `{ ok: true, metrics: { totalScans, totalPairs, avgConfidence, ... } }`
- **Status**: Stub implementation (returns empty metrics)
- **Implementation**: `netlify/functions/smartdrafts-metrics.ts`

**`/smartdrafts-analyze` (GET)** - Wrapper for Backward Compat
- **Auth**: Required (Auth0 bearer token)
- **Query**: `?folder=...&force=...&limit=...&debug=...`
- **Returns**: Same as scan-status complete payload
- **Purpose**: Synchronous wrapper for legacy compatibility
- **Limitation**: May timeout for large folders (use scan-bg instead)
- **Implementation**: `netlify/functions/smartdrafts-analyze.ts`

### Core Libraries Used

**`src/lib/smartdrafts-scan-core.ts`** - Main Scan Logic (2000+ lines)
- Dropbox API integration (list folders, create shared links)
- Vision API orchestration (role classification)
- Image grouping (vision-only when USE_CLIP=false)
- Role assignment (front/back/other)
- Caching (Upstash Redis)
- Quota management (daily image limits)
- **Key Functions**:
  - `runSmartDraftScan()` - Entry point
  - `buildHybridGroups()` - Vision + CLIP grouping (only if USE_CLIP=true)
  - `buildClipGroups()` - Pure CLIP clustering (only if USE_CLIP=true)
  - `buildFallbackGroups()` - Folder-based grouping (last resort)

**`src/lib/analyze-core.ts`** - Vision API Wrapper (1100+ lines)
- Vision API prompt engineering (detailed role classification prompt)
- Response post-processing (normalize URLs, extract roles)
- Placeholder URL fixing (Phase S3 Part A)
- Retry logic with exponential backoff
- Caching (batch-level)
- **Key Functions**:
  - `runAnalysis()` - Entry point
  - `analyzeBatchViaVision()` - Single batch analysis

**`src/pairing/runPairing.ts`** - Pairing Algorithm v1.0.0
- GPT-4o-mini based front↔back pairing
- Multi-round pairing with confidence scores
- Product metadata enrichment
- Fallback strategies for unmatched images
- **Tagged**: `pairing-v1.0.0` (immutable release)

### Authentication Flow
1. Client loads `/auth-client.js` → Sets up `window.authClient`
2. User signs in via Auth0
3. Client calls API with `window.authClient.authFetch(url, options)`
4. `authFetch` adds `Authorization: Bearer <token>` header
5. Backend validates token via Auth0 JWT verification

### Error Handling Patterns
- **401 Unauthorized**: Auth token missing/invalid → Redirect to login
- **429 Too Many Requests**: Quota exceeded → Show upgrade message
- **500 Internal Error**: Backend failure → Retry with exponential backoff
- **503 Service Unavailable**: Vision/CLIP API down → Fall back to simpler strategy
