import type { Handler } from "@netlify/functions";
import { fetchJobDetail } from "../../src/lib/job-analytics.js";
import { getOrigin, isAuthorized, isOriginAllowed, jsonResponse } from "../../src/lib/http.js";

type HeadersMap = Record<string, string | undefined>;
const METHODS = "GET, OPTIONS";

export const handler: Handler = async (event) => {
  const headers = event.headers as HeadersMap;
  const originHdr = getOrigin(headers);
  const fetchSite = (headers["sec-fetch-site"] || headers["Sec-Fetch-Site"] || "").toString().toLowerCase();
  const originAllowed = isOriginAllowed(originHdr);

  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(200, {}, originHdr, METHODS);
  }

  if (event.httpMethod !== "GET") {
    return jsonResponse(405, { error: "Method not allowed" }, originHdr, METHODS);
  }

  if (!originAllowed && fetchSite !== "same-origin") {
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
    const job = await fetchJobDetail(jobId);
    if (!job) {
      return jsonResponse(404, { error: "Job not found" }, originHdr, METHODS);
    }

    return jsonResponse(200, { job }, originHdr, METHODS);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse(500, { error: "Failed to load job", detail: message }, originHdr, METHODS);
  }
};
