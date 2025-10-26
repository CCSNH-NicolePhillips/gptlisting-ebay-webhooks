import type { Handler } from "@netlify/functions";
import { getOrigin, isAuthorized, isOriginAllowed, jsonResponse } from "../../src/lib/http.js";
import { listJobs } from "../../src/lib/job-store.js";

type HeadersMap = Record<string, string | undefined>;
const METHODS = "GET, OPTIONS";

function parseLimit(raw: string | undefined | null): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return 50;
  return Math.min(Math.max(Math.trunc(value), 1), 200);
}

function statusFromError(err: unknown): number {
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (/upstash/i.test(message)) return 503;
  if (/unauthorised|unauthorized/i.test(message)) return 401;
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

  const limit = parseLimit(event.queryStringParameters?.limit);

  try {
    const jobs = await listJobs(limit);
    console.log(
      JSON.stringify({ evt: "analyze-jobs.done", ok: true, count: jobs.length, limit }),
    );
    return jsonResponse(200, { jobs, count: jobs.length }, originHdr, METHODS);
  } catch (err) {
    console.error("[analyze-jobs] list failed", err);
    const status = statusFromError(err);
    const message = err instanceof Error ? err.message : "Failed to fetch jobs";
    return jsonResponse(status, { error: message }, originHdr, METHODS);
  }
};
