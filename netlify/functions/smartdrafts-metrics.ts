import type { Handler } from "@netlify/functions";
import { getOrigin, isOriginAllowed, jsonResponse } from "../../src/lib/http.js";

/**
 * GET /.netlify/functions/smartdrafts-metrics
 * 
 * Returns aggregated metrics from recent pairing runs
 * For now, returns a minimal structure. Could be enhanced to:
 * - Track metrics in Redis
 * - Aggregate across users
 * - Show historical trends
 * 
 * Returns:
 *   200 { totals: { images, pairs, singletons }, thresholds?: {...} }
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

  // Return minimal metrics structure
  // TODO: Track and aggregate real metrics from pairing runs
  return jsonResponse(200, {
    totals: {
      images: 0,
      pairs: 0,
      singletons: 0,
      products: 0
    },
    thresholds: {
      similarityMin: 0.7,
      confidenceMin: 0.6
    },
    message: "Metrics tracking not yet implemented"
  }, originHdr, methods);
};
