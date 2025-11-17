# Recent Work - November 2025

## Summary
Major rebrand from GPTListing to **DraftPilot**, local file upload feature, **visual-first image pairing system** (92%+ pair rate), and **Phase 1 Vision concurrency groundwork**.

---

## ⚡ Vision Concurrency Phase 1 (November 17, 2025)

### Goal
Speed up SmartDrafts Vision analysis by running multiple single-image calls in parallel while keeping image quality, pairing behavior, and eBay outputs unchanged.

### Code Changes
- Added `VISION_CONCURRENCY` env-driven constant (default **1**) in `src/lib/analyze-core.ts`.
- Implemented `runWithConcurrency()` helper for controlled parallelism.
- Refactored the Vision loop to use concurrency while preserving per-image logging/order.
- Added timing logs:
  - `[vision] Starting analysis for N images with concurrency=X`
  - `[vision] Completed analysis for N images in Yms (concurrency=X)`

### Testing Instructions

**Option A – Netlify Preview (safer)**
1. Push branch: `git push origin feat/vision-concurrency-phase1`.
2. Netlify generates preview: `https://deploy-preview-XYZ--draftpilot-ai.netlify.app`.
3. Visit `/new-smartdrafts/`, select `testDropbox/newStuff`, click **Analyze** (no Force Rescan).
4. Observe elapsed time vs. production; check logs for the new `[vision]` start/complete lines.

**Option B – Production with feature flag**
1. Merge branch with `VISION_CONCURRENCY` defaulting to **1** (no behavior change).
2. In Netlify env vars, set `VISION_CONCURRENCY=4` and redeploy.
3. Run `/new-smartdrafts/` on production with `testDropbox/newStuff`.
4. Verify:
   - Logs show concurrency level and duration.
   - Total Vision time drops well below prior ~10 minutes.
5. If issues appear, revert env value to **1** (no code change needed).

**Acceptance Criteria**
- Same number of detected products/pairs as before (no behavior drift).
- Vision URLs/resolution untouched; high-res images still sent to eBay.
- Setting `VISION_CONCURRENCY=1` restores fully serial behavior.
- Concurrency >1 yields faster end-to-end Vision time on the 26-image dataset.

---

## 🎯 Visual-First Image Pairing (November 15-17, 2025)

### Problem
SmartDrafts pairing system was only matching 8 out of 13 products (62%). User frustration: "my 2 year old can match green rectangles - why can't this system match by visual appearance?"

### Root Causes
1. **Netlify UI using OLD Z2 bucket system** instead of NEW runPairing() - **FIXED**
2. **Text-biased scoring** - Brand matching got +7 points, visual only +1.5 - **FIXED**
3. **Role mislabeling** - Vision API labeled some backs as `role="other"` - **FIXED**
4. **Candidate pool too small** - K=4 filtered out visual-only matches - **FIXED**

### Solution: Visual-First Approach

**Reprioritized scoring to match by appearance first, text second**:

**Visual Scoring** (Primary):
- Packaging match (bottle+bottle, box+box): **+3 points** (was +1)
- Exact color match (white+white, navy+navy): **+2.5 points** (was +0.5)
- Close color match (blue vs light-blue): **+2 points** (was +0.5)
- **Total visual max**: 5.5 points (was 1.5)

**Text Penalties Reduced**:
- Empty brand: **-0.5** (was -3) - allows visual to compensate
- Role="other": **-0.5** (was cap at 0.6) - captures mislabeled backs

**Other Improvements**:
- **Role="other" inclusion**: Changed back filters to include `role === 'back' || role === 'other'`
- **Candidate pool K=8**: Increased from 4 to show top 8 candidates per front (62% of backs vs 31%)
- **Color normalization**: "light-blue" matches "blue", "dark-amber" matches "amber"
- **Performance optimization**: Eliminated double scoring (50% faster, 15-22s execution)
- **Hallucination prevention**: Track auto-paired fronts, filter analysis to GPT-needing fronts only

### Results

**Before fixes**: 8/13 pairs (62%), many wrong pairs (RKMD→RYSE, maude→ROOT)

**After fixes**: 12/13 pairs (92.3%) ✅
- 11 auto-pairs (visual+text strong signals)
- 1 GPT pair (tiebreaker for ambiguous case)
- 0 wrong pairs
- **Notable**: Prequel navy box auto-paired with score 3.0 on visual alone despite empty brand and role="other"

**Expected with K=8 fix**: 13/13 pairs (100%) 🎯
- ROOT Vita white bottle (143446→143458) should now match via visual similarity

### Files Modified

