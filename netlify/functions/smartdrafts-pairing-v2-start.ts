/**
 * Start a pairing-v2 job in the background
 * Returns a job ID that can be polled for results
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
 * List images in Dropbox folder
 */
async function listDropboxImages(accessToken: string, folder: string): Promise<string[]> {
  const response = await fetch("https://api.dropboxapi.com/2/files/list_folder", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      path: folder === "/" ? "" : folder,
      recursive: false,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Dropbox list_folder failed: ${response.status} ${errorText}`);
  }

  const data: any = await response.json();
  const imageExtensions = [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"];

  return (data.entries || [])
    .filter((entry: any) => {
      if (entry[".tag"] !== "file") return false;
      const ext = entry.name.toLowerCase().slice(entry.name.lastIndexOf("."));
      return imageExtensions.includes(ext);
    })
    .map((entry: any) => entry.path_display || entry.path_lower);
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
      console.error("[smartdrafts-pairing-v2-start] Auth failed", err);
      return json(401, { error: "Unauthorized" }, originHdr);
    }

    // Parse request
    const body = JSON.parse(event.body || "{}");
    const { folder } = body;

    if (!folder || typeof folder !== "string") {
      return json(400, { error: "Missing or invalid folder parameter" }, originHdr);
    }

    console.log("[smartdrafts-pairing-v2-start] Request", {
      userId: userAuth.userId,
      folder,
    });

    // Get Dropbox refresh token
    const dropboxRefreshToken = await tokensStore().get(userScopedKey(userAuth.userId, "dropbox"));

    if (!dropboxRefreshToken) {
      return json(400, { error: "Dropbox not connected. Please connect your Dropbox account first." }, originHdr);
    }

    // Get Dropbox access token
    const accessToken = await dropboxAccessToken(dropboxRefreshToken);

    // List images in folder
    const imagePaths = await listDropboxImages(accessToken, folder);

    if (imagePaths.length === 0) {
      return json(400, { error: "No images found in folder" }, originHdr);
    }

    console.log("[smartdrafts-pairing-v2-start] Found images", {
      count: imagePaths.length,
      samplePaths: imagePaths.slice(0, 3),
    });

    // Schedule the job (returns immediately with job ID)
    // Pass Dropbox paths and access token for background download
    const jobId = await schedulePairingV2Job(userAuth.userId, folder, imagePaths, accessToken);

    console.log("[smartdrafts-pairing-v2-start] Job scheduled:", jobId);

    return json(
      202, // Accepted
      {
        ok: true,
        jobId,
        message: "Pairing-v2 job started",
        imageCount: imagePaths.length,
      },
      originHdr
    );
  } catch (err) {
    console.error("[smartdrafts-pairing-v2-start] Error:", err);
    return json(
      500,
      {
        error: err instanceof Error ? err.message : "Unknown error",
      },
      originHdr
    );
  }
};
