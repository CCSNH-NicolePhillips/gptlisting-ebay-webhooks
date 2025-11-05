import type { Handler } from "@netlify/functions";
import { getOrigin, isOriginAllowed, jsonResponse } from "../../src/lib/http.js";

/**
 * POST /.netlify/functions/smartdrafts-reset?folder=<url>
 * 
 * Clears cache/DB entries for a Dropbox folder
 * Returns { ok: true, cleared: number }
 */

export const handler: Handler = async (event) => {
  const headers = event.headers as Record<string, string | undefined>;
  const originHdr = getOrigin(headers);
  const methods = "POST, OPTIONS";

  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(200, {}, originHdr, methods);
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" }, originHdr, methods);
  }

  if (!isOriginAllowed(originHdr)) {
    return jsonResponse(403, { error: "Forbidden" }, originHdr, methods);
  }

  const folder = event.queryStringParameters?.folder || "";

  if (!folder) {
    return jsonResponse(400, { error: "folder parameter required" }, originHdr, methods);
  }

  // TODO: Clear Redis cache entries for this folder
  // Need to determine cache key pattern (likely based on folder hash/signature)
  return jsonResponse(501, {
    error: "Not yet implemented", 
    message: "smartdrafts-reset needs to clear Redis cache for folder",
    folder
  }, originHdr, methods);
};
