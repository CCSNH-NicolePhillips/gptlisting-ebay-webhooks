import type { Handler } from "@netlify/functions";
import crypto from "crypto";
import { requireAdminAuth } from "../../src/lib/auth-admin.js";
import { getOrigin, isOriginAllowed, json } from "../../src/lib/http.js";
import { putJob } from "../../src/lib/job-store.js";
import { k } from "../../src/lib/user-keys.js";
import { sanitizeUrls, toDirectDropbox } from "../../src/lib/merge.js";

type BackgroundRequest = {
  images?: string[];
  batchSize?: number;
  userId?: string;
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
    return json(200, {}, originHdr, methods);
  }

  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" }, originHdr, methods);
  }

  if (!isOriginAllowed(originHdr)) {
    return json(403, { error: "Forbidden" }, originHdr, methods);
  }

  try {
    requireAdminAuth(headers.authorization || headers.Authorization);
  } catch {
    return json(401, { error: "Unauthorized" }, originHdr, methods);
  }

  const ctype = event.headers["content-type"] || event.headers["Content-Type"] || "";
  if (!ctype.includes("application/json")) {
    return json(415, { error: "Use application/json" }, originHdr, methods);
  }

  const payload = parsePayload(event.body);
  const rawImages = Array.isArray(payload.images) ? payload.images : [];
  const images = sanitizeUrls(rawImages).map(toDirectDropbox);

  if (images.length === 0) {
    return json(400, { error: "No valid image URLs provided." }, originHdr, methods);
  }

  const rawBatch = Number(payload.batchSize);
  const batchSize = Number.isFinite(rawBatch) ? Math.min(Math.max(rawBatch, 4), 12) : 12;
  const userId = typeof payload.userId === "string" && payload.userId.trim() ? payload.userId.trim() : undefined;

  const jobId = crypto.randomUUID();
  const jobKey = userId ? k.job(userId, jobId) : undefined;

  try {
    await putJob(jobId, {
      jobId,
      userId,
      state: "pending",
      createdAt: Date.now(),
      summary: null,
    }, { key: jobKey });
  } catch (err) {
    console.error("[bg-trigger] Failed to enqueue job", err);
    return json(500, { error: "Failed to enqueue job" }, originHdr, methods);
  }

  const baseUrl =
    process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL || "https://ebaywebhooks.netlify.app";
  const backgroundUrl = `${baseUrl.replace(/\/$/, "")}/.netlify/functions/analyze-images-background`;

  const trigger = fetch(backgroundUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId, images, batchSize, userId }),
  })
    .then(async (res) => {
      if (res.ok) return;
      const detail = await res.text().catch(() => "");
      const message = detail ? `${res.status} ${res.statusText}: ${detail}` : `${res.status} ${res.statusText}`;
      console.error("[bg-trigger] Background worker returned non-OK", {
        jobId,
        status: res.status,
        statusText: res.statusText,
        detail: detail?.slice(0, 500),
      });
      await putJob(jobId, {
        jobId,
        userId,
        state: "error",
        finishedAt: Date.now(),
        error: message,
      }, { key: jobKey });
    })
    .catch(async (err: any) => {
      console.error("[bg-trigger] Failed to start background worker", err);
      const message = err?.message || "Failed to start background worker";
      await putJob(jobId, {
        jobId,
        userId,
        state: "error",
        finishedAt: Date.now(),
        error: message,
      }, { key: jobKey });
    });

  trigger.catch(() => {});

  return json(200, { jobId }, originHdr, methods);
};
