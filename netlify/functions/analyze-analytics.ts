import type { Handler } from '../../src/types/api-handler.js';
import { listJobs } from "../../src/lib/job-store.js";
import { getAllPriceKeys, getPriceState } from "../../src/lib/price-store.js";
import { requireAdminAuth } from "../../src/lib/auth-admin.js";
import { getOrigin, isOriginAllowed, json } from "../../src/lib/http.js";

type HeadersMap = Record<string, string | undefined>;
const METHODS = "GET, OPTIONS";

export const handler: Handler = async (event) => {
  const headers = event.headers as HeadersMap;
  const originHdr = getOrigin(headers);
  const fetchSite = (headers["sec-fetch-site"] || headers["Sec-Fetch-Site"] || "")
    .toString()
    .toLowerCase();
  const originAllowed = isOriginAllowed(originHdr);

  if (event.httpMethod === "OPTIONS") {
    return json(200, {}, originHdr, METHODS);
  }

  if (event.httpMethod !== "GET") {
    return json(405, { error: "Method not allowed" }, originHdr, METHODS);
  }

  if (!originAllowed && fetchSite !== "same-origin") {
    return json(403, { error: "Forbidden" }, originHdr, METHODS);
  }

  try {
    requireAdminAuth(headers.authorization || headers.Authorization);
  } catch {
    return json(401, { error: "Unauthorized" }, originHdr, METHODS);
  }

  try {
    const jobs = await listJobs(50);
    const summaries: Array<Record<string, unknown>> = [];

    for (const job of jobs) {
      const prefix = job.jobId ? `price:${job.jobId}:` : "";
      const priceKeys = await getAllPriceKeys(prefix);
      const prices: number[] = [];

      for (const key of priceKeys) {
        const state = await getPriceState(key);
        if (state && Number.isFinite(state.current) && state.current > 0) {
          prices.push(state.current);
        }
      }

      const avg = prices.length ? prices.reduce((acc, val) => acc + val, 0) / prices.length : 0;
      const min = prices.length ? Math.min(...prices) : 0;
      const max = prices.length ? Math.max(...prices) : 0;
      const durationSec =
        job.finishedAt && job.startedAt
          ? ((Number(job.finishedAt) - Number(job.startedAt)) / 1000).toFixed(1)
          : null;

      summaries.push({
        jobId: job.jobId,
        startedAt: job.startedAt ?? null,
        finishedAt: job.finishedAt ?? null,
        groups: job.summary?.totalGroups || 0,
        warnings: Array.isArray(job.warnings) ? job.warnings.length : 0,
        avgPrice: Number(avg.toFixed(2)),
        minPrice: Number(min.toFixed(2)),
        maxPrice: Number(max.toFixed(2)),
        durationSec,
      });
    }

    return json(200, { summaries }, originHdr, METHODS);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json(500, { error: "Failed to load analytics", detail: message }, originHdr, METHODS);
  }
};
