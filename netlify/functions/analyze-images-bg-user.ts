import type { Handler } from "@netlify/functions";
import crypto from "crypto";
import { requireUserAuth } from "../../src/lib/auth-user.js";
import { getOrigin, isOriginAllowed, json } from "../../src/lib/http.js";
import { sanitizeUrls, toDirectDropbox } from "../../src/lib/merge.js";
import { putJob } from "../../src/lib/job-store.js";
import { k } from "../../src/lib/user-keys.js";
import { canConsumeImages, consumeImages, canStartJob, incRunning, decRunning } from "../../src/lib/quota.js";

type HeadersMap = Record<string, string | undefined>;

type Payload = {
  images?: string[];
  batchSize?: number;
  force?: boolean;
};

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

  let user;
  try {
    user = await requireUserAuth(headers.authorization || headers.Authorization);
  } catch {
    return json(401, { error: "Unauthorized" }, originHdr, methods);
  }

  const ctype = headers["content-type"] || headers["Content-Type"] || "";
  if (!ctype.includes("application/json")) {
    return json(415, { error: "Use application/json" }, originHdr, methods);
  }

  let body: Payload = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON" }, originHdr, methods);
  }

  const images = sanitizeUrls(Array.isArray(body.images) ? body.images : []).map(toDirectDropbox);
  if (!images.length) {
    return json(400, { error: "No valid image URLs provided." }, originHdr, methods);
  }

  try {
    const allowedJob = await canStartJob(user.userId);
    if (!allowedJob) {
      return json(429, { error: "Too many running jobs" }, originHdr, methods);
    }

    const allowedQuota = await canConsumeImages(user.userId, images.length);
    if (!allowedQuota) {
      return json(429, { error: "Daily image quota exceeded" }, originHdr, methods);
    }
  } catch (err) {
    console.error("[analyze-images-bg-user] pre-check failure", err);
    return json(500, { error: "Failed to evaluate quota" }, originHdr, methods);
  }

  let reserved = false;
  try {
    await incRunning(user.userId);
    reserved = true;
    await consumeImages(user.userId, images.length);
  } catch (err) {
    if (reserved) {
      await decRunning(user.userId);
    }
    console.error("[analyze-images-bg-user] reservation failed", err);
    return json(500, { error: "Failed to reserve quota" }, originHdr, methods);
  }

  const rawBatch = Number(body.batchSize);
  const batchSize = Number.isFinite(rawBatch) ? Math.min(Math.max(rawBatch, 4), 12) : 12;
  const force = Boolean(body.force);

  const jobId = crypto.randomUUID();
  const jobKey = k.job(user.userId, jobId);

  try {
    await putJob(
      jobId,
      {
        jobId,
        userId: user.userId,
        state: "pending",
        createdAt: Date.now(),
        summary: null,
      },
      { key: jobKey }
    );
  } catch (err) {
    await decRunning(user.userId);
    console.error("[analyze-images-bg-user] failed to enqueue job", err);
    return json(500, { error: "Failed to enqueue job" }, originHdr, methods);
  }

  const baseUrl =
    process.env.APP_URL || process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL || "https://ebaywebhooks.netlify.app";
  const backgroundUrl = `${baseUrl.replace(/\/$/, "")}/.netlify/functions/analyze-images-background`;

  try {
    const resp = await fetch(backgroundUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId, images, batchSize, userId: user.userId, force }),
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      await putJob(
        jobId,
        {
          jobId,
          userId: user.userId,
          state: "error",
          finishedAt: Date.now(),
          error: `${resp.status} ${resp.statusText}: ${detail.slice(0, 300)}`,
        },
        { key: jobKey }
      );
      await decRunning(user.userId);
      return json(502, { error: "Background invoke failed", jobId }, originHdr, methods);
    }
  } catch (err: any) {
    await putJob(
      jobId,
      {
        jobId,
        userId: user.userId,
        state: "error",
        finishedAt: Date.now(),
        error: err?.message || "fetch failed",
      },
      { key: jobKey }
    );
    await decRunning(user.userId);
    console.error("[analyze-images-bg-user] background fetch failed", err);
    return json(502, { error: "Background fetch exception", jobId }, originHdr, methods);
  }

  console.log(
    JSON.stringify({ evt: "analyze-images-bg-user.enqueued", ok: true, userId: user.userId, jobId, count: images.length })
  );
  return json(200, { jobId }, originHdr, methods);
};
