import type { Handler } from "@netlify/functions";
import crypto from "node:crypto";
import { requireUserAuth } from "../../src/lib/auth-user.js";
import { getOrigin, isOriginAllowed, json, parseAllowedOrigins } from "../../src/lib/http.js";
import { putJob } from "../../src/lib/job-store.js";
import { k } from "../../src/lib/user-keys.js";
import { canStartJob, incRunning, decRunning } from "../../src/lib/quota.js";

const METHODS = "POST, OPTIONS";
const MAX_IMAGES = Math.max(1, Math.min(100, Number(process.env.SMARTDRAFT_MAX_IMAGES || 100)));

type HeadersMap = Record<string, string | undefined>;

type ScanRequest = {
  path?: string;
  stagedUrls?: string[]; // NEW: Support direct file URLs from ingestion system
  force?: boolean;
  limit?: number;
  debug?: boolean | string;
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
    console.error("[smartdrafts-scan-bg] Origin not allowed:", originHdr, "Allowed:", parseAllowedOrigins());
    return json(403, { ok: false, error: "Forbidden", origin: originHdr, allowed: parseAllowedOrigins() }, originHdr, METHODS);
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

  let payload: ScanRequest = {};
  try {
    payload = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, { ok: false, error: "Invalid JSON" }, originHdr, METHODS);
  }

  // Support either folder path OR staged URLs (but not both)
  const folder = typeof payload?.path === "string" ? payload.path.trim() : "";
  const stagedUrls = Array.isArray(payload?.stagedUrls) ? payload.stagedUrls : [];
  
  if (!folder && stagedUrls.length === 0) {
    return json(400, { ok: false, error: "Provide either 'path' (Dropbox folder) or 'stagedUrls' (uploaded files)" }, originHdr, METHODS);
  }
  
  if (folder && stagedUrls.length > 0) {
    return json(400, { ok: false, error: "Provide either 'path' or 'stagedUrls', not both" }, originHdr, METHODS);
  }

  const force = Boolean(payload?.force);
  const limitRaw = Number(payload?.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_IMAGES) : MAX_IMAGES;
  const debugRaw = payload?.debug;
  const debugEnabled = typeof debugRaw === "string"
    ? ["1", "true", "yes", "debug"].includes(debugRaw.toLowerCase())
    : Boolean(debugRaw);

  try {
    const allowed = await canStartJob(user.userId);
    if (!allowed) {
      return json(429, { ok: false, error: "Too many running jobs" }, originHdr, METHODS);
    }
  } catch (err) {
    console.error("[smartdrafts-scan-bg] failed to check running quota", err);
    return json(500, { ok: false, error: "Failed to evaluate job quota" }, originHdr, METHODS);
  }

  let reserved = false;
  try {
    await incRunning(user.userId);
    reserved = true;
  } catch (err) {
    console.error("[smartdrafts-scan-bg] failed to reserve running slot", err);
    return json(500, { ok: false, error: "Failed to reserve job slot" }, originHdr, METHODS);
  }

  const jobId = crypto.randomUUID();
  const jobKey = k.job(user.userId, jobId);

  try {
    await putJob(jobId, {
      jobId,
      userId: user.userId,
      state: "pending",
      createdAt: Date.now(),
      folder: folder || undefined,
      stagedUrls: stagedUrls.length > 0 ? stagedUrls : undefined,
      options: { force, limit, debug: debugEnabled },
    }, { key: jobKey });
  } catch (err) {
    await decRunning(user.userId).catch(() => {});
    console.error("[smartdrafts-scan-bg] failed to enqueue job", err);
    return json(500, { ok: false, error: "Failed to enqueue job" }, originHdr, METHODS);
  }

  const baseUrl =
    process.env.APP_URL || process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL || "https://draftpilot-ai.netlify.app";
  const target = `${baseUrl.replace(/\/$/, "")}/.netlify/functions/smartdrafts-scan-background`;

  try {
    const resp = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        jobId, 
        userId: user.userId, 
        folder: folder || undefined,
        stagedUrls: stagedUrls.length > 0 ? stagedUrls : undefined,
        force, 
        limit, 
        debug: debugEnabled 
      }),
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      await putJob(jobId, {
        jobId,
        userId: user.userId,
        state: "error",
        finishedAt: Date.now(),
        folder: folder || undefined,
        stagedUrls: stagedUrls.length > 0 ? stagedUrls : undefined,
        error: `${resp.status} ${resp.statusText}: ${detail.slice(0, 300)}`,
      }, { key: jobKey });
      await decRunning(user.userId).catch(() => {});
      return json(502, { ok: false, error: "Background invoke failed", jobId }, originHdr, METHODS);
    }
  } catch (err: any) {
    await putJob(jobId, {
      jobId,
      userId: user.userId,
      state: "error",
      finishedAt: Date.now(),
      folder: folder || undefined,
      stagedUrls: stagedUrls.length > 0 ? stagedUrls : undefined,
      error: err?.message || "fetch failed",
    }, { key: jobKey });
    await decRunning(user.userId).catch(() => {});
    console.error("[smartdrafts-scan-bg] background fetch failed", err);
    return json(502, { ok: false, error: "Background fetch exception", jobId }, originHdr, METHODS);
  }

  console.log(JSON.stringify({ 
    evt: "smartdrafts-scan.enqueued", 
    userId: user.userId, 
    jobId, 
    folder: folder || undefined,
    stagedUrlCount: stagedUrls.length || undefined
  }));
  return json(200, { ok: true, jobId }, originHdr, METHODS);
};