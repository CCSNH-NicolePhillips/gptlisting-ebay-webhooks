# Quick Start: Ingestion Adapter System

## ✅ What's Been Built

Your unified file ingestion system is **ready to use**! Here's what you can do now:

### 1. Local Uploads (New!) 📤

Users can upload photos directly from their devices (Android, iOS, Windows, Mac) without needing Dropbox.

**Try it:**
```bash
npm run dev
# Then open: http://localhost:8888/upload-local.html
```

**What you'll see:**
- Drag-and-drop zone
- File selection dialog
- Progress tracking
- Up to 200 images per batch

### 2. Dropbox (Enhanced) ☁️

Existing Dropbox integration now uses the new adapter system with optional staging.

**New endpoint:**
```bash
POST /.netlify/functions/ingest-dropbox-list
Content-Type: application/json
Authorization: Bearer <token>

{
  "folderPath": "/EBAY",
  "skipStaging": false
}
```

## 🔧 Setup Requirements

### Step 1: Choose Your Storage

**Option A: Cloudflare R2 (Recommended)**
- Cheaper than S3
- Zero egress fees
- S3-compatible API

```bash
# Add to .env or Netlify environment variables
R2_BUCKET=gptlisting-staging
R2_ACCOUNT_ID=your-account-id
R2_ACCESS_KEY_ID=your-access-key
R2_SECRET_ACCESS_KEY=your-secret-key
```

**Option B: AWS S3**
```bash
S3_BUCKET=gptlisting-staging
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
```

### Step 2: Create the Bucket

**Cloudflare R2:**
1. Go to Cloudflare Dashboard → R2
2. Create bucket: `gptlisting-staging`
3. Generate API token with read/write permissions
4. Copy credentials to environment variables

**AWS S3:**
1. Go to AWS Console → S3
2. Create bucket: `gptlisting-staging`
3. Set to private (no public access)
4. Create IAM user with S3 permissions
5. Copy credentials to environment variables

### Step 3: Configure Lifecycle Rules (Optional but Recommended)

**Purpose:** Auto-delete files after 72 hours to control costs.

**Cloudflare R2:**
```
Bucket → Lifecycle Rules → Add Rule
- Prefix: staging/
- Delete after: 72 hours
```

**AWS S3:**
```
Bucket → Management → Lifecycle Rules → Create Rule
- Prefix: staging/
- Expiration: 3 days
```

## 🚀 How to Use

### For End Users (Local Upload)

1. Visit `/upload-local.html`
2. Drag photos or click to browse
3. Wait for upload (shows progress)
4. Files automatically staged for processing

### For Developers (API)

**Local Upload Flow:**
```javascript
// 1. Initialize
const init = await fetch('/.netlify/functions/ingest-local-init', {
  method: 'POST',
  headers: { 
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  },
  body: JSON.stringify({
    fileCount: files.length,
    filenames: files.map(f => f.name),
    mimeHints: files.map(f => f.type)
  })
});

const { uploads } = await init.json();

// 2. Upload files directly to R2/S3
await Promise.all(
  files.map((file, i) => 
    fetch(uploads[i].url, {
      method: 'PUT',
      headers: { 'Content-Type': file.type },
      body: file
    })
  )
);

// 3. Complete
const complete = await fetch('/.netlify/functions/ingest-local-complete', {
  method: 'POST',
  headers: { 
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  },
  body: JSON.stringify({
    keys: uploads.map(u => u.key)
  })
});

const { files: stagedFiles } = await complete.json();

// 4. Start scan (TODO: update scan endpoint to accept stagedUrls)
```

**Dropbox Flow:**
```javascript
const list = await fetch('/.netlify/functions/ingest-dropbox-list', {
  method: 'POST',
  headers: { 
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  },
  body: JSON.stringify({
    folderPath: '/EBAY'
  })
});

const { files } = await list.json();
// files now have stagedUrl pointing to R2/S3
```

## ⚡ Next Steps (To Complete)

### Critical: Update Scan Job

The scan job needs to accept staged URLs. Here's what to change:

**File:** `netlify/functions/smartdrafts-scan-bg.ts`

**Add this to payload validation:**
```typescript
const stagedUrls = payload?.stagedUrls;  // Array of URLs from staging

// Support both old (path) and new (stagedUrls) formats
if (!stagedUrls && !folder) {
  return json(400, { ok: false, error: "Provide folder path or stagedUrls" }, originHdr, METHODS);
}
```

**Update scan-core to handle stagedUrls:**
```typescript
// In smartdrafts-scan-core.ts runSmartDraftScan()
if (options.stagedUrls) {
  // Skip Dropbox listing, use provided URLs directly
  const urls = options.stagedUrls;
  // Continue with existing vision/CLIP pipeline
} else {
  // Existing Dropbox folder logic
}
```

### Testing Checklist

- [ ] Upload 1 image locally → verify in R2/S3
- [ ] Upload 50 images → check progress bar
- [ ] Try 201 images → should get 429 error
- [ ] Test on Android Chrome
- [ ] Test on iOS Safari
- [ ] Test Dropbox adapter endpoint
- [ ] Verify lifecycle rule works (wait 72+ hours)

## 📊 Monitoring

### Check Staging Usage

**R2 Dashboard:**
- Storage used
- Request count
- Bandwidth (should be minimal)

**Expected usage (1000 users):**
- Storage: ~10-20GB (with 72hr retention)
- Requests: ~200K/month (100K PUT + 100K GET)
- Cost: < $1/month

## 🐛 Troubleshooting

### "Cannot find module @aws-sdk/client-s3"
```bash
npm install
```

### "R2_BUCKET environment variable required"
Add R2 or S3 credentials to `.env` or Netlify environment variables.

### "Failed to initialize upload"
Check that R2/S3 credentials are valid and have read/write permissions.

### "Presigned URL expired"
URLs expire after 10 minutes. User needs to retry.

### Files not auto-deleting
Set up lifecycle rules in R2/S3 dashboard (see Step 3 above).

## 📚 Documentation

- **Full Guide:** `docs/INGESTION-ADAPTERS.md`
- **Implementation Summary:** `docs/INGESTION-IMPLEMENTATION-SUMMARY.md`
- **API Reference:** See endpoints in INGESTION-ADAPTERS.md

## 🎯 Architecture Benefits

**For Users:**
- ✅ Works on all devices (no Dropbox required)
- ✅ Fast uploads (direct to storage)
- ✅ Clear progress tracking

**For You:**
- ✅ Extensible (easy to add Google Drive, iCloud, etc.)
- ✅ Type-safe (full TypeScript)
- ✅ Cost-controlled (auto-delete + rate limits)
- ✅ Backward compatible (existing Dropbox endpoints work)

## 🚦 Status

**What's Complete:**
- ✅ Core adapter system
- ✅ Local upload adapter
- ✅ Dropbox adapter (refactored)
- ✅ Storage layer (R2/S3)
- ✅ API endpoints
- ✅ Frontend UI
- ✅ Documentation

**What's Next:**
- ⏳ Update scan job to accept staged URLs (1-2 hours)
- ⏳ Configure R2/S3 (30 minutes)
- ⏳ Test on mobile devices (1 hour)
- ⏳ Deploy to production (15 minutes)

**Estimated time to launch: 4-5 hours** 🚀

---

## Need Help?

Check the full documentation:
- `docs/INGESTION-ADAPTERS.md` - Complete guide
- `docs/INGESTION-IMPLEMENTATION-SUMMARY.md` - What was built
- Or ask me! I'm here to help.
