/**
 * Promotion Queue - Background job system for retrying promotion creation
 * 
 * Handles eBay's sync delays by queuing promotion attempts and retrying with
 * exponential backoff. Supports batch operations for draft publishing.
 */

const REDIS_URL = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";

export interface PromotionJob {
  id: string;
  userId: string;
  listingId: string;
  sku?: string;
  campaignId?: string;
  adRate: number;
  attempts: number;
  maxAttempts: number;
  nextRetryAt: number; // Unix timestamp in ms
  createdAt: number;
  lastError?: string;
}

const QUEUE_KEY = 'promotion_queue';
const JOB_PREFIX = 'promo_job:';
const MAX_ATTEMPTS = 5;
const INITIAL_DELAY_MS = 60000; // 1 minute
const MAX_DELAY_MS = 600000; // 10 minutes
const BATCH_SIZE = 10; // Process 10 at a time to avoid rate limits

/**
 * Calculate next retry delay with exponential backoff
 */
function getNextRetryDelay(attempts: number): number {
  const delay = INITIAL_DELAY_MS * Math.pow(2, attempts - 1);
  return Math.min(delay, MAX_DELAY_MS);
}

/**
 * Make Redis REST API call
 */
async function redisCall(command: string, ...args: (string | number)[]): Promise<any> {
  if (!REDIS_URL || !REDIS_TOKEN) {
    console.error('[promotion-queue] Redis not configured');
    return null;
  }

  const url = `${REDIS_URL}/${command}/${args.map(encodeURIComponent).join('/')}`;
  
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Redis ${command} failed ${res.status}: ${text}`);
  }

  const data = await res.json();
  return data.result;
}

/**
 * Queue a promotion job for background processing
 */
export async function queuePromotionJob(
  userId: string,
  listingId: string,
  adRate: number,
  options: {
    campaignId?: string;
    maxAttempts?: number;
    sku?: string;
  } = {}
): Promise<string> {
  const jobId = `${listingId}_${Date.now()}`;
  const now = Date.now();
  
  const job: PromotionJob = {
    id: jobId,
    userId,
    listingId,
    sku: options.sku,
    campaignId: options.campaignId,
    adRate,
    attempts: 0,
    maxAttempts: options.maxAttempts || MAX_ATTEMPTS,
    nextRetryAt: now + INITIAL_DELAY_MS,
    createdAt: now,
  };

  // Store job data
  await redisCall('SET', `${JOB_PREFIX}${jobId}`, JSON.stringify(job));
  
  // Add to sorted set (score = nextRetryAt for easy retrieval)
  await redisCall('ZADD', QUEUE_KEY, job.nextRetryAt, jobId);
  
  console.log(`[promotion-queue] Queued job ${jobId} for listing ${listingId}, retry in ${INITIAL_DELAY_MS}ms`);
  
  return jobId;
}

/**
 * Queue multiple promotion jobs (for batch draft publishing)
 */
export async function queuePromotionBatch(
  jobs: Array<{
    userId: string;
    listingId: string;
    adRate: number;
    campaignId?: string;
    sku?: string;
  }>
): Promise<string[]> {
  const jobIds: string[] = [];
  
  // Stagger the retry times slightly to spread out API calls
  const now = Date.now();
  const staggerMs = 5000; // 5 seconds between each job's first retry
  
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const jobId = `${job.listingId}_${now + i}`;
    const nextRetryAt = now + INITIAL_DELAY_MS + (i * staggerMs);
    
    const promotionJob: PromotionJob = {
      id: jobId,
      userId: job.userId,
      listingId: job.listingId,
      sku: job.sku,
      campaignId: job.campaignId,
      adRate: job.adRate,
      attempts: 0,
      maxAttempts: MAX_ATTEMPTS,
      nextRetryAt,
      createdAt: now,
    };

    await redisCall('SET', `${JOB_PREFIX}${jobId}`, JSON.stringify(promotionJob));
    await redisCall('ZADD', QUEUE_KEY, promotionJob.nextRetryAt, jobId);
    
    jobIds.push(jobId);
  }
  
  console.log(`[promotion-queue] Queued ${jobIds.length} jobs, staggered over ${(jobs.length * staggerMs) / 1000}s`);
  
  return jobIds;
}

/**
 * Get jobs ready to process (nextRetryAt <= now)
 */
export async function getReadyJobs(limit: number = BATCH_SIZE): Promise<PromotionJob[]> {
  const now = Date.now();
  
  // Get job IDs with score <= now (ready to process)
  const jobIds = await redisCall('ZRANGEBYSCORE', QUEUE_KEY, 0, now, 'LIMIT', 0, limit);
  
  if (!jobIds || jobIds.length === 0) {
    return [];
  }

  // Fetch job data
  const jobs: PromotionJob[] = [];
  for (const jobId of jobIds) {
    const jobData = await redisCall('GET', `${JOB_PREFIX}${jobId}`);
    if (jobData) {
      jobs.push(JSON.parse(jobData));
    }
  }

  return jobs;
}

/**
 * Update job after processing attempt
 */
export async function updateJob(
  jobId: string,
  success: boolean,
  errorMessage?: string
): Promise<void> {
  const jobData = await redisCall('GET', `${JOB_PREFIX}${jobId}`);
  if (!jobData) {
    console.error(`[promotion-queue] Job ${jobId} not found`);
    return;
  }

  const job: PromotionJob = JSON.parse(jobData);
  job.attempts++;

  if (success) {
    // Remove from queue and delete job
    await redisCall('ZREM', QUEUE_KEY, jobId);
    await redisCall('DEL', `${JOB_PREFIX}${jobId}`);
    console.log(`[promotion-queue] Job ${jobId} completed successfully after ${job.attempts} attempts`);
    return;
  }

  // Failed - check if should retry
  if (job.attempts >= job.maxAttempts) {
    // Max attempts reached - remove and log
    await redisCall('ZREM', QUEUE_KEY, jobId);
    await redisCall('DEL', `${JOB_PREFIX}${jobId}`);
    console.error(`[promotion-queue] Job ${jobId} failed after ${job.attempts} attempts: ${errorMessage}`);
    return;
  }

  // Schedule retry with exponential backoff
  job.lastError = errorMessage;
  job.nextRetryAt = Date.now() + getNextRetryDelay(job.attempts);
  
  await redisCall('SET', `${JOB_PREFIX}${jobId}`, JSON.stringify(job));
  await redisCall('ZADD', QUEUE_KEY, job.nextRetryAt, jobId);
  
  const delaySeconds = Math.round(getNextRetryDelay(job.attempts) / 1000);
  console.log(`[promotion-queue] Job ${jobId} failed (attempt ${job.attempts}/${job.maxAttempts}), retry in ${delaySeconds}s`);
}

/**
 * Get job status
 */
export async function getJobStatus(jobId: string): Promise<PromotionJob | null> {
  const jobData = await redisCall('GET', `${JOB_PREFIX}${jobId}`);
  if (!jobData) {
    return null;
  }
  return JSON.parse(jobData);
}

/**
 * Get queue statistics
 */
export async function getQueueStats(): Promise<{
  total: number;
  ready: number;
  pending: number;
}> {
  const now = Date.now();
  
  const total = await redisCall('ZCARD', QUEUE_KEY) || 0;
  const ready = await redisCall('ZCOUNT', QUEUE_KEY, 0, now) || 0;
  const pending = total - ready;

  return { total, ready, pending };
}

/**
 * Cancel a job
 */
export async function cancelJob(jobId: string): Promise<boolean> {
  const removed = await redisCall('ZREM', QUEUE_KEY, jobId);
  await redisCall('DEL', `${JOB_PREFIX}${jobId}`);
  return removed > 0;
}

// ============================================================================
// Promotion Intent Storage
// ============================================================================
// Stores promotion settings keyed by offerId so they can be retrieved when
// the offer is published. eBay's Inventory API doesn't persist custom data,
// so we use Redis to bridge the gap between offer creation and publishing.

const PROMO_INTENT_PREFIX = 'promo_intent:';
const PROMO_INTENT_TTL_SEC = 604800; // 7 days - offers should be published within this time

export interface PromotionIntent {
  offerId: string;
  enabled: boolean;
  adRate: number;
  createdAt: number;
}

/**
 * Store promotion intent for an offer
 * Called when create-ebay-draft-user creates an offer with promotion enabled
 */
export async function storePromotionIntent(
  offerId: string,
  enabled: boolean,
  adRate: number
): Promise<void> {
  if (!REDIS_URL || !REDIS_TOKEN) {
    console.warn('[promotion-queue] Redis not configured, skipping promotion intent storage');
    return;
  }

  const intent: PromotionIntent = {
    offerId,
    enabled,
    adRate,
    createdAt: Date.now(),
  };

  const key = `${PROMO_INTENT_PREFIX}${offerId}`;
  await redisCall('SET', key, JSON.stringify(intent));
  await redisCall('EXPIRE', key, PROMO_INTENT_TTL_SEC);
  
  console.log(`[promotion-queue] Stored promotion intent for offerId ${offerId}: enabled=${enabled}, adRate=${adRate}`);
}

/**
 * Get promotion intent for an offer
 * Called when ebay-publish-offer publishes an offer
 */
export async function getPromotionIntent(offerId: string): Promise<PromotionIntent | null> {
  if (!REDIS_URL || !REDIS_TOKEN) {
    console.warn('[promotion-queue] Redis not configured, cannot retrieve promotion intent');
    return null;
  }

  const key = `${PROMO_INTENT_PREFIX}${offerId}`;
  const data = await redisCall('GET', key);
  
  if (!data) {
    console.log(`[promotion-queue] No promotion intent found for offerId ${offerId}`);
    return null;
  }

  try {
    const intent = JSON.parse(data) as PromotionIntent;
    console.log(`[promotion-queue] Retrieved promotion intent for offerId ${offerId}: enabled=${intent.enabled}, adRate=${intent.adRate}`);
    return intent;
  } catch (err) {
    console.error(`[promotion-queue] Failed to parse promotion intent for offerId ${offerId}:`, err);
    return null;
  }
}

/**
 * Delete promotion intent for an offer (after processing)
 */
export async function deletePromotionIntent(offerId: string): Promise<void> {
  if (!REDIS_URL || !REDIS_TOKEN) {
    return;
  }

  const key = `${PROMO_INTENT_PREFIX}${offerId}`;
  await redisCall('DEL', key);
  console.log(`[promotion-queue] Deleted promotion intent for offerId ${offerId}`);
}
