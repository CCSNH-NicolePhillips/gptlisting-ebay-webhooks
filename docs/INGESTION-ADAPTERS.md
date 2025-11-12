# Ingestion Adapter System

Unified interface for all file sources (local upload, Dropbox, Google Drive, etc.)

## Architecture

```
User Device/Cloud
   ├─ Local Upload (Android/iOS/Desktop)
   ├─ Dropbox (OAuth)
   └─ (Future) Google Drive / iCloud / S3
            ↓
     Ingestion Adapter (uniform contract)
            ↓
     Staging Storage (R2/S3)
            ↓
   Scan → Pair → Drafts (existing pipeline)
            ↓
           eBay
```

## Quick Start

### Local Upload Flow

```javascript
// 1. Initialize upload (get presigned URLs)
const init = await POST('/api/ingest/local/init', {
  fileCount: 5,
  mimeHints: ['image/jpeg', 'image/png', ...],
  filenames: ['photo1.jpg', 'photo2.png', ...]
});

// 2. Upload files directly to R2/S3
await Promise.all(
  files.map((file, i) => 
    fetch(init.uploads[i].url, {
      method: 'PUT',
      headers: { 'Content-Type': file.type },
      body: file
    })
  )
);

// 3. Complete upload (get staged URLs)
const complete = await POST('/api/ingest/local/complete', {
  keys: init.uploads.map(u => u.key)
});

// 4. Start scan job
const job = await POST('/api/scan/start', {
  files: complete.files.map(f => f.stagedUrl)
});
```

### Dropbox Flow

```javascript
// List files from Dropbox folder
const list = await POST('/api/ingest/dropbox/list', {
  folderPath: '/EBAY',
  skipStaging: false  // Copy to R2/S3 for uniformity
});

// Start scan job
const job = await POST('/api/scan/start', {
  files: list.files.map(f => f.stagedUrl)
});
```

## Environment Variables

### Required for R2 (Cloudflare)

```bash
R2_BUCKET=your-bucket-name
R2_ACCOUNT_ID=your-cloudflare-account-id
R2_ACCESS_KEY_ID=your-r2-access-key
R2_SECRET_ACCESS_KEY=your-r2-secret-key
R2_PUBLIC_URL=https://pub-xyz.r2.dev  # Optional: for public buckets
```

### Required for S3 (AWS)

```bash
S3_BUCKET=your-bucket-name
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
```

### Optional Configuration

```bash
MAX_FILES_PER_BATCH=200           # Max files per init call
STAGING_RETENTION_HOURS=72        # Auto-delete after 72 hours
MAX_STAGING_BYTES_PER_USER=2147483648  # 2GB per user
```

## API Endpoints

### POST /ingest-local-init

Initialize local file upload. Returns presigned PUT URLs.

**Request:**
```json
{
  "fileCount": 10,
  "mimeHints": ["image/jpeg", "image/png"],
  "filenames": ["photo1.jpg", "photo2.png"]
}
```

**Response:**
```json
{
  "ok": true,
  "uploads": [
    {
      "url": "https://...presigned-url...",
      "key": "staging/user123/job456/abc123-photo1.jpg",
      "mime": "image/jpeg"
    }
  ],
  "expiresIn": 600
}
```

### POST /ingest-local-complete

Complete upload and get staged file list.

**Request:**
```json
{
  "keys": ["staging/user123/job456/abc123-photo1.jpg"]
}
```

**Response:**
```json
{
  "ok": true,
  "files": [
    {
      "id": "staging/user123/job456/abc123-photo1.jpg",
      "name": "photo1.jpg",
      "mime": "image/jpeg",
      "stagedUrl": "https://...signed-url...",
      "meta": {
        "sourcePath": "staging/...",
        "uploadedAt": "2025-11-12T10:30:00Z"
      }
    }
  ],
  "count": 1
}
```

### POST /ingest-dropbox-list

List files from Dropbox folder and stage them.

**Request:**
```json
{
  "folderPath": "/EBAY",
  "skipStaging": false,
  "jobId": "optional-job-id"
}
```

**Response:**
```json
{
  "ok": true,
  "files": [
    {
      "id": "dbid:abc123",
      "name": "photo1.jpg",
      "mime": "image/jpeg",
      "bytes": 1234567,
      "stagedUrl": "https://...signed-url...",
      "meta": {
        "sourcePath": "/EBAY/photo1.jpg",
        "dropboxPath": "/ebay/photo1.jpg",
        "stagingKey": "staging/..."
      }
    }
  ],
  "count": 1,
  "folderPath": "/EBAY",
  "staged": true
}
```

