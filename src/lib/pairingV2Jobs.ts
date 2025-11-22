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
  dropboxPaths: string[];
  accessToken: string; // Store access token for background download
  
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
    processedCount: 0,
    classifications: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  // Store job in Redis
  await redisSet(
    `${JOB_KEY_PREFIX}${jobId}`,
    JSON.stringify(job),
    JOB_TTL
  );

  // Status endpoint will trigger processor on first poll
  // (No fire-and-forget - more reliable in Netlify's execution model)

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
