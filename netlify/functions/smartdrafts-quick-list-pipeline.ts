/**
 * Quick List Pipeline: All-in-one background processor
 * 
 * Combines: Pairing-v2 → Draft Creation in a single job
 * This avoids the timeout issues with separate polling loops
 */

import type { Handler } from '../../src/types/api-handler.js';
import { requireUserAuth } from "../../src/lib/auth-user.js";
import { randomUUID } from "crypto";

// Redis helpers
async function redisSet(key: string, value: string, exSeconds: number): Promise<void> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  
  if (!url || !token) {
    throw new Error("Redis not configured");
  }

  const response = await fetch(`${url}/setex/${encodeURIComponent(key)}/${exSeconds}/${encodeURIComponent(value)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Redis SETEX failed: ${response.status}`);
  }
}

async function redisGet(key: string): Promise<string | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  
  if (!url || !token) {
    throw new Error("Redis not configured");
  }

  const response = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Redis GET failed: ${response.status}`);
  }

  const data = await response.json();
  return data.result || null;
}

interface QuickListJob {
  jobId: string;
  userId: string;
  status: "pending" | "pairing" | "creating-drafts" | "completed" | "failed";
  scanJobId: string; // Original scan job ID
  
  // Progress tracking
  currentStage: "pairing" | "drafts" | "complete";
  pairingResult?: {
    pairs: Array<{ front: string; back: string; frontUrl: string; backUrl: string }>;
    unpaired: Array<{ imagePath: string; reason: string }>;
  };
  
  drafts?: any[];
  error?: string;
  createdAt: number;
  updatedAt: number;
}

const JOB_TTL = 3600; // 1 hour
const JOB_KEY_PREFIX = "quick-list-job:";

function json(status: number, body: any) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    },
    body: JSON.stringify(body),
  };
}

export const handler: Handler = async (event) => {
  try {
    // Handle OPTIONS for CORS
    if (event.httpMethod === "OPTIONS") {
      return json(200, {});
    }

    // POST: Start new job
    if (event.httpMethod === "POST") {
      // Require authentication
      const headers = event.headers || {};
      const user = await requireUserAuth(
        headers.authorization || headers.Authorization || headers["x-forwarded-authorization"] || ""
      );

      const body = JSON.parse(event.body || "{}");
      const { scanJobId } = body;

      if (!scanJobId) {
        return json(400, { error: "Missing scanJobId" });
      }

      // Create job
      const jobId = randomUUID();
      const job: QuickListJob = {
        jobId,
        userId: user.userId,
        status: "pending",
        scanJobId,
        currentStage: "pairing",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await redisSet(`${JOB_KEY_PREFIX}${jobId}`, JSON.stringify(job), JOB_TTL);

      // Trigger background processor
      const baseUrl = process.env.APP_URL || 'https://ebaywebhooks.netlify.app';
      const processorUrl = `${baseUrl}/.netlify/functions/smartdrafts-quick-list-processor?jobId=${jobId}`;
      
      fetch(processorUrl, { method: 'POST' }).catch((err) => {
        console.error(`[quick-list-pipeline] Failed to trigger processor:`, err);
      });

      return json(200, { ok: true, jobId });
    }

    // GET: Check status
    if (event.httpMethod === "GET") {
      const headers = event.headers || {};
      await requireUserAuth(
        headers.authorization || headers.Authorization || headers["x-forwarded-authorization"] || ""
      );

      const jobId = event.queryStringParameters?.jobId;
      if (!jobId) {
        return json(400, { error: "Missing jobId parameter" });
      }

      const data = await redisGet(`${JOB_KEY_PREFIX}${jobId}`);
      if (!data) {
        return json(404, { error: "Job not found" });
      }

      const job: QuickListJob = JSON.parse(data);
      return json(200, job);
    }

    return json(405, { error: "Method not allowed" });
  } catch (err) {
    console.error("[quick-list-pipeline] Error:", err);
    return json(500, { error: err instanceof Error ? err.message : "Unknown error" });
  }
};
