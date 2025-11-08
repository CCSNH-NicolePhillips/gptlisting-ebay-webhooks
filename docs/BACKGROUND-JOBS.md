# Background Jobs System

## Overview

To avoid Netlify's 10-second function timeout, category fetching now uses a background job queue system.

## Architecture

### Components

1. **Job Initiator** (`ebay-fetch-all-categories.ts`)
   - Analyzes category tree
   - Creates queue with categories to fetch
   - Returns immediately with jobId
   - Does NOT fetch categories synchronously

2. **Background Worker** (`ebay-fetch-categories-background.ts`)
   - Scheduled function (runs every minute via cron)
   - Processes 5 categories per execution
   - Updates job status in real-time
   - Continues until queue is empty

3. **Status Endpoint** (`ebay-fetch-categories-status.ts`)
   - Check job progress
   - Returns: processed, success, failed, total, status

4. **Admin UI** (`public/admin/fetch-categories.html`)
   - Starts background jobs
   - Polls status every 5 seconds
   - Shows live progress bar

## Workflow

### Starting a Job

```bash
POST /.netlify/functions/ebay-fetch-all-categories
{
  "marketplaceId": "EBAY_US",
  "parentCategoryId": "26395",  # Optional: Health & Beauty
  "maxCategories": 100          # Optional: limit
}
```

**Response:**
```json
{
  "ok": true,
  "jobId": "job-1234567890-abc123",
  "totalCategories": 100,
  "message": "Background job created...",
  "parentCategory": "Health & Beauty (26395)"
}
```

### Checking Status

```bash
GET /.netlify/functions/ebay-fetch-categories-status?jobId=job-1234567890-abc123
```

**Response:**
```json
{
  "ok": true,
  "status": {
    "jobId": "job-1234567890-abc123",
    "totalCategories": 100,
    "processed": 45,
    "success": 40,
    "failed": 5,
    "status": "processing",
    "createdAt": 1234567890000,
    "updatedAt": 1234567899000,
    "parentCategory": "Health & Beauty (26395)",
    "errors": [
      {
        "categoryId": "12345",
        "categoryName": "Example Category",
        "error": "HTTP 404"
      }
    ]
  }
}
```

### Status Values

- `queued` - Job created, waiting for worker
- `processing` - Worker is actively processing
- `completed` - All categories processed
- `failed` - Job encountered fatal error

## Data Storage

All data stored in Netlify Blobs (`tokensStore()`):

### Queue File
**Key:** `category-fetch-queue-{jobId}.json`
```json
{
  "jobId": "job-123...",
  "marketplaceId": "EBAY_US",
  "categoryTreeId": "0",
  "categories": [
    { "id": "177011", "name": "Vitamins & Dietary Supplements" },
    { "id": "180959", "name": "Makeup" }
  ],
  "createdAt": 1234567890000
}
```

### Status File
**Key:** `category-fetch-status-{jobId}.json`
```json
{
  "jobId": "job-123...",
  "totalCategories": 100,
  "processed": 45,
  "success": 40,
  "failed": 5,
  "status": "processing",
  "createdAt": 1234567890000,
  "updatedAt": 1234567899000,
  "parentCategory": "Health & Beauty (26395)",
  "errors": []
}
```

### Job Index
**Key:** `category-fetch-index.json`
```json
{
  "activeJobs": [
    "job-1234567890-abc123",
    "job-1234567891-def456"
  ]
}
```

## Processing Rate

- **Batch Size:** 5 categories per minute
- **Rate Limiting:** 200ms delay between eBay API calls
- **Example:** 100 categories = ~20 minutes

### Estimated Times

| Categories | Estimated Time |
|------------|----------------|
| 10         | ~2 minutes     |
| 50         | ~10 minutes    |
| 100        | ~20 minutes    |
| 500        | ~100 minutes   |
| 1000       | ~3.3 hours     |

## Netlify Scheduled Functions

### Requirements

⚠️ **Scheduled functions require Netlify Pro plan** ($19/month)

Alternative approaches:
1. Use external cron service (e.g., Upstash QStash)
2. Manual trigger endpoint (call manually every minute)
3. Use Netlify Build Hooks to trigger periodically

### Configuration

The background worker is configured with:
```typescript
export const config = {
  schedule: "*/1 * * * *"  // Every minute
};
```

## Testing

### Test with Small Batch

1. Go to `/admin/fetch-categories.html`
2. Enter parent category: `26395` (Health & Beauty)
3. Set max categories: `10`
4. Click "Fetch Categories"
5. Watch progress bar update every 5 seconds

### Monitor Logs

Check Netlify function logs:
```bash
netlify functions:log ebay-fetch-categories-background
```

## Troubleshooting

### Job Not Processing

**Symptoms:** Status stays at "queued"

**Causes:**
1. Scheduled functions not enabled (requires Pro plan)
2. Background worker not deployed
3. Job not added to index

**Fix:**
```javascript
// Check if job is in index
const index = await store.get('category-fetch-index.json', { type: 'json' });
console.log('Active jobs:', index?.activeJobs);
```

### Job Stuck

**Symptoms:** Processed count stops increasing

**Causes:**
1. Worker hit error and stopped
2. eBay credentials expired
3. Rate limit exceeded

**Fix:**
1. Check function logs
2. Re-authenticate eBay
3. Increase delay between requests

### Too Many Errors

**Symptoms:** High failed count

**Common Errors:**
- `categoryName undefined` - Fixed with fallback: `data.categoryName || cat.name`
- `HTTP 404` - Category doesn't exist or was removed
- `HTTP 429` - Rate limit exceeded (increase delay)

## Future Enhancements

1. **Multiple Workers:** Process multiple jobs in parallel
2. **Priority Queue:** Process important categories first
3. **Retry Logic:** Automatically retry failed categories
4. **Progress Persistence:** Resume jobs after function restarts
5. **Email Notifications:** Alert when job completes
6. **Dashboard:** View all jobs and their status

## Related Files

- `netlify/functions/ebay-fetch-all-categories.ts` - Job initiator
- `netlify/functions/ebay-fetch-categories-background.ts` - Background worker
- `netlify/functions/ebay-fetch-categories-status.ts` - Status endpoint
- `public/admin/fetch-categories.html` - Admin UI
- `src/lib/taxonomy-store.ts` - Category storage
- `src/lib/taxonomy-autofill.ts` - Category usage
