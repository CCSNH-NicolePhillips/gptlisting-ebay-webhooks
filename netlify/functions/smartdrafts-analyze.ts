import type { Handler } from "@netlify/functions";
import { getOrigin, isOriginAllowed, jsonResponse } from "../../src/lib/http.js";

/**
 * GET /.netlify/functions/smartdrafts-analyze?folder=<url>&force=<bool>
 * 
 * Wrapper around smartdrafts-scan-bg that:
 * 1. Enqueues a scan job via smartdrafts-scan-bg
 * 2. Polls smartdrafts-scan-status until done
 * 3. Returns the analysis VisionOutput
 * 
 * This is a convenience endpoint for the new UI to avoid client-side polling.
 * For now, it redirects to using the existing scan-bg/scan-status flow.
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

  // For now, return instructions to use the existing scan endpoints
  // TODO: Implement auto-enqueue + poll wrapper
  return jsonResponse(200, {
    message: "Use smartdrafts-scan-bg + smartdrafts-scan-status for now",
    hint: "POST to smartdrafts-scan-bg, then poll smartdrafts-scan-status with the jobId",
    folder,
    force,
    endpoints: {
      enqueue: "/.netlify/functions/smartdrafts-scan-bg",
      status: "/.netlify/functions/smartdrafts-scan-status?jobId=<id>"
    }
  }, originHdr, methods);
};
