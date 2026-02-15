import type { Handler } from '../../src/types/api-handler.js';
import { requireAdminAuth } from "../../src/lib/auth-admin.js";
import { getOrigin, isOriginAllowed, json } from "../../src/lib/http.js";
import { fetchJobDetail } from "../../src/lib/job-analytics.js";

type HeadersMap = Record<string, string | undefined>;
const METHODS = "GET, OPTIONS";

function statusFromError(err: unknown): number {
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (/upstash/i.test(message)) return 503;
  return 500;
}

export const handler: Handler = async (event) => {
  const headers = event.headers as HeadersMap;
  const originHdr = getOrigin(headers);

  if (event.httpMethod === "OPTIONS") {
    return json(200, {}, originHdr, METHODS);
  }

  if (event.httpMethod !== "GET") {
    return json(405, { error: "Method not allowed" }, originHdr, METHODS);
  }

  if (!isOriginAllowed(originHdr)) {
    return json(403, { error: "Forbidden" }, originHdr, METHODS);
  }

  try {
    requireAdminAuth(headers.authorization || headers.Authorization);
  } catch {
    return json(401, { error: "Unauthorized" }, originHdr, METHODS);
  }

  const jobId = (event.queryStringParameters?.jobId || "").trim();
  if (!jobId) {
    return json(400, { error: "Missing jobId" }, originHdr, METHODS);
  }

  try {
    const job = await fetchJobDetail(jobId);
    if (!job) {
      console.log(JSON.stringify({ evt: "analyze-job.done", ok: false, jobId, missing: true }));
      return json(404, { error: "Job not found" }, originHdr, METHODS);
    }

    console.log(
      JSON.stringify({ evt: "analyze-job.done", ok: true, jobId, state: job?.state }),
    );
  return json(200, { job }, originHdr, METHODS);
  } catch (err) {
    console.error("[analyze-job] lookup failed", err);
    const status = statusFromError(err);
    const message = err instanceof Error ? err.message : "Failed to load job";
  return json(status, { error: message }, originHdr, METHODS);
  }
};
