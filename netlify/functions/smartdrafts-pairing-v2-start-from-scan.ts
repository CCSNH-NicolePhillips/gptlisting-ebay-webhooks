/**
 * Start a pairing-v2 job from an existing scan job
 * This endpoint bridges Quick List (which uses scan jobs) with pairing-v2
 */

import { Handler } from "@netlify/functions";
import { requireUserAuth } from "../../src/lib/auth-user.js";
import { schedulePairingV2Job } from "../../src/lib/pairingV2Jobs.js";
import { tokensStore } from "../../src/lib/_blobs.js";
import { userScopedKey } from "../../src/lib/_auth.js";
import fetch from "node-fetch";

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

/**
 * Exchange Dropbox refresh token for access token
 */
async function dropboxAccessToken(refreshToken: string): Promise<string> {
  const clientId = process.env.DROPBOX_CLIENT_ID;
  const clientSecret = process.env.DROPBOX_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Dropbox client credentials not configured");
  }

  const response = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Dropbox token refresh failed: ${response.status} ${errorText}`);
  }

  const data: any = await response.json();
  return data.access_token;
}

/**
 * Get scan job data from Redis
 */
async function getScanJobData(userId: string, jobId: string): Promise<any> {
  const BASE = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
  const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!BASE || !TOKEN) {
    throw new Error("Redis not configured");
  }

  // Scan jobs use the format: job:${userId}:${jobId}
  const url = `${BASE}/GET/${encodeURIComponent(`job:${userId}:${jobId}`)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });

  if (!res.ok) {
    throw new Error(`Scan job not found: ${jobId}`);
  }

  const jsonData = (await res.json()) as { result: unknown };
  const val = jsonData.result;

  if (typeof val !== "string" || !val) {
    throw new Error(`Scan job data invalid: ${jobId}`);
  }

  return JSON.parse(val);
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
      console.error("[pairing-v2-start-from-scan] Auth failed", err);
      return json(401, { error: "Unauthorized" }, originHdr);
    }

    // Parse request
    const body = JSON.parse(event.body || "{}");
    const { scanJobId, uploadMethod } = body;

    if (!scanJobId || typeof scanJobId !== "string") {
      return json(400, { error: "Missing or invalid scanJobId parameter" }, originHdr);
    }

    console.log("[pairing-v2-start-from-scan] Request", {
      userId: userAuth.userId,
      scanJobId,
      uploadMethod,
    });

    // Get scan job data
    const scanJob = await getScanJobData(userAuth.userId, scanJobId);

    console.log("[pairing-v2-start-from-scan] Scan job data:", {
      state: scanJob.state,
      hasStagedUrls: !!scanJob.stagedUrls,
      stagedUrlsCount: scanJob.stagedUrls?.length || 0,
      hasFolder: !!scanJob.folder,
      hasGroups: !!scanJob.groups,
      groupsCount: scanJob.groups?.length || 0,
      keys: Object.keys(scanJob),
    });

    if (scanJob.state !== "complete") {
      return json(400, { error: `Scan job not complete (state: ${scanJob.state})` }, originHdr);
    }

    // Determine upload method and extract image paths
    let imagePaths: string[] = [];
    let folder = "";

    // Both local and Dropbox modes should have stagedUrls from the scan job
    if (scanJob.stagedUrls) {
      // Files are already staged in R2/S3 (or empty array if no images)
      imagePaths = scanJob.stagedUrls;
      folder = scanJob.folder || "local-upload";
      console.log("[pairing-v2-start-from-scan] Using staged URLs from scan job", { 
        imageCount: imagePaths.length,
        folder,
      });
    } else if (scanJob.groups && scanJob.groups.length > 0) {
      // Fallback: extract stagedUrls from groups (older scan format)
      const groups = scanJob.groups || [];
      imagePaths = groups.flatMap((g: any) => g.images || []);
      folder = scanJob.folder || "extracted-from-groups";
      console.log("[pairing-v2-start-from-scan] Extracted staged URLs from groups", { 
        imageCount: imagePaths.length,
        folder,
      });
    } else {
      return json(400, { error: "Scan job has no image data (missing stagedUrls and groups)" }, originHdr);
    }

    if (imagePaths.length === 0) {
      // Return success with empty result instead of error - this is a valid case
      return json(200, { 
        jobId: null,
        message: "No images to pair (empty folder or all files filtered out)",
        pairs: [],
        unpaired: [],
      }, originHdr);
    }

    console.log("[pairing-v2-start-from-scan] Found images", {
      count: imagePaths.length,
      samplePaths: imagePaths.slice(0, 3),
    });

    // Schedule the pairing-v2 job (no accessToken needed - using staged URLs)
    const jobId = await schedulePairingV2Job(userAuth.userId, folder, imagePaths, undefined);

    console.log("[pairing-v2-start-from-scan] Job scheduled:", jobId);

    return json(
      202, // Accepted
      {
        ok: true,
        jobId,
        message: "Pairing-v2 job started from scan",
        imageCount: imagePaths.length,
        uploadMethod: scanJob.stagedUrls ? "local" : "dropbox",
      },
      originHdr
    );
  } catch (err) {
    console.error("[pairing-v2-start-from-scan] Error:", err);
    return json(
      500,
      {
        error: err instanceof Error ? err.message : "Unknown error",
      },
      originHdr
    );
  }
};
