# Quick-List Pipeline Flow Analysis - December 19, 2025

## LOCAL UPLOAD FLOW ✅ CORRECT

### Step 1: File Upload (quick-list.html → ingest-local-upload.ts)
1. User selects files → `fileInput.addEventListener('change')`
2. Files stored in `selectedFiles` array
3. User clicks "Start Quick List" → `startPipeline()`
4. **Batch upload:** `uploadFilesInBatches(selectedFiles)`
   - Files encoded as base64
   - Sent in batches (max 5MB per batch)
   - **POST** `/.netlify/functions/ingest-local-upload`
   - Body: `{ files: [{ name, mime, data: base64 }] }`

**ingest-local-upload.ts:**
```typescript
// Uploads each file to R2/S3
const key = `staging/${userId}/default/${hash}-${filename}`;
// Generates 7-day signed URL
const signedUrl = await getSignedUrl(...);
// Returns array of uploaded files
return { files: [{ key, name, stagedUrl: signedUrl }] };
```

**Result:** Array of `stagedUrl`s (7-day signed R2/S3 URLs)

### Step 2: Scan Start (quick-list.html → smartdrafts-scan-bg.ts)
```javascript
const uploadedFiles = await uploadFilesInBatches(selectedFiles);
const stagedUrls = uploadedFiles.map(f => f.stagedUrl); // ✅ CRITICAL

// Start scan with stagedUrls
await fetchJSON('/.netlify/functions/smartdrafts-scan-bg', {
  body: JSON.stringify({ stagedUrls })
});
```

**smartdrafts-scan-bg.ts:**
- Receives `{ stagedUrls: string[] }` in request body
- Creates job in Redis with `stagedUrls`
- Invokes background worker with `stagedUrls`
- Returns `{ ok: true, jobId }`

### Step 3: Scan Background (smartdrafts-scan-background.ts)
```typescript
// Extract stagedUrls from request body
const stagedUrls = Array.isArray(body.stagedUrls) ? body.stagedUrls : [];

// Store job with stagedUrls
await writeJob(jobId, userId, {
  state: "running",
  stagedUrls: stagedUrls.length > 0 ? stagedUrls : undefined,
});

// Run scan with stagedUrls
const response = await runSmartDraftScan({
  userId,
  stagedUrls: stagedUrls.length > 0 ? stagedUrls : undefined,
});

// ✅ CRITICAL FIX: Store INPUT stagedUrls in job
await writeJob(jobId, userId, {
  state: "complete",
  stagedUrls: stagedUrls.length > 0 ? stagedUrls : undefined, // ✅ Uses INPUT
  groups: payload.groups,
  ...
});
```

**Why INPUT stagedUrls?**
- Local uploads don't go through DropboxAdapter
- `runSmartDraftScan()` with stagedUrls → `runSmartDraftScanFromStagedUrls()`
- That function processes the PROVIDED stagedUrls
- It does NOT generate new stagedUrls (already staged!)
- Storing INPUT stagedUrls preserves the original R2/S3 URLs

### Step 4: Scan Core Processing (smartdrafts-scan-core.ts)
```typescript
// runSmartDraftScan() entry point
if (stagedUrls.length > 0) {
  return await runSmartDraftScanFromStagedUrls({
    userId,
    stagedUrls, // Uses provided stagedUrls directly
  });
}

// runSmartDraftScanFromStagedUrls()
// - Uses stagedUrls as-is (already valid R2/S3 URLs)
// - Downloads images for vision analysis
// - Creates groups via pairing algorithm
// - Returns groups array (does NOT return stagedUrls in payload)
```

**CRITICAL:** For local uploads, scan-core does NOT generate `payload.stagedUrls`!

### Step 5: Pairing Start (pairing-v2-start-from-scan.ts)
```typescript
// Fetch scan job from Redis
const scanJob = await getScanJobData(userId, scanJobId);

// Get stagedUrls from job
if (scanJob.stagedUrls) {
  imagePaths = scanJob.stagedUrls; // ✅ Uses stored INPUT stagedUrls
  console.log("Using staged URLs from scan job");
}

// Schedule pairing with stagedUrls
await schedulePairingV2Job(userId, folder, imagePaths, undefined);
```

**SUCCESS:** Pairing receives the original R2/S3 URLs from upload!

---

## DROPBOX FLOW ✅ CORRECT

### Step 1: Folder Selection (quick-list.html)
1. User connects Dropbox
2. Selects folder from dropdown
3. Clicks "Start Quick List" → `startPipeline()`