## Adapters

### Implementing a New Adapter

```typescript
// src/ingestion/my-adapter.ts
import type { IngestionAdapter, IngestRequest, IngestedFile } from './types';

export const MyAdapter: IngestionAdapter = {
  async list(req: IngestRequest): Promise<IngestedFile[]> {
    // 1. Authenticate with source API
    // 2. List files from req.payload
    // 3. Copy to staging storage
    // 4. Return IngestedFile[] with stagedUrl
    return files;
  },
  
  // Optional: for sources that need presigned upload
  async stage(req: IngestRequest): Promise<{ uploads: PresignedUpload[] }> {
    // Generate presigned URLs for direct upload
    return { uploads };
  }
};
```

Register in `src/ingestion/index.ts`:

```typescript
const adapters: Partial<Record<SourceType, IngestionAdapter>> = {
  local: LocalAdapter,
  dropbox: DropboxAdapter,
  mySource: MyAdapter,  // Add here
};
```

## Staging Storage

Files are stored in R2/S3 with this structure:

```
staging/
  ├─ {userId}/
  │   ├─ {jobId}/
  │   │   ├─ {hash}-{filename}.jpg
  │   │   └─ ...
  │   └─ default/
  │       └─ ...
```

**Lifecycle:** Files auto-delete after 72 hours (configurable).

**Security:**
- Presigned PUT URLs valid for 10 minutes
- Presigned GET URLs valid for 24 hours
- All objects private by default (unless R2_PUBLIC_URL set)

## Rate Limits & Quotas

Enforced per user:

- **Max files per batch:** 200 (returns 429 if exceeded)
- **Max staging bytes:** 2GB (configurable)
- **Max concurrent jobs:** 3 (existing limit)

Example error response:

```json
{
  "error": "Maximum 200 files per batch",
  "maxFiles": 200,
  "requested": 250,
  "suggestion": "Try splitting into batches of 200 or fewer"
}
```

## Testing

### Unit Tests

```bash
npm test src/ingestion
```

### Integration Test

```bash
# Upload 50 local images
node scripts/test-local-upload.js

# Verify scan job completes
node scripts/test-scan-status.js <jobId>
```

### Manual Test (Local Upload)

1. Open `http://localhost:8888/upload-local.html`
2. Drag & drop images (up to 200)
3. Click "Upload & Process"
4. Verify files appear in R2/S3 under `staging/`
5. Verify scan job starts and completes

### Manual Test (Dropbox)

```bash
curl -X POST http://localhost:8888/.netlify/functions/ingest-dropbox-list \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"folderPath": "/EBAY"}'
```

## Migration from Old System

### Before (Dropbox only)

```javascript
// Scan triggered with folder path
POST /smartdrafts-scan-bg
{ path: "/EBAY" }

// Backend lists Dropbox, creates temp links
// Scan pipeline processes Dropbox URLs directly
```

### After (Unified adapters)

```javascript
// Option 1: Use new adapter endpoint
POST /ingest-dropbox-list
{ folderPath: "/EBAY" }

// Option 2: Keep existing endpoint
POST /smartdrafts-scan-bg
{ path: "/EBAY" }  // Still works! (backward compatible)

// Backend now stages to R2/S3 for consistency
// Scan pipeline processes staged URLs
```

**Backward Compatibility:** Existing Dropbox endpoints continue to work.

## Roadmap

- [x] Core ingestion types and interfaces
- [x] Storage layer (R2/S3 presigned URLs)
- [x] Local upload adapter
- [x] Dropbox adapter (refactored)
- [x] API endpoints (init, complete, list)
- [x] Frontend component (drag & drop)
- [ ] Update smartdrafts-scan-bg to accept staged URLs
- [ ] Google Drive adapter
- [ ] iCloud adapter
- [ ] S3 direct adapter
- [ ] Lifecycle rules (auto-delete)
- [ ] Usage quotas (track per-user staging bytes)
- [ ] Webhook support (auto-scan on upload)

## Support

For issues or questions, see:
- [API Documentation](./API.md)
- [Operations Runbook](./OPERATIONS-RUNBOOKS.md)
