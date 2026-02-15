import type { Handler } from '../../src/types/api-handler.js';
import { requireUserAuth } from "../../src/lib/auth-user.js";
import { getOrigin, isOriginAllowed, json } from "../../src/lib/http.js";
import { getJob } from "../../src/lib/job-store.js";
import { k } from "../../src/lib/user-keys.js";

type HeadersMap = Record<string, string | undefined>;

export const handler: Handler = async (event) => {
  const headers = event.headers as HeadersMap;
  const originHdr = getOrigin(headers);
  const methods = "GET, OPTIONS";

  if (event.httpMethod === "OPTIONS") {
    return json(200, {}, originHdr, methods);
  }

  if (event.httpMethod !== "GET") {
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

  const jobId = (event.queryStringParameters?.jobId || "").trim();
  if (!jobId) {
    return json(400, { error: "Missing jobId" }, originHdr, methods);
  }

  try {
    const job = await getJob(jobId, { key: k.job(user.userId, jobId) });
    if (!job) {
      return json(404, { error: "Job not found" }, originHdr, methods);
    }
    return json(200, job, originHdr, methods);
  } catch (err) {
    console.error("[analyze-images-status-user] read failed", err);
    return json(500, { error: "Failed to read job" }, originHdr, methods);
  }
};
