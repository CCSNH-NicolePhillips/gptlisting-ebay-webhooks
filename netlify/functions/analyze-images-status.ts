import type { Handler } from '../../src/types/api-handler.js';
import { getJob } from "../../src/lib/job-store.js";
import { getOrigin, isAuthorized, isOriginAllowed, jsonResponse } from "../../src/lib/http.js";

type HeadersMap = Record<string, string | undefined>;

export const handler: Handler = async (event) => {
  const headers = event.headers as HeadersMap;
  const originHdr = getOrigin(headers);
  const methods = "GET, OPTIONS";

  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(200, {}, originHdr, methods);
  }

  if (event.httpMethod !== "GET") {
    return jsonResponse(405, { error: "Method not allowed" }, originHdr, methods);
  }

  if (!isOriginAllowed(originHdr)) {
    return jsonResponse(403, { error: "Forbidden" }, originHdr, methods);
  }

  if (!isAuthorized(headers)) {
    return jsonResponse(401, { error: "Unauthorized" }, originHdr, methods);
  }

  const jobId = (event.queryStringParameters?.jobId || "").trim();
  if (!jobId) {
    return jsonResponse(400, { error: "Missing jobId" }, originHdr, methods);
  }

  try {
    const data = await getJob(jobId);
    if (!data) {
      return jsonResponse(404, { error: "Job not found" }, originHdr, methods);
    }

    return jsonResponse(200, data, originHdr, methods);
  } catch (err) {
    console.error("[status] Failed to read job", err);
    return jsonResponse(500, { error: "Failed to read job" }, originHdr, methods);
  }
};
