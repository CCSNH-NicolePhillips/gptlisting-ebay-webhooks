import type { Handler } from "@netlify/functions";
import { getOrigin, isAuthorized, isOriginAllowed, jsonResponse } from "../../src/lib/http.js";
import { getJob } from "../../src/lib/job-store.js";

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
    return jsonResponse(200, {}, originHdr, METHODS);
  }

  if (event.httpMethod !== "GET") {
    return jsonResponse(405, { error: "Method not allowed" }, originHdr, METHODS);
  }

  if (!isOriginAllowed(originHdr)) {
    return jsonResponse(403, { error: "Forbidden" }, originHdr, METHODS);
  }

  if (!isAuthorized(headers)) {
    return jsonResponse(401, { error: "Unauthorized" }, originHdr, METHODS);
  }

  const jobId = (event.queryStringParameters?.jobId || "").trim();
  if (!jobId) {
    return jsonResponse(400, { error: "Missing jobId" }, originHdr, METHODS);
  }

  try {
    const job = await getJob(jobId);
    if (!job) {
      console.log(JSON.stringify({ evt: "analyze-job.done", ok: false, jobId, missing: true }));
      return jsonResponse(404, { error: "Job not found" }, originHdr, METHODS);
    }

    console.log(JSON.stringify({ evt: "analyze-job.done", ok: true, jobId, state: job?.state }));
    return jsonResponse(200, { job }, originHdr, METHODS);
  } catch (err) {
    console.error("[analyze-job] lookup failed", err);
    const status = statusFromError(err);
    const message = err instanceof Error ? err.message : "Failed to load job";
    return jsonResponse(status, { error: message }, originHdr, METHODS);
  }
};
