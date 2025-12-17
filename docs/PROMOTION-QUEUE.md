# Promotion Queue System

Background job system for handling eBay promotion creation with retry logic to handle sync delays.

## Overview

When listings are published to eBay, they take 1-10 minutes to become available for promotion due to backend sync delays. The queue system handles this by:

1. **Queuing** promotion jobs immediately after publishing
2. **Retrying** with exponential backoff (1min → 2min → 4min → 8min → 10min)
3. **Staggering** batch jobs to avoid rate limits
4. **Processing** up to 10 jobs concurrently every minute

## Architecture

### Components

- **`src/lib/promotion-queue.ts`** - Queue management (Redis-backed)
- **`netlify/functions/promotion-worker.ts`** - Background processor (scheduled every minute)
- **`netlify/functions/queue-promotion.ts`** - API to queue jobs
- **`netlify/functions/promotion-status.ts`** - API to check status

### Data Flow

```
Draft Publish
    ↓
Queue Promotion Job (Redis)
    ↓
Worker runs every minute
    ↓
Attempt promotion creation
    ↓
Success? → Remove from queue
    ↓
Failure? → Retry with backoff
    ↓
Max attempts? → Remove and log
```

## Usage

### Queue Single Job

```javascript
POST /.netlify/functions/queue-promotion
{
  "listingId": "177681098666",
  "adRate": 5,
  "campaignId": "151310691012" // optional
}

Response:
{
  "success": true,
  "jobId": "177681098666_1734392400000",
  "message": "Promotion queued. It will be processed within 1-2 minutes."
}
```

### Queue Batch (for draft publishing)

```javascript
POST /.netlify/functions/queue-promotion
{
  "batch": [
    { "listingId": "177681098666", "adRate": 5 },
    { "listingId": "177681098667", "adRate": 7 },
    { "listingId": "177681098668", "adRate": 5 }
  ]
}

Response:
{
  "success": true,
  "jobIds": ["177681098666_1734392400000", "177681098667_1734392400001", ...],
  "count": 3,
  "message": "Queued 3 promotion jobs. They will be processed over the next few minutes."
}
```

### Check Job Status

```javascript
GET /.netlify/functions/promotion-status?jobId=177681098666_1734392400000

Response:
{
  "job": {
    "id": "177681098666_1734392400000",
    "userId": "user123",
    "listingId": "177681098666",
    "adRate": 5,
    "attempts": 2,
    "maxAttempts": 5,
    "nextRetryAt": 1734392520000,
    "createdAt": 1734392400000,
    "lastError": "Listing not synced yet"
  }
}
```

### Check Queue Stats

```javascript
GET /.netlify/functions/promotion-status

Response:
{
  "stats": {
    "total": 15,
    "ready": 3,
    "pending": 12
  }
}
```

## Integration

### Automatic (Draft Publishing)

The `ebay-publish-offer` function automatically queues promotions when:
- Draft has `merchantData.autoPromote = true`
- Listing published successfully
- listingId available in response

```javascript
// In draft metadata
{
  "autoPromote": true,
  "autoPromoteAdRate": 5
}
```

### Manual (Active Listings Page)

Users can manually queue promotions for existing listings via the active-listings UI, which calls `queue-promotion` endpoint.

## Configuration

### Redis (Upstash)

Required environment variables:
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

### Retry Schedule

- **Attempt 1**: Immediate (1 minute after queue)
- **Attempt 2**: +2 minutes (exponential)
- **Attempt 3**: +4 minutes
- **Attempt 4**: +8 minutes
- **Attempt 5**: +10 minutes (max delay cap)

Total: Up to ~25 minutes of retry window

### Batch Processing

- **Stagger**: 5 seconds between each job's first retry
- **Concurrent**: Max 10 jobs processed per minute
- **Rate limit protection**: Prevents overwhelming eBay API

Example: 25-draft batch:
- Jobs queued at T+0
- First job retries at T+60s
- Jobs 2-25 retry at T+65s, T+70s, T+75s, etc.
- Spread over ~2 minutes of processing time

## Monitoring

### Logs

```bash
# Worker invocations
[promotion-worker] Starting batch processing
[promotion-worker] Queue stats: { total: 15, ready: 3, pending: 12 }
[promotion-worker] Processing 3 jobs
[promotion-worker] ✓ Job 177681098666_1734392400000 succeeded
[promotion-worker] ✗ Job 177681098667_1734392400001 failed: Listing not synced yet
[promotion-worker] Batch complete: 2 succeeded, 1 retrying, 0 failed
```

### Netlify Scheduled Functions

The worker appears in Netlify dashboard under:
- **Functions** → **Scheduled** → `promotion-worker`
- Shows execution history, logs, and errors

## Error Handling

### Recoverable Errors (Retry)

- `35048` - Listing invalid/not synced
- Empty response from eBay
- Network timeouts

### Non-Recoverable Errors (Skip)

- `35001` - Ad already exists (success)
- Invalid credentials (user issue)
- Campaign not found (user issue)

### Max Attempts Reached

After 5 attempts (~25 minutes), job is removed and logged:
```
[promotion-worker] Job 177681098666_1734392400000 failed after 5 attempts: Listing not synced yet
```

## Benefits

1. **Non-blocking** - Doesn't slow down draft publishing
2. **Reliable** - Handles eBay's sync delays automatically
3. **Scalable** - Processes 25+ drafts concurrently
4. **Rate-safe** - Staggered retries prevent API limits
5. **Observable** - Clear status checks and logging

## Testing

### Queue a Test Job

```bash
curl -X POST https://your-site.netlify.app/.netlify/functions/queue-promotion \
  -H "Authorization: Bearer YOUR_JWT" \
  -H "Content-Type: application/json" \
  -d '{"listingId":"177681098666","adRate":5}'
```

### Trigger Worker Manually

The worker can be manually triggered via Netlify UI or CLI for testing without waiting for the schedule.

### Check Queue

```bash
curl -H "Authorization: Bearer YOUR_JWT" \
  https://your-site.netlify.app/.netlify/functions/promotion-status
```

## Future Enhancements

- [ ] Add webhook notifications when jobs complete
- [ ] Persistent failed jobs history for debugging
- [ ] Admin UI to view/manage queue
- [ ] Metrics dashboard (success rate, avg retry count)
- [ ] Priority queue for urgent promotions
