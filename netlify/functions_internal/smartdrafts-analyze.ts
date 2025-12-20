import type { Handler } from "@netlify/functions";
import { getOrigin, isOriginAllowed, jsonResponse } from "../../src/lib/http.js";

/**
 * GET /.netlify/functions/smartdrafts-analyze?folder=<url>&force=<bool>
 * 
 * Optional convenience wrapper that polls smartdrafts-scan-bg + scan-status
 * internally and returns the final VisionOutput when complete.
 * 
 * Useful for:
 * - CLI scripts that don't want to implement polling
 * - Simple API clients that prefer blocking calls
 * 
 * NOT recommended for:
 * - UI applications (use client-side polling for progress updates)
 * - Long-running scans (risks function timeout even with 120s limit)
 * 
 * Usage:
 *   GET /.netlify/functions/smartdrafts-analyze?folder=<url>&force=true
 * 
 * Returns:
 *   200 { groups: [...], imageInsights: [...], cached: bool }
 *   400 Missing folder parameter
 *   504 Scan timeout after 120 seconds
 *   500 Scan error
 */

interface ScanStatusResponse {
  state: 'pending' | 'running' | 'complete' | 'error';
  groups?: any[];
  imageInsights?: any[];
  orphans?: any[];
  cached?: boolean;
  folder?: string;
  error?: string;
}

export const handler: Handler = async (event) => {
  const headers = event.headers as Record<string, string | undefined>;
  const originHdr = getOrigin(headers);
  const methods = "GET, OPTIONS";

  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(200, {}, originHdr, methods);
  }

  if (event.httpMethod !== "GET") {
    return jsonResponse(405, { error: "Method not allowed" }, originHdr, methods);
  }

  if (!isOriginAllowed(originHdr)) {
    return jsonResponse(403, { error: "Forbidden" }, originHdr, methods);
  }

  const folder = event.queryStringParameters?.folder || "";
  const force = event.queryStringParameters?.force === "true";

  if (!folder) {
    return jsonResponse(400, { error: "folder parameter required" }, originHdr, methods);
  }

  try {
    // Step 1: Enqueue scan job
    const baseUrl = process.env.URL || 'http://localhost:8888';
    const enqueueUrl = `${baseUrl}/.netlify/functions/smartdrafts-scan-bg`;
    
    const enqueueRes = await fetch(enqueueUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Forward auth header if present
        ...(headers.authorization ? { authorization: headers.authorization } : {})
      },
      body: JSON.stringify({ path: folder, force })
    });

    if (!enqueueRes.ok) {
      const errorText = await enqueueRes.text();
      return jsonResponse(enqueueRes.status, { 
        error: `Failed to enqueue scan: ${errorText}` 
      }, originHdr, methods);
    }

    const { jobId } = await enqueueRes.json();
    console.log(`[smartdrafts-analyze] Enqueued job ${jobId}`);

    // Step 2: Poll until complete (max 120 seconds)
    const startTime = Date.now();
    const maxWaitMs = 120_000; // 120 seconds
    const pollIntervalMs = 1500; // 1.5 seconds

    while (true) {
      // Check timeout
      if (Date.now() - startTime > maxWaitMs) {
        return jsonResponse(504, { 
          error: 'Scan timeout after 120 seconds. Job may still complete - check smartdrafts-scan-status.',
          jobId 
        }, originHdr, methods);
      }

      // Poll status
      const statusUrl = `${baseUrl}/.netlify/functions/smartdrafts-scan-status?jobId=${jobId}`;
      const statusRes = await fetch(statusUrl, {
        headers: {
          ...(headers.authorization ? { authorization: headers.authorization } : {})
        }
      });

      if (!statusRes.ok) {
        const errorText = await statusRes.text();
        return jsonResponse(statusRes.status, { 
          error: `Failed to poll status: ${errorText}` 
        }, originHdr, methods);
      }

      const job: ScanStatusResponse = await statusRes.json();

      // Check for completion
      if (job.state === 'complete') {
        console.log(`[smartdrafts-analyze] Job ${jobId} complete`);
        return jsonResponse(200, {
          groups: job.groups || [],
          imageInsights: job.imageInsights || [],
          cached: job.cached,
          folder: job.folder
        }, originHdr, methods);
      }

      // Check for error
      if (job.state === 'error') {
        console.error(`[smartdrafts-analyze] Job ${jobId} failed:`, job.error);
        return jsonResponse(500, { 
          error: job.error || 'Scan failed' 
        }, originHdr, methods);
      }

      // Still pending/running - wait and poll again
      console.log(`[smartdrafts-analyze] Job ${jobId} state: ${job.state}`);
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

  } catch (error) {
    console.error('[smartdrafts-analyze] Error:', error);
    return jsonResponse(500, { 
      error: error instanceof Error ? error.message : 'Internal server error' 
    }, originHdr, methods);
  }
};
