/**
 * Start a pairing-v2 job for locally uploaded images (stagedUrls)
 * Returns a job ID that can be polled for results
 */

import { Handler } from "@netlify/functions";
import { requireUserAuth } from "../../src/lib/auth-user.js";
import { schedulePairingV2Job } from "../../src/lib/pairingV2Jobs.js";

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

    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method not allowed" }, originHdr);
    }

    // Require authentication
    const headers = event.headers || {};
    let userAuth;
    try {
      userAuth = await requireUserAuth(
        headers.authorization || headers.Authorization || headers["x-forwarded-authorization"] || ""
      );
    } catch (err) {
      console.error("[smartdrafts-pairing-v2-start-local] Auth failed", err);
      return json(401, { error: "Unauthorized" }, originHdr);
    }

    // Parse request
    const body = JSON.parse(event.body || "{}");
    const { stagedUrls } = body;

    if (!stagedUrls || !Array.isArray(stagedUrls) || stagedUrls.length === 0) {
      return json(400, { error: "Missing or invalid stagedUrls parameter (must be non-empty array)" }, originHdr);
    }

    console.log("[smartdrafts-pairing-v2-start-local] Request", {
      userId: userAuth.userId,
      imageCount: stagedUrls.length,
      sampleUrls: stagedUrls.slice(0, 3),
    });

    // Schedule the job (returns immediately with job ID)
    // Pass stagedUrls for local upload mode (no accessToken)
    const jobId = await schedulePairingV2Job(
      userAuth.userId,
      "", // Empty folder for local uploads
      stagedUrls,
      undefined // No accessToken = local mode
    );

    console.log("[smartdrafts-pairing-v2-start-local] Job scheduled:", jobId);

    return json(
      202, // Accepted
      {
        ok: true,
        jobId,
        message: "Pairing-v2 job started",
        imageCount: stagedUrls.length,
      },
      originHdr
    );
  } catch (err) {
    console.error("[smartdrafts-pairing-v2-start-local] Error:", err);
    return json(
      500,
      {
        error: err instanceof Error ? err.message : "Unknown error",
      },
      originHdr
    );
  }
};
