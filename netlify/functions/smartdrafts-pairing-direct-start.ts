/**
 * Start a direct pairing job in the background
 * Returns a job ID that can be polled for results
 */

import { Handler } from "@netlify/functions";
import { requireUserAuth } from "../../src/lib/auth-user.js";
import { scheduleDirectPairingJob } from "../../src/lib/directPairingJobs.js";

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
      console.error("[smartdrafts-pairing-direct-start] Auth failed", err);
      return json(401, { error: "Unauthorized" }, originHdr);
    }

    // Parse request
    const body = JSON.parse(event.body || "{}");
    const { images } = body;

    if (!images || !Array.isArray(images)) {
      return json(400, { error: "Missing or invalid images array" }, originHdr);
    }

    console.log("[smartdrafts-pairing-direct-start] Request", {
      imageCount: images.length,
      sampleFilenames: images.slice(0, 3).map((i: any) => i.filename),
    });

    // Schedule the job (returns immediately with job ID)
    const jobId = await scheduleDirectPairingJob(userAuth.userId, images);

    console.log("[smartdrafts-pairing-direct-start] Job scheduled:", jobId);

    return json(
      202, // Accepted
      {
        ok: true,
        jobId,
        message: "Direct pairing job started",
      },
      originHdr
    );
  } catch (err) {
    console.error("[smartdrafts-pairing-direct-start] Error:", err);
    return json(
      500,
      {
        error: err instanceof Error ? err.message : "Unknown error",
      },
      originHdr
    );
  }
};
