# Quick-List Pipeline Analysis - December 19, 2025

## CRITICAL ISSUE IDENTIFIED

The change in commit `705ea8a` broke image processing for ALL upload methods.

### The Problem

**File:** `netlify/functions/smartdrafts-scan-background.ts` (Line 129)

**BROKEN CODE:**
```typescript
stagedUrls: payload.stagedUrls, // Use stagedUrls from scan response, not input
```

**Why This is Wrong:**

1. **For Dropbox uploads:** `payload.stagedUrls` DOES exist and is correct (from `smartdrafts-scan-core.ts` line 3764)
2. **For Local uploads:** `payload.stagedUrls` may be UNDEFINED or different from input `stagedUrls`
3. **The input `stagedUrls`** came from the scan-bg request body and was the correct set of images to process

### What Broke

#### Before (WORKING):
```typescript
stagedUrls: stagedUrls.length > 0 ? stagedUrls : undefined,
```
- Used the INPUT stagedUrls from the request body
- These were already staged by the ingestion system
- Pairing could find all images

#### After (BROKEN):
```typescript
stagedUrls: payload.stagedUrls,
```
- Assumes `payload.stagedUrls` always exists and is correct
- For local uploads, this might not match the input
- Results in "no images found" errors

### The Root Cause

The change was made to fix Dropbox staging, but it incorrectly assumed:
1. `runSmartDraftScan()` always returns `stagedUrls` in the payload
2. The returned `stagedUrls` always match what should be passed to pairing

**Reality:**
- For **Dropbox**: scan-core generates stagedUrls from `limitedFiles.map(f => f.stagedUrl)` ✅
- For **Local uploads**: scan-core may not populate `payload.stagedUrls` correctly ❌
- The INPUT `stagedUrls` from scan-bg request body were ALWAYS correct

### The Fix Required

**IMMEDIATE REVERT NEEDED:**

```typescript
// In smartdrafts-scan-background.ts line 129
stagedUrls: stagedUrls.length > 0 ? stagedUrls : undefined,  // REVERT TO THIS
```

### Files Involved

1. **smartdrafts-scan-background.ts** - Worker that processes scan jobs
2. **smartdrafts-scan-core.ts** - Core scanning logic (Line 3764 generates stagedUrls for Dropbox)
3. **smartdrafts-pairing-v2-start-from-scan.ts** - Reads stagedUrls from scan job to start pairing
4. **quick-list.html** - Frontend that triggers the pipeline
5. **dropbox.ts** - Ingestion adapter that creates stagedUrls
6. **smartdrafts-scan-bg.ts** - Initiator that accepts stagedUrls in request body

### Impact

- **Dropbox uploads:** Possibly working (if scan-core generates stagedUrls)
- **Local file uploads:** BROKEN - no images found
- **All customers:** Cannot process images uploaded via any method

### Timeline of Changes

1. `27d028e` - Added tests for Dropbox staging ✅
2. `a3c0478` - Handled empty folders ✅
3. `705ea8a` - **BREAKING CHANGE** - Used payload.stagedUrls instead of input stagedUrls ❌
4. `76c442d` - Added integration tests (didn't catch the bug)
5. `0348122` - UI fixes for empty folders ✅
6. `6554054` - Fixed showToast undefined ✅

### Recommended Action

1. **IMMEDIATELY revert line 129** in `smartdrafts-scan-background.ts`
2. Test with both Dropbox and local uploads
3. Verify stagedUrls flow end-to-end:
   - Ingestion → scan-bg → scan-background → scan-core → job storage → pairing-start

### Test Coverage Gap

The integration tests added in `76c442d` didn't catch this because:
- They mocked the scan-core response
- They didn't test the actual stagedUrls flow with real ingestion
- They didn't verify local upload path

### Prevention

Add integration test that:
1. Uploads local files
2. Runs full scan pipeline
3. Verifies stagedUrls persist through to pairing
4. Confirms images are found by pairing processor
