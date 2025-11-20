/**
 * Background job management for direct pairing
 * Uses Redis to store job state and Netlify background functions to process
 */

import { randomUUID } from "crypto";
import { createClient } from "redis";
import { directPairProductsFromImages, DirectPairImageInput } from "./directPairing.js";

// Simple Redis client helper
function getRedisClient() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL not configured");
  }
  return createClient({ url: redisUrl });
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
  const redis = getRedisClient();
  await redis.connect();
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
  await redis.setex(
    `${JOB_KEY_PREFIX}${jobId}`,
    JOB_TTL,
    JSON.stringify(job)
  );

  await redis.disconnect();

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
  const redis = getRedisClient();
  await redis.connect();
  const data = await redis.get(`${JOB_KEY_PREFIX}${jobId}`);
  await redis.disconnect();

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
  const redis = getRedisClient();
  await redis.connect();
  const key = `${JOB_KEY_PREFIX}${jobId}`;

  try {
    // Get job
    const data = await redis.get(key);
    if (!data) {
      throw new Error(`Job ${jobId} not found`);
    }

    const job: DirectPairingJob = JSON.parse(data);

    // Update status to processing
    job.status = "processing";
    job.updatedAt = Date.now();
    await redis.setex(key, JOB_TTL, JSON.stringify(job));

    console.log(`[directPairingJobs] Processing job ${jobId} with ${job.images.length} images`);

    // Run direct pairing (this can take 60+ seconds)
    const result = await directPairProductsFromImages(job.images);

    // Update job with results
    job.status = "completed";
    job.result = result;
    job.updatedAt = Date.now();
    await redis.setex(key, JOB_TTL, JSON.stringify(job));

    console.log(`[directPairingJobs] Job ${jobId} completed with ${result.products.length} products`);
    
    await redis.disconnect();
  } catch (err) {
    console.error(`[directPairingJobs] Job ${jobId} failed:`, err);

    // Update job with error
    try {
      const data = await redis.get(key);
      if (data) {
        const job: DirectPairingJob = JSON.parse(data);
        job.status = "failed";
        job.error = err instanceof Error ? err.message : "Unknown error";
        job.updatedAt = Date.now();
        await redis.setex(key, JOB_TTL, JSON.stringify(job));
      }
      await redis.disconnect();
    } catch (updateErr) {
      console.error(`[directPairingJobs] Failed to update job ${jobId} error state:`, updateErr);
      try {
        await redis.disconnect();
      } catch {}
    }
  }
}
