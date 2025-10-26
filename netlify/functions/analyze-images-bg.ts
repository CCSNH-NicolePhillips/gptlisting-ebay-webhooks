import type { Handler } from "@netlify/functions";
import crypto from "crypto";
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
  const batchSize = Number.isFinite(rawBatch) ? Math.min(Math.max(rawBatch, 4), 12) : 12;

  const jobId = crypto.randomUUID();

  try {
    await putJob(jobId, {
      jobId,
      state: "pending",
      createdAt: Date.now(),
      summary: null,
    });
  } catch (err) {
    console.error("[bg-trigger] Failed to enqueue job", err);
    return jsonResponse(500, { error: "Failed to enqueue job" }, originHdr, methods);
  }

  const baseUrl =
    process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL || "https://ebaywebhooks.netlify.app";
  const backgroundUrl = `${baseUrl.replace(/\/$/, "")}/.netlify/functions/analyze-images-background`;

  const trigger = fetch(backgroundUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId, images, batchSize }),
  }).catch(async (err: any) => {
    console.error("[bg-trigger] Failed to start background worker", err);
    const message = err?.message || "Failed to start background worker";
    await putJob(jobId, {
      jobId,
      state: "error",
      finishedAt: Date.now(),
      error: message,
    });
  });

  trigger.catch(() => {});

  return jsonResponse(200, { jobId }, originHdr, methods);
};
