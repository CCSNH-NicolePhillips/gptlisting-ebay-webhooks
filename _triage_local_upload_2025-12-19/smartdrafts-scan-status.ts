import type { Handler } from "@netlify/functions";
import { requireUserAuth } from "../../src/lib/auth-user.js";
import { getOrigin, isOriginAllowed, json } from "../../src/lib/http.js";
import { getJob } from "../../src/lib/job-store.js";
import { k } from "../../src/lib/user-keys.js";

type HeadersMap = Record<string, string | undefined>;

const METHODS = "GET, OPTIONS";

export const handler: Handler = async (event) => {
  const headers = event.headers as HeadersMap;
  const originHdr = getOrigin(headers);

  if (event.httpMethod === "OPTIONS") {
    return json(200, {}, originHdr, METHODS);
  }

  if (event.httpMethod !== "GET") {
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

  const jobId = (event.queryStringParameters?.jobId || "").trim();
  if (!jobId) {
    return json(400, { ok: false, error: "Missing jobId" }, originHdr, METHODS);
  }

  try {
    const job = await getJob(jobId, { key: k.job(user.userId, jobId) });
    if (!job) {
      return json(404, { ok: false, error: "Job not found" }, originHdr, METHODS);
    }
    return json(200, job, originHdr, METHODS);
  } catch (err) {
    console.error("[smartdrafts-scan-status] job lookup failed", err);
    return json(500, { ok: false, error: "Failed to read job" }, originHdr, METHODS);
  }
};