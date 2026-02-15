import type { Handler } from '../../src/types/api-handler.js';
import crypto from "crypto";
import { requireUserAuth } from "../../src/lib/auth-user.js";
import { getOrigin, isOriginAllowed, json } from "../../src/lib/http.js";
import { putJob } from "../../src/lib/job-store.js";
import { k } from "../../src/lib/user-keys.js";

const METHODS = "POST, OPTIONS";

type HeadersMap = Record<string, string | undefined>;

type CreateDraftsRequest = {
  products?: any[];
  promotion?: {
    enabled: boolean;
    rate: number | null;
  };
};

export const handler: Handler = async (event) => {
  const headers = event.headers as HeadersMap;
  const originHdr = getOrigin(headers);

  if (event.httpMethod === "OPTIONS") {
    return json(200, {}, originHdr, METHODS);
  }

  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Method not allowed" }, originHdr, METHODS);
  }

  if (!isOriginAllowed(originHdr)) {
    return json(403, { ok: false, error: "Forbidden" }, originHdr, METHODS);
  }

  let user;
  try {
    user = await requireUserAuth(headers.authorization || headers.Authorization);
  } catch {
    return json(401, { ok: false, error: "Unauthorized" }, originHdr, METHODS);
  }

  const ctype = (headers["content-type"] || headers["Content-Type"] || "").toLowerCase();
  if (!ctype.includes("application/json")) {
    return json(415, { ok: false, error: "Use application/json" }, originHdr, METHODS);
  }

  let payload: CreateDraftsRequest = {};
  try {
    payload = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, { ok: false, error: "Invalid JSON" }, originHdr, METHODS);
  }

  const products = Array.isArray(payload?.products) ? payload.products : [];
  if (products.length === 0) {
    return json(400, { ok: false, error: "Provide products array" }, originHdr, METHODS);
  }

  const promotion = payload?.promotion || { enabled: false, rate: null };

  const jobId = crypto.randomUUID();
  const jobKey = k.job(user.userId, jobId);

  try {
    await putJob(jobId, {
      jobId,
      userId: user.userId,
      state: "pending",
      createdAt: Date.now(),
      totalProducts: products.length,
      processedProducts: 0,
    }, { key: jobKey });
  } catch (err) {
    console.error("[smartdrafts-create-drafts-bg] failed to enqueue job", err);
    return json(500, { ok: false, error: "Failed to enqueue job" }, originHdr, METHODS);
  }

  const baseUrl =
    process.env.APP_URL || process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL || "https://draftpilot-ai.netlify.app";
  const target = `${baseUrl.replace(/\/$/, "")}/.netlify/functions/smartdrafts-create-drafts-background`;

  try {
    const resp = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId, userId: user.userId, products, promotion }),
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      await putJob(jobId, {
        jobId,
        userId: user.userId,
        state: "error",
        finishedAt: Date.now(),
        error: `${resp.status} ${resp.statusText}: ${detail.slice(0, 300)}`,
      }, { key: jobKey });
      return json(502, { ok: false, error: "Background invoke failed", jobId }, originHdr, METHODS);
    }
  } catch (err: any) {
    await putJob(jobId, {
      jobId,
      userId: user.userId,
      state: "error",
      finishedAt: Date.now(),
      error: err?.message || "fetch failed",
    }, { key: jobKey });
    console.error("[smartdrafts-create-drafts-bg] background fetch failed", err);
    return json(502, { ok: false, error: "Background fetch exception", jobId }, originHdr, METHODS);
  }

  console.log(JSON.stringify({ evt: "smartdrafts-create-drafts.enqueued", userId: user.userId, jobId, productCount: products.length }));
  return json(200, { ok: true, jobId }, originHdr, METHODS);
};