### Step 2: Scan Start (quick-list.html → smartdrafts-scan-bg.ts)
```javascript
await fetchJSON('/.netlify/functions/smartdrafts-scan-bg', {
  body: JSON.stringify({
    path: selectedFolder, // Dropbox folder path
    force: false
  })
});
```

**smartdrafts-scan-bg.ts:**
- Receives `{ path: "/EBAY/folder" }` (NO stagedUrls)
- Creates job with `folder` field
- Invokes background worker with `folder`

### Step 3: Scan Background (smartdrafts-scan-background.ts)
```typescript
const folder = typeof body.folder === "string" ? body.folder.trim() : "";
const stagedUrls = Array.isArray(body.stagedUrls) ? body.stagedUrls : []; // Empty!

// Run scan with folder
const response = await runSmartDraftScan({
  userId,
  folder: folder || undefined,  // ✅ Dropbox path
  stagedUrls: undefined,         // ✅ No stagedUrls yet
});

// Store job with INPUT stagedUrls (empty for Dropbox)
await writeJob(jobId, userId, {
  state: "complete",
  folder: payload.folder,
  stagedUrls: stagedUrls.length > 0 ? stagedUrls : undefined, // ✅ undefined for Dropbox
  groups: payload.groups,
});
```

### Step 4: Scan Core with Dropbox (smartdrafts-scan-core.ts)
```typescript
// runSmartDraftScan() entry point
const folder = options.folder;
const stagedUrls = Array.isArray(options.stagedUrls) ? options.stagedUrls : [];

if (stagedUrls.length > 0) {
  // Not this path for Dropbox
}

// ✅ Dropbox path
const ingestedFiles = await DropboxAdapter.list({
  source: 'dropbox',
  userId,
  payload: {
    folderPath: folder,
    refreshToken: refresh,
    skipStaging: false,  // ✅ Stage to R2/S3
  },
});

// DropboxAdapter stages each file to R2/S3 and returns stagedUrl
const limitedFiles = ingestedFiles; // Each has .stagedUrl property

// ✅ CRITICAL: Generate stagedUrls array for pairing
const responsePayload = {
  ok: true,
  folder,
  groups: payloadGroups,
  stagedUrls: limitedFiles.map(f => f.stagedUrl), // ✅ Returns stagedUrls!
};
```

**For Dropbox:** scan-core DOES generate `payload.stagedUrls` from DropboxAdapter!

### Step 5: Back to Scan Background
```typescript
const payload = response.body;

// ✅ For Dropbox, payload.stagedUrls exists!
await writeJob(jobId, userId, {
  state: "complete",
  stagedUrls: stagedUrls.length > 0 ? stagedUrls : undefined,
  // stagedUrls from INPUT is empty for Dropbox
  // But we want payload.stagedUrls instead!
});
```

**WAIT - PROBLEM FOUND!** 🚨

For Dropbox:
- INPUT `stagedUrls` = empty (not provided in request)
- OUTPUT `payload.stagedUrls` = R2/S3 URLs from DropboxAdapter
- Current code stores INPUT (empty) → WRONG for Dropbox!

---

## THE REAL BUG 🐛

### Current Code (After My "Fix"):
```typescript
stagedUrls: stagedUrls.length > 0 ? stagedUrls : undefined,
```

**Result:**
- ✅ **LOCAL:** Works (input stagedUrls exist)
- ❌ **DROPBOX:** Broken (input stagedUrls empty, loses payload.stagedUrls)

### My Previous "Breaking" Code:
```typescript
stagedUrls: payload.stagedUrls,
```

**Result:**
- ❌ **LOCAL:** Broken (payload.stagedUrls undefined)
- ✅ **DROPBOX:** Works (payload.stagedUrls from DropboxAdapter)

### THE CORRECT FIX:
```typescript
stagedUrls: stagedUrls.length > 0 ? stagedUrls : payload.stagedUrls,
```

**Result:**
- ✅ **LOCAL:** Uses input stagedUrls (already staged by upload)
- ✅ **DROPBOX:** Uses payload.stagedUrls (generated by DropboxAdapter)
- ✅ **Empty folders:** undefined (correct handling)

---

## Summary

**The Logic:**
1. **Local uploads:** stagedUrls come in request body (pre-staged)
2. **Dropbox:** stagedUrls generated by scan-core via DropboxAdapter
3. **Storage:** Must preserve whichever source has the stagedUrls
4. **Pairing:** Reads stagedUrls from job to process images

**The Fix:**
```typescript
// Priority: input stagedUrls first, then payload.stagedUrls
stagedUrls: stagedUrls.length > 0 ? stagedUrls : payload.stagedUrls,
```

This handles both flows correctly!
