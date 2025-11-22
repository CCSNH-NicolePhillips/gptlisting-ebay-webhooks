/**
 * Background job management for pairing-v2
 * Uses Upstash Redis REST API to store job state
 */

import { randomUUID } from "crypto";
import { runNewTwoStagePipeline, type PairingResult } from "../smartdrafts/pairing-v2-core.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

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

export interface PairingV2Job {
  jobId: string;
  userId: string;
  status: "pending" | "processing" | "completed" | "failed";
  folder: string;
  dropboxPaths: string[];
  accessToken: string; // Store access token for background download
  result?: PairingResult;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

const JOB_TTL = 3600; // 1 hour
const JOB_KEY_PREFIX = "pairing-v2-job:";

/**
 * Schedule a pairing-v2 job
 * Returns job ID immediately, processing happens in background
 */
export async function schedulePairingV2Job(
  userId: string,
  folder: string,
  dropboxPaths: string[],
  accessToken: string
): Promise<string> {
  const jobId = randomUUID();

  const job: PairingV2Job = {
    jobId,
    userId,
    status: "pending",
    folder,
    dropboxPaths,
    accessToken,
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
  processPairingV2JobBackground(jobId).catch((err) => {
    console.error(`[pairingV2Jobs] Background job ${jobId} failed:`, err);
  });

  return jobId;
}

/**
 * Get job status
 */
export async function getPairingV2JobStatus(
  jobId: string
): Promise<PairingV2Job | null> {
  const data = await redisGet(`${JOB_KEY_PREFIX}${jobId}`);

  if (!data) {
    return null;
  }

  return JSON.parse(data) as PairingV2Job;
}

/**
 * Process a pairing-v2 job in the background
 * This runs without blocking the HTTP response
 */
async function processPairingV2JobBackground(jobId: string): Promise<void> {
  const key = `${JOB_KEY_PREFIX}${jobId}`;
  let workDir: string | null = null;

  try {
    // Get job
    const data = await redisGet(key);
    if (!data) {
      throw new Error(`Job ${jobId} not found`);
    }

    const job: PairingV2Job = JSON.parse(data);

    // Update status to processing
    job.status = "processing";
    job.updatedAt = Date.now();
    await redisSet(key, JSON.stringify(job), JOB_TTL);

    console.log(`[pairingV2Jobs] Processing job ${jobId} with ${job.dropboxPaths.length} images...`);

    // Create temp directory for downloads
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pairing-v2-"));

    // Download images from Dropbox
    const localPaths: string[] = [];
    for (const dropboxPath of job.dropboxPaths) {
      const filename = path.basename(dropboxPath);
      const localPath = path.join(workDir, filename);

      // Download image from Dropbox
      const response = await fetch("https://content.dropboxapi.com/2/files/download", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${job.accessToken}`,
          "Dropbox-API-Arg": JSON.stringify({ path: dropboxPath }),
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to download ${dropboxPath}: ${response.status}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(localPath, buffer);
      localPaths.push(localPath);
    }

    console.log(`[pairingV2Jobs] Downloaded ${localPaths.length} images to ${workDir}`);

    // Run the three-stage pairing pipeline
    const result = await runNewTwoStagePipeline(localPaths);

    // Clean up temp directory
    if (workDir) {
      fs.rmSync(workDir, { recursive: true, force: true });
      workDir = null;
    }

    // Convert local paths back to basenames for result
    const basenamePairs = result.pairs.map(pair => ({
      ...pair,
      front: path.basename(pair.front),
      back: path.basename(pair.back),
    }));

    const basenameUnpaired = result.unpaired.map(item => ({
      ...item,
      imagePath: path.basename(item.imagePath),
    }));

    const finalResult: PairingResult = {
      pairs: basenamePairs,
      unpaired: basenameUnpaired,
      metrics: result.metrics,
    };

    // Update job with result
    job.status = "completed";
    job.result = finalResult;
    job.updatedAt = Date.now();
    // Clear access token from completed job for security
    job.accessToken = "";
    await redisSet(key, JSON.stringify(job), JOB_TTL);

    console.log(`[pairingV2Jobs] Job ${jobId} completed: ${finalResult.pairs.length} pairs`);
  } catch (error) {
    console.error(`[pairingV2Jobs] Job ${jobId} failed:`, error);

    // Clean up temp directory on error
    if (workDir) {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch (cleanupErr) {
        console.error(`[pairingV2Jobs] Failed to cleanup ${workDir}:`, cleanupErr);
      }
    }

    // Update job with error
    const data = await redisGet(key);
    if (data) {
      const job: PairingV2Job = JSON.parse(data);
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      job.updatedAt = Date.now();
      // Clear access token from failed job for security
      job.accessToken = "";
      await redisSet(key, JSON.stringify(job), JOB_TTL);
    }
  }
}
