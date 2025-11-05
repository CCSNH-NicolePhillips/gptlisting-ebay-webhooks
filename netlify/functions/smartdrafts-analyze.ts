import type { Handler } from "@netlify/functions";
import { getOrigin, isOriginAllowed, jsonResponse } from "../../src/lib/http.js";

/**
 * GET /.netlify/functions/smartdrafts-analyze?folder=<url>&force=<bool>
 * 
 * Combines dropbox-list-images + analyze-images-bg-user flow
 * Returns VisionOutput format for the new SmartDrafts UI
 */

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

  // TODO: Wire to existing smartdrafts-scan-bg flow or create new analyze pipeline
  // For now, return a stub that shows the function exists
  return jsonResponse(501, { 
    error: "Not yet implemented",
    message: "smartdrafts-analyze needs to wire dropbox-list-images + analyze-images-bg",
    folder,
    force
  }, originHdr, methods);
};
