import type { Handler } from '../../src/types/api-handler.js';
import { requireUserAuth } from "../../src/lib/auth-user.js";
import { getPairingV2JobStatus } from "../../src/lib/pairingV2Jobs.js";

function json(status: number, body: any, headers: Record<string, string> = {}) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

export const handler: Handler = async (event) => {
  const originHdr = {};

  try {
    // Handle OPTIONS for CORS
    if (event.httpMethod === "OPTIONS") {
      return json(200, {}, originHdr);
    }

    if (event.httpMethod !== "GET") {
      return json(405, { error: "Method not allowed" }, originHdr);
    }

    // Require authentication
    const headers = event.headers || {};
    try {
      await requireUserAuth(
        headers.authorization || headers.Authorization || headers["x-forwarded-authorization"] || ""
      );
    } catch (err) {
      console.error("[smartdrafts-pairing-v2-status] Auth failed", err);
      return json(401, { error: "Unauthorized" }, originHdr);
    }

    // Get job ID from query params
    const jobId = event.queryStringParameters?.jobId;
    if (!jobId) {
      return json(400, { error: "Missing jobId parameter" }, originHdr);
    }

    // Get job status
    const status = await getPairingV2JobStatus(jobId);

    if (!status) {
      return json(404, { error: "Job not found" }, originHdr);
    }

    // If job is pending and needs work, trigger processor
    // Also detect stale "processing" jobs that crashed without updating status
    const totalImages = (status.dropboxPaths || status.stagedUrls || []).length;
    const needsWork = status.processedCount < totalImages;
    const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
    const isStale = status.status === "processing" && (Date.now() - status.updatedAt) > STALE_THRESHOLD_MS;
    
    console.log(`[pairing-v2-status] Job ${jobId} status check:`, {
      status: status.status,
      totalImages,
      processedCount: status.processedCount,
      needsWork,
      isStale,
      ageMs: Date.now() - status.updatedAt,
    });
    
    // Reset stale "processing" jobs back to "pending" so they can be re-triggered
    if (isStale) {
      console.warn(`[pairing-v2-status] ⚠️ Job ${jobId} stuck in processing for ${Math.round((Date.now() - status.updatedAt) / 1000)}s — resetting to pending`);
      status.status = "pending";
      status.updatedAt = Date.now();
      // Update Redis directly
      const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
      const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
      if (redisUrl && redisToken) {
        const key = `pairing-v2-job:${jobId}`;
        fetch(`${redisUrl}/setex/${encodeURIComponent(key)}/3600/${encodeURIComponent(JSON.stringify(status))}`, {
          headers: { Authorization: `Bearer ${redisToken}` },
        }).catch((err) => {
          console.error(`[pairing-v2-status] Failed to reset stale job:`, err);
        });
      }
    }
    
    // Trigger processor for pending jobs (including freshly-reset stale ones)
    if (needsWork && status.status === "pending") {
      const baseUrl = process.env.APP_URL || 'https://ebaywebhooks.netlify.app';
      const processorUrl = `${baseUrl}/.netlify/functions/pairing-v2-processor-background?jobId=${jobId}`;
      
      console.log(`[pairing-v2-status] Triggering processor: ${processorUrl}`);
      
      // Trigger background function (fire and forget - client will poll again)
      // This pattern is reliable because:
      // - Client polls every few seconds (retries if trigger fails)
      // - Redis locks prevent duplicate processing
      // - Idempotent processor design
      // - Stale jobs are auto-reset above
      fetch(processorUrl, { method: 'POST' }).catch((err) => {
        console.error(`[pairing-v2-status] Failed to trigger processor:`, err);
      });
    }

    // Return job data with dropboxAccessToken for thumbnail fetching
    const response = {
      ...status,
      dropboxAccessToken: status.accessToken, // Expose for UI thumbnail fetching
    };
    
    // Don't expose the full accessToken field for security
    delete (response as any).accessToken;

    return json(200, response, originHdr);
  } catch (err) {
    console.error("[smartdrafts-pairing-v2-status] Error:", err);
    return json(
      500,
      {
        error: err instanceof Error ? err.message : "Unknown error",
      },
      originHdr
    );
  }
};
