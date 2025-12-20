/**
 * Background job management for pairing-v2
 * Uses Upstash Redis REST API to store job state
 */

import { randomUUID } from "crypto";
import type { PairingResult } from "../smartdrafts/pairing-v2-core.js";

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
  uploadMethod: "dropbox" | "local";
  
  // Dropbox-specific fields
  dropboxPaths?: string[];
  dropboxFilenames?: string[]; // Original filenames (parallel to dropboxPaths)
  accessToken?: string; // Store access token for background download
  
  // Local upload fields
  stagedUrls?: string[]; // URLs of uploaded files
  
  // Chunked processing state
  processedCount: number; // How many images have been classified
  classifications: any[]; // Accumulated classifications from all chunks
  lastChunkTriggered?: number; // Timestamp of last chunk trigger (prevents duplicates)
  
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
  imagePaths: string[],
  accessToken?: string,
  originalFilenames?: string[]
): Promise<string> {
  const jobId = randomUUID();

  // Determine if this is Dropbox or local upload based on presence of accessToken
  const uploadMethod = accessToken ? "dropbox" : "local";

  const job: PairingV2Job = {
    jobId,
    userId,
    status: "pending",
    folder,
    uploadMethod,
    processedCount: 0,
    classifications: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  // Add method-specific fields
  if (uploadMethod === "dropbox") {
    job.dropboxPaths = imagePaths;
    job.dropboxFilenames = originalFilenames; // Store original filenames
    job.accessToken = accessToken;
  } else {
    job.stagedUrls = imagePaths;
  }

  // Store job in Redis
  await redisSet(
    `${JOB_KEY_PREFIX}${jobId}`,
    JSON.stringify(job),
    JOB_TTL
  );

  // Trigger processor immediately (fire-and-forget)
  // Client polls will re-trigger if this fails
  const baseUrl = process.env.APP_URL || 'https://ebaywebhooks.netlify.app';
  const processorUrl = `${baseUrl}/.netlify/functions/pairing-v2-processor-background?jobId=${jobId}`;
  
  console.log(`[schedulePairingV2Job] Triggering processor: ${processorUrl}`);
  
  fetch(processorUrl, { method: 'POST' }).catch((err) => {
    console.error(`[schedulePairingV2Job] Failed to trigger processor (will retry on poll):`, err);
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
