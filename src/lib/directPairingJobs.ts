/**
 * Background job management for direct pairing
 * Uses Upstash Redis REST API to store job state
 */

import { randomUUID } from "crypto";
import { directPairProductsFromImages, DirectPairImageInput } from "./directPairing.js";

// Upstash Redis REST API helpers
async function redisSet(key: string, value: string, exSeconds: number): Promise<void> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  
  if (!url || !token) {
    throw new Error("UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN not configured");
  }

  const response = await fetch(`${url}/setex/${encodeURIComponent(key)}/${exSeconds}/${encodeURIComponent(value)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Redis SETEX failed: ${response.status} ${await response.text()}`);
  }
}

async function redisGet(key: string): Promise<string | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  
  if (!url || !token) {
    throw new Error("UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN not configured");
  }

  const response = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Redis GET failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  return data.result;
}

export interface DirectPairingJob {
  jobId: string;
  userId: string;
  status: "pending" | "processing" | "completed" | "failed";
  images: DirectPairImageInput[];
  result?: any;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

const JOB_TTL = 3600; // 1 hour
const JOB_KEY_PREFIX = "direct-pairing-job:";

/**
 * Schedule a direct pairing job
 * Returns job ID immediately, processing happens in background
 */
export async function scheduleDirectPairingJob(
  userId: string,
  images: DirectPairImageInput[]
): Promise<string> {
  const jobId = randomUUID();

  const job: DirectPairingJob = {
    jobId,
    userId,
    status: "pending",
    images,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  // Store job in Redis
  await redisSet(
    `${JOB_KEY_PREFIX}${jobId}`,
    JSON.stringify(job),
    JOB_TTL
  );

  // Trigger background processing (don't await)
  processDirectPairingJobBackground(jobId).catch((err) => {
    console.error(`[directPairingJobs] Background job ${jobId} failed:`, err);
  });

  return jobId;
}

/**
 * Get job status
 */
export async function getDirectPairingJobStatus(
  jobId: string
): Promise<DirectPairingJob | null> {
  const data = await redisGet(`${JOB_KEY_PREFIX}${jobId}`);

  if (!data) {
    return null;
  }

  return JSON.parse(data) as DirectPairingJob;
}

/**
 * Process a direct pairing job in the background
 * This runs without blocking the HTTP response
 */
async function processDirectPairingJobBackground(jobId: string): Promise<void> {
  const key = `${JOB_KEY_PREFIX}${jobId}`;

  try {
    // Get job
    const data = await redisGet(key);
    if (!data) {
      throw new Error(`Job ${jobId} not found`);
    }

    const job: DirectPairingJob = JSON.parse(data);

    // Update status to processing
    job.status = "processing";
    job.updatedAt = Date.now();
    await redisSet(key, JSON.stringify(job), JOB_TTL);

    console.log(`[directPairingJobs] Processing job ${jobId} with ${job.images.length} images`);

    // Run direct pairing (this can take 60+ seconds)
    const result = await directPairProductsFromImages(job.images);

    // Update job with results
    job.status = "completed";
    job.result = result;
    job.updatedAt = Date.now();
    await redisSet(key, JSON.stringify(job), JOB_TTL);

    console.log(`[directPairingJobs] Job ${jobId} completed with ${result.products.length} products`);
  } catch (err) {
    console.error(`[directPairingJobs] Job ${jobId} failed:`, err);

    // Update job with error
    try {
      const data = await redisGet(key);
      if (data) {
        const job: DirectPairingJob = JSON.parse(data);
        job.status = "failed";
        job.error = err instanceof Error ? err.message : "Unknown error";
        job.updatedAt = Date.now();
        await redisSet(key, JSON.stringify(job), JOB_TTL);
      }
    } catch (updateErr) {
      console.error(`[directPairingJobs] Failed to update job ${jobId} error state:`, updateErr);
    }
  }
}
