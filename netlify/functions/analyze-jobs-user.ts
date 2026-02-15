import type { Handler } from '../../src/types/api-handler.js';
import { requireUserAuth } from "../../src/lib/auth-user.js";
import { getOrigin, isOriginAllowed, json } from "../../src/lib/http.js";
import { listJobsForUser } from "../../src/lib/job-store-user.js";

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

  try {
    const jobs = await listJobsForUser(user.userId, 50);
    const simplified = jobs.map((job: any) => ({
      jobId: job.jobId,
      state: job.state,
      startedAt: job.startedAt ?? null,
      finishedAt: job.finishedAt ?? null,
      totalGroups: job.summary?.totalGroups ?? 0,
      warningsCount: Array.isArray(job.warnings) ? job.warnings.length : 0,
    }));

    return json(200, { jobs: simplified }, originHdr, methods);
  } catch (err) {
    console.error("[analyze-jobs-user] list failed", err);
    return json(500, { error: "Failed to list jobs" }, originHdr, methods);
  }
};
