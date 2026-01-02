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

/**
 * Get temporary download links for Dropbox files
 * IMPORTANT: Returns same-length array with empty strings for failed links to preserve index alignment
 */
async function getDropboxTemporaryLinks(accessToken: string, paths: string[]): Promise<string[]> {
  const links: string[] = [];
  
  // Get temp links in parallel (batch of 25 at a time to avoid rate limits)
  for (let i = 0; i < paths.length; i += 25) {
    const batch = paths.slice(i, i + 25);
    const batchPromises = batch.map(async (path) => {
      try {
        const response = await fetch("https://api.dropboxapi.com/2/files/get_temporary_link", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ path }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error(`Failed to get temp link for ${path}: ${response.status} ${errorText}`);
          return ""; // Return empty string to preserve index alignment
        }

        const data: any = await response.json();
        return data.link || "";
      } catch (err) {
        console.error(`Error getting temp link for ${path}:`, err);
        return ""; // Return empty string to preserve index alignment
      }
    });

    const batchLinks = await Promise.all(batchPromises);
    // Push all results (including empty strings) to preserve index alignment
    links.push(...batchLinks);
  }

  return links;
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
    const { folder, files } = body;

    if (!folder || typeof folder !== "string") {
      return json(400, { error: "Missing or invalid folder parameter" }, originHdr);
    }

    // files is optional - if provided, only process those specific files
    const selectedFiles: string[] | undefined = Array.isArray(files) ? files.filter(f => typeof f === 'string') : undefined;

    console.log("[smartdrafts-pairing-v2-start] Request", {
      userId: userAuth.userId,
      folder,
      selectedFilesCount: selectedFiles?.length ?? 'all',
    });

    // Get Dropbox refresh token
    const dropboxData = await tokensStore().get(userScopedKey(userAuth.userId, "dropbox.json"), { type: "json" }) as any;

    if (!dropboxData?.refresh_token) {
      return json(400, { error: "Dropbox not connected. Please connect your Dropbox account first." }, originHdr);
    }

    const dropboxRefreshToken = dropboxData.refresh_token;

    // Get Dropbox access token
    const accessToken = await dropboxAccessToken(dropboxRefreshToken);

    // List images in folder
    let imagePaths = await listDropboxImages(accessToken, folder);

    // If specific files were selected, filter to only those
    if (selectedFiles && selectedFiles.length > 0) {
      const selectedPathsLower = new Set(selectedFiles.map(p => p.toLowerCase()));
      imagePaths = imagePaths.filter(p => selectedPathsLower.has(p.toLowerCase()));
      console.log("[smartdrafts-pairing-v2-start] Filtered to selected files", {
        requested: selectedFiles.length,
        matched: imagePaths.length,
      });
    }

    if (imagePaths.length === 0) {
      return json(400, { error: "No images found in folder" }, originHdr);
    }

    console.log("[smartdrafts-pairing-v2-start] Found images", {
      count: imagePaths.length,
      samplePaths: imagePaths.slice(0, 3),
    });

    // Extract original filenames from paths
    const originalFilenames = imagePaths.map(p => p.split('/').pop() || 'unknown.jpg');

    // DEFER temp link fetching to background processor to avoid timeout
    // For small batches (<=25 images), fetch links now for faster startup
    // For larger batches, pass Dropbox paths and let processor fetch links
    let linksOrPaths: string[];
    let needsTempLinks = false;
    
    if (imagePaths.length <= 25) {
      // Small batch - get temp links now
      const tempLinks = await getDropboxTemporaryLinks(accessToken, imagePaths);
      const validLinkCount = tempLinks.filter(link => link).length;
      if (validLinkCount === 0) {
        return json(500, { error: "Failed to get temporary links for any images" }, originHdr);
      }
      linksOrPaths = tempLinks;
      console.log("[smartdrafts-pairing-v2-start] Got temporary links for small batch:", validLinkCount, "of", imagePaths.length);
    } else {
      // Large batch - pass Dropbox paths, processor will fetch temp links
      linksOrPaths = imagePaths;
      needsTempLinks = true;
      console.log("[smartdrafts-pairing-v2-start] Deferring temp link fetch for large batch:", imagePaths.length);
    }

    // Schedule the job (returns immediately with job ID)
    // IMPORTANT: Always pass originalDropboxPaths so processor can create persistent shared links
    console.log("[smartdrafts-pairing-v2-start] 🔑 userId for job:", userAuth.userId);
    console.log("[smartdrafts-pairing-v2-start]   Contains pipe: " + userAuth.userId.includes('|'));
    console.log("[smartdrafts-pairing-v2-start]   Original filenames:", originalFilenames.slice(0, 5));
    
    const jobId = await schedulePairingV2Job(
      userAuth.userId, 
      folder, 
      linksOrPaths, 
      accessToken, 
      originalFilenames,
      needsTempLinks,
      imagePaths // Always pass original Dropbox file paths for shared link creation
    );

    console.log("[smartdrafts-pairing-v2-start] ✓ Job scheduled:", jobId);

    return json(
      202, // Accepted
      {
        ok: true,
        jobId,
        message: "Pairing-v2 job started",
        imageCount: linksOrPaths.length,
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
