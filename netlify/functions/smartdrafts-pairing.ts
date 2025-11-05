import type { Handler } from "@netlify/functions";
import { getOrigin, isOriginAllowed, jsonResponse } from "../../src/lib/http.js";

/**
 * POST /.netlify/functions/smartdrafts-pairing
 * Body: { overrides?: Record<string, any> }
 * 
 * Runs the pairing algorithm from src/pairing/ on analysis results
 * Returns { pairing: PairingResult, metrics?: Metrics }
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

  const ctype = headers["content-type"] || headers["Content-Type"] || "";
  if (!ctype.includes("application/json")) {
    return jsonResponse(415, { error: "Use application/json" }, originHdr, methods);
  }

  let payload: { overrides?: Record<string, any> } = {};
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (err) {
    return jsonResponse(400, { error: "Invalid JSON" }, originHdr, methods);
  }

  // TODO: Call runPairing from src/pairing/ with the analysis results
  // Need to either pass analysis in body or retrieve from cache
  return jsonResponse(501, {
    error: "Not yet implemented",
    message: "smartdrafts-pairing needs to integrate src/pairing/runPairing.ts",
    overrides: payload.overrides || {}
  }, originHdr, methods);
};