**Scoring & Matching**:
- `src/prompt/pairing-prompt.ts` - Visual-first scoring rules (packaging +3, color +2.5)
- `src/pairing/candidates.ts` - Role="other" inclusion, K=8 default, color normalization
- `src/pairing/metrics.ts` - Count "other" role as backs
- `src/pairing/runPairing.ts` - Hallucination prevention, performance optimization

**Integration**:
- `netlify/functions/smartdrafts-pairing.ts` - Integration with new runPairing system
- `scripts/test-pairing-local.ts` - Local testing without deployment
- `scripts/test-pairing-from-redis.ts` - Test with live Redis cache

### Key Commits
- `ba65ff7` (Nov 17) - Increase candidate pool K=4→K=8 for visual-only matching
- `2078d7c` (Nov 17) - Prioritize visual similarity over text (packaging+color boost)
- `5967483` (Nov 16) - Filter analysis to GPT-needing fronts only (hallucination fix)
- `75a9801` (Nov 16) - Track auto-paired fronts to prevent GPT re-pairing
- `0e5e377` (Nov 16) - Eliminate double scoring (50% performance boost)
- `6e4c118` (Nov 16) - Replace Z2 logic with runPairing() in Netlify UI
- `49f2dd9` (Nov 15) - Add color matching and role override
- `56d5dbc` (Nov 15) - Add distributor rescue for brand mismatches

### Configuration

New environment variable for candidate pool tuning:
```bash
PAIR_CANDIDATE_K=8         # Top K candidates per front (default 8, was 4)
```

**Tuning Guidelines**:
- **K=4**: Fast, works when text+brand signals are strong (31% of backs)
- **K=8** (current): Better for visual-only matches, mixed brands (62% of backs)
- **K=12+**: Large datasets with many similar products or weak text signals

### Testing

**Local Testing** (no deployment needed):
```powershell
# Using existing test data
npx tsx scripts/test-pairing-local.ts analysis.json

# Or test with live Redis cache
npx tsx scripts/test-pairing-from-redis.ts
```

**Via UI**:
1. SmartDrafts → Force Rescan
2. Click "Pair Images" button
3. Verify pair count and check for singletons

### Documentation Updated
- `docs/PAIRING-SYSTEM.md` - Added visual-first section, K=8 tuning guidelines
- `HANDOFF-NOTE-2025-11-17.md` - Comprehensive handoff for next Claude session

---

## 🎨 Rebrand: GPTListing → DraftPilot

### What Changed
- **App Name**: GPTListing → DraftPilot
- **Domain**: ebaywebhooks.netlify.app → draftpilot-ai.netlify.app
- **Logo**: Added to `public/logo/` folder
  - `DraftPilot_Logo.png` (with background)
  - `DraftPilot_NoBG.png` (transparent background)

### Files Updated

**User-Facing Pages** (HTML titles and text):
- `public/index.html` - Title: "DraftPilot – Connect"
- `public/welcome.html` - Header: "Welcome to DraftPilot"
- `public/setup.html` - All references to GPTListing → DraftPilot
- `public/policy-create.html` - Title updated
- `public/policies.html` - Title updated
- `public/policies-manage.html` - Title updated
- `public/location.html` - Title updated

**Configuration**:
- `netlify-env.json`:
  - `ALLOWED_ORIGINS`: draftpilot-ai.netlify.app
  - `APP_URL`: draftpilot-ai.netlify.app
  - `DROPBOX_REDIRECT_URI`: draftpilot-ai.netlify.app
  - `EBAY_ENDPOINT_URL`: draftpilot-ai.netlify.app

**Backend Functions** (fallback URLs):
- `netlify/functions/analyze-images-bg-user.ts`
- `netlify/functions/analyze-images-bg.ts`
- `netlify/functions/ebay-fetch-all-categories.ts`
- `netlify/functions/ebay-fetch-categories-background.ts`
- `netlify/functions/smartdrafts-create-drafts-bg.ts`
- `netlify/functions/smartdrafts-scan-bg.ts`
- `src/lib/openai.ts` - User-Agent header

**Test Scripts**:
- `scripts/test-smartdrafts-endpoints.ts`
- `scripts/test-create-drafts.ts`
- `test-pairing-direct.mjs`

**Documentation**:
- All docs in `docs/` folder updated with new domain
- `docs/copilot-notes.md` - Primary domain reference updated

**Local Storage Keys**:
- `index.html`: `draftpilotVisitedSetup`, `draftpilotSuppressSetupRedirect`
- `setup.html`: `draftpilotVisitedSetup`

### External Services That Need Updating ⚠️

