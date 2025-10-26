import type { Handler } from "@netlify/functions";
import { fetchJobSummaries } from "../../src/lib/job-analytics.js";
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

  const rawLimit = event.queryStringParameters?.limit ?? "";
  const parsedLimit = Number(rawLimit);
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(Math.max(Math.trunc(parsedLimit), 1), 200)
    : 50;

  try {
    const jobs = await fetchJobSummaries(limit);
    return jsonResponse(200, { jobs }, originHdr, METHODS);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse(500, { error: "Failed to load jobs", detail: message }, originHdr, METHODS);
  }
};
