import type { Handler } from "@netlify/functions";
import crypto from "crypto";
import { runAnalysis } from "../../src/lib/analyze-core.js";
import { getOrigin, isAuthorized, isOriginAllowed, jsonResponse } from "../../src/lib/http.js";
import { putJob } from "../../src/lib/job-store.js";
import { sanitizeUrls, toDirectDropbox } from "../../src/lib/merge.js";

type BackgroundRequest = {
  images?: string[];
  batchSize?: number;
};

type HeadersMap = Record<string, string | undefined>;

function parsePayload(eventBody: string | null | undefined): BackgroundRequest {
  if (!eventBody) return {};
  try {
    return JSON.parse(eventBody);
  } catch {
    return {};
  }
}

export const handler: Handler = async (event) => {
  const headers = event.headers as HeadersMap;
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

  const payload = parsePayload(event.body);
  const rawImages = Array.isArray(payload.images) ? payload.images : [];
  const images = sanitizeUrls(rawImages).map(toDirectDropbox);

  if (images.length === 0) {
    return jsonResponse(400, { error: "No valid image URLs provided." }, originHdr, methods);
  }

  const rawBatch = Number(payload.batchSize);
  const batchSize = Number.isFinite(rawBatch) ? Math.min(Math.max(rawBatch, 4), 20) : 12;

  const jobId = crypto.randomUUID();

  try {
    await putJob(jobId, {
      jobId,
      state: "pending",
      createdAt: Date.now(),
      summary: null,
    });
  } catch (err) {
    console.error("[bg] Failed to enqueue job", err);
    return jsonResponse(500, { error: "Failed to enqueue job" }, originHdr, methods);
  }

  (async () => {
    try {
      await putJob(jobId, { jobId, state: "running", startedAt: Date.now() });
      const result = await runAnalysis(images, batchSize);
      await putJob(jobId, {
        jobId,
        state: "complete",
        finishedAt: Date.now(),
        status: "ok",
        info: result.info,
        summary: result.summary,
        warnings: result.warnings,
        groups: result.groups,
      });
    } catch (err: any) {
      console.error("[bg] Background analysis failed", err);
      const message = err?.message || "Unknown error";
      await putJob(jobId, {
        jobId,
        state: "error",
        finishedAt: Date.now(),
        error: message,
      });
    }
  })();

  return jsonResponse(200, { jobId }, originHdr, methods);
};
