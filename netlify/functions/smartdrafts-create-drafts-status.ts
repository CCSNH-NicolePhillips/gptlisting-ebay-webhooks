import type { Handler } from '../../src/types/api-handler.js';
import { requireUserAuth } from "../../src/lib/auth-user.js";
import { getOrigin, isOriginAllowed, json } from "../../src/lib/http.js";
import { getJob } from "../../src/lib/job-store.js";
import { k } from "../../src/lib/user-keys.js";

const METHODS = "GET, OPTIONS";

type HeadersMap = Record<string, string | undefined>;

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

  const params = event.queryStringParameters || {};
  const jobId = params.jobId || "";

  if (!jobId) {
    return json(400, { ok: false, error: "Provide jobId" }, originHdr, METHODS);
  }

  try {
    const jobKey = k.job(user.userId, jobId);
    const job = await getJob(jobId, { key: jobKey });

    if (!job) {
      return json(404, { ok: false, error: "Job not found" }, originHdr, METHODS);
    }

    return json(200, { ok: true, job }, originHdr, METHODS);
  } catch (err: any) {
    console.error("[smartdrafts-create-drafts-status] error", err);
    return json(500, { ok: false, error: err.message || String(err) }, originHdr, METHODS);
  }
};