**CRITICAL - These must be updated for OAuth to work:**

1. **eBay Developer App** (https://developer.ebay.com/my/auth/)
   - Redirect URI: `https://draftpilot-ai.netlify.app/login.html`
   - Logout URI: `https://draftpilot-ai.netlify.app/`

2. **Dropbox App** (https://www.dropbox.com/developers/apps)
   - Redirect URI: `https://draftpilot-ai.netlify.app/.netlify/functions/dropbox-oauth-callback`

3. **Auth0** (https://manage.auth0.com/)
   - Allowed Callback URLs: `https://draftpilot-ai.netlify.app/login.html`
   - Allowed Logout URLs: `https://draftpilot-ai.netlify.app/`
   - Allowed Web Origins: `https://draftpilot-ai.netlify.app`

4. **Netlify Site Settings**
   - Site name changed from `ebaywebhooks` to `draftpilot-ai`

### Commits
- `a903014` - rebrand: Update app name from GPTListing to DraftPilot
- `3a8aeb2` - config: Update domain to draftpilot-ai.netlify.app
- `c42f306` - docs: Update remaining domain references to draftpilot-ai.netlify.app
- `cca76d4` - assets: Add DraftPilot logo without background

---

## 📤 Local File Upload Feature

### Overview
Implemented local file upload capability on Quick List page to bypass Dropbox requirement. Users can now upload photos directly from their computer.

### Architecture

**Storage**: AWS S3
- Bucket: `ebay-drafts-staging` (us-east-2)
- Environment variables:
  - `STORAGE_REGION` (not AWS_* to avoid Netlify conflicts)
  - `STORAGE_ACCESS_KEY_ID`
  - `STORAGE_SECRET_ACCESS_KEY`
- Signed URLs: 24-hour expiration
- File retention: 72 hours (no auto-cleanup yet - future enhancement)

**Upload Flow**:
1. User selects/drags files in browser
2. Files converted to base64
3. Smart batching: 4MB per batch, large files (>4MB) upload alone
4. Netlify function (`ingest-local-upload`) → S3
5. Returns: `{ files: [{ key, name, stagedUrl }] }`
6. Auto-redirects to vision scan with jobId

**Vision Integration**:
- `smartdrafts-scan-bg` accepts `stagedUrls` parameter (in addition to Dropbox `path`)
- Vision API scans uploaded files using signed URLs
- Returns groups with product detection
- Full pipeline: Upload → Scan → Pair → Drafts

### Key Files

**Backend**:
- `netlify/functions/ingest-local-upload.ts` - S3 upload with signed URL generation
- `netlify/functions/smartdrafts-scan-bg.ts` - Accepts `stagedUrls` parameter
- `src/lib/smartdrafts-scan-core.ts` - `runSmartDraftScanFromStagedUrls()` implementation

**Frontend**:
- `public/upload-local.html` - Standalone upload page with drag-drop UI
- `public/quick-list.html` - **Revamped with local upload as primary method**
- `public/smartdrafts-dropbox.html` - Auto-poll with jobId parameter

### Quick List Page Updates

**UI Changes**:
- Tabbed interface: "Upload Files" (primary) vs "Dropbox Folder" (secondary)
- Drag & drop area with file previews
- Thumbnail display (80x80px) with individual remove buttons
- File size limit: 4MB each (updated from misleading 10MB)
- "Start Quick List" button (was broken, now fixed)

**Bug Fixes**:
- **Duplicate button ID issue** (commit `caea2ed`):
  - Had TWO buttons with `id="btnStart"` (lines 407 and 474)
  - First button had no onclick handler
  - Removed duplicate, added onclick to correct button
- **File count in button text** (commit `ce45c2b`):
  - User requested removal of file count from button
  - Now just says "🚀 Start Quick List"
- **Progress percentage instead of time** (commit `ce45c2b`):
  - Changed from "Analyzing... (4.5s)" to "Analyzing... 15%"
  - User didn't want people timing the process
  - Percentage based on polling attempts (capped at 95%)

**JavaScript Functions**:
- `switchUploadMethod(method)` - Toggle between local/Dropbox tabs
- `uploadFilesInBatches(files)` - Smart batching with 4MB limit
- `startPipeline()` - Unified handler for both upload methods
- `renderFileList()` - Display thumbnails with remove buttons
- `removeFile(index)` - Remove individual file from selection

### Technical Details

**Smart Batching**:
```javascript
// Group files by size
if (file.size > 4 * 1024 * 1024) {
  largeBatches.push([file]); // Upload alone
} else {
  // Add to current batch if fits, else start new batch
  if (currentSize + file.size <= 4 * 1024 * 1024) {
    currentBatch.push(file);
  } else {
    batches.push(currentBatch);
    currentBatch = [file];
  }
}
```

**Signed URL Generation** (ingest-local-upload.ts):
```typescript
import { GetObjectCommand, getSignedUrl } from '@aws-sdk/s3-request-presigner';

const signedUrl = await getSignedUrl(
  s3Client, 
  new GetObjectCommand({ Bucket, Key }), 
  { expiresIn: 86400 } // 24 hours
);
```

**Image Deduplication** (smartdrafts-scan-core.ts):
```typescript
const uniqueImages = Array.from(new Set(
  group.images.map(url => httpsByKey.get(urlKey(url)) || url)
));
```

### Testing Results
- ✅ Upload → S3 storage working
- ✅ Signed URLs accessible by Vision API
- ✅ Full pipeline tested: Upload → Scan → Groups (9 products detected)
- ✅ Duplicate images removed from groups
- ✅ Auto-redirect and polling working
- ⏳ Mobile testing pending

### Known Issues
- **Analyze sometimes hangs**: User reported scan running indefinitely (need more details)
  - Polling timeout: 80 attempts × 1.5s = 2 minutes max
  - Should show error after timeout, but user saw it run longer
  - Need to investigate: backend stuck or frontend polling issue?

### Future Enhancements
- [ ] S3 lifecycle policy for automatic file deletion after 72 hours
- [ ] Image compression/resizing for files >4MB
- [ ] Better error handling for stuck scans
- [ ] Cancel button for long-running operations
- [ ] Support for >2 images per product (user mentioned future feature)
- [ ] Mobile optimization

### Commits
- `418307d` - feat: Revamp quick-list with local upload as primary method
- `caea2ed` - fix: Remove duplicate Start button and add onclick handler
- `ce45c2b` - feat: Replace elapsed time with progress percentage
- `48a68e4` - fix: Update file size limit text to 4MB on quick-list

---

## 🔧 Environment Variables Reference

### Storage (AWS S3)
```bash
STORAGE_REGION=us-east-2
STORAGE_ACCESS_KEY_ID=<your-key>
STORAGE_SECRET_ACCESS_KEY=<your-secret>
```

### eBay
```bash
EBAY_CLIENT_ID=<your-client-id>
EBAY_CLIENT_SECRET=<your-client-secret>
EBAY_ENV=PROD
EBAY_ENDPOINT_URL=https://draftpilot-ai.netlify.app/.netlify/functions/ebay-mad
```

### Dropbox
```bash
DROPBOX_CLIENT_ID=<your-client-id>
DROPBOX_CLIENT_SECRET=<your-client-secret>
DROPBOX_REDIRECT_URI=https://draftpilot-ai.netlify.app/.netlify/functions/dropbox-oauth-callback
```

### App Config
```bash
APP_URL=https://draftpilot-ai.netlify.app
ALLOWED_ORIGINS=https://draftpilot-ai.netlify.app,https://www.draftpilot-ai.netlify.app
AUTH_MODE=mixed
```

### OpenAI
```bash
OPENAI_API_KEY=<your-key>
GPT_MODEL=gpt-4o-mini
```

---

## 📝 Next Session Priorities

1. **Test OAuth flows** - Verify eBay/Dropbox/Auth0 work with new domain
2. **Debug analyze hang issue** - User reported it running indefinitely
3. **Add logo to UI** - Logos are ready but not integrated into pages yet
4. **S3 lifecycle policy** - Automate file cleanup after 72 hours
5. **Test Quick List end-to-end** - Upload → Scan → Pair → Drafts → Publish

---

## 🔗 Quick Links

**Production URLs**:
- Main app: https://draftpilot-ai.netlify.app
- Quick List: https://draftpilot-ai.netlify.app/quick-list.html
- Upload: https://draftpilot-ai.netlify.app/upload-local.html
- New SmartDrafts: https://draftpilot-ai.netlify.app/new-smartdrafts/

**Admin/Dev**:
- Netlify Dashboard: https://app.netlify.com/sites/draftpilot-ai
- GitHub Repo: https://github.com/CCSNH-NicolePhillips/gptlisting-ebay-webhooks

**External Services**:
- eBay Developer: https://developer.ebay.com/my/auth/
- Dropbox Apps: https://www.dropbox.com/developers/apps
- Auth0 Dashboard: https://manage.auth0.com/

---

**Last Updated**: November 17, 2025  
**Session**: Rebrand + Local Upload + Visual-First Pairing
