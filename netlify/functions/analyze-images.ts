import type { Handler } from "@netlify/functions";
import { runAnalysis } from "../../src/lib/analyze-core.js";
import { sanitizeUrls, toDirectDropbox } from "../../src/lib/merge.js";
import { getOrigin, isAuthorized, isOriginAllowed, jsonResponse } from "../../src/lib/http.js";

type AnalyzeRequest = {
  images?: string[];
  batchSize?: number;
};

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

  if (!isAuthorized(headers)) {
    return jsonResponse(401, { error: "Unauthorized" }, originHdr, methods);
  }

  const ctype = event.headers["content-type"] || event.headers["Content-Type"] || "";
  if (!ctype.includes("application/json")) {
    return jsonResponse(415, { error: "Use application/json" }, originHdr, methods);
  }

  let payload: AnalyzeRequest = {};
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (err) {
    return jsonResponse(400, { error: "Invalid JSON" }, originHdr, methods);
  }

  const rawImages = Array.isArray(payload.images) ? payload.images : [];
  const images = sanitizeUrls(rawImages).map(toDirectDropbox);

  if (images.length === 0) {
    return jsonResponse(400, { error: "No valid image URLs provided." }, originHdr, methods);
  }

  const rawBatch = Number(payload.batchSize);
  const batchSize = Number.isFinite(rawBatch) ? Math.min(Math.max(rawBatch, 4), 15) : 12;

  const result = await runAnalysis(images, batchSize);

  return jsonResponse(
    200,
    {
      status: "ok",
      ...result,
    },
    originHdr,
    methods
  );
};
