import { Handler } from "@netlify/functions";
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

    // If job is processing and needs another chunk, trigger it
    if (status.status === "processing" && status.processedCount < status.dropboxPaths.length) {
      const baseUrl = process.env.APP_URL || 'https://ebaywebhooks.netlify.app';
      const processorUrl = `${baseUrl}/.netlify/functions/pairing-v2-processor?jobId=${jobId}`;
      
      // Trigger next chunk (fire and forget - client will poll again)
      fetch(processorUrl, { method: 'POST' }).catch((err) => {
        console.error(`[pairing-v2-status] Failed to trigger next chunk:`, err);
      });
    }

    return json(200, status, originHdr);
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
