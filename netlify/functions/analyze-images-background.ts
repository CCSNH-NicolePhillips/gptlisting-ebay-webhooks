import type { Handler } from "@netlify/functions";
import { runAnalysis } from "../../src/lib/analyze-core.js";
import { putJob } from "../../src/lib/job-store.js";
import { k } from "../../src/lib/user-keys.js";
import { sanitizeUrls, toDirectDropbox } from "../../src/lib/merge.js";

interface BackgroundPayload {
  jobId?: string;
  images?: string[];
  batchSize?: number;
  userId?: string;
}

export const handler: Handler = async (event) => {
  let jobId: string | undefined;
  let userId: string | undefined;
  let jobKey: string | undefined;

  try {
    const body: BackgroundPayload = JSON.parse(event.body || "{}");
    jobId = body.jobId;
    userId = typeof body.userId === "string" && body.userId.trim() ? body.userId.trim() : undefined;
    jobKey = userId && jobId ? k.job(userId, jobId) : undefined;
    const images = Array.isArray(body.images) ? body.images : [];
    const rawBatch = Number(body.batchSize);
    const batchSize = Number.isFinite(rawBatch) ? Math.min(Math.max(rawBatch, 4), 12) : 12;

    if (!jobId) {
      throw new Error("Missing jobId in background payload");
    }

    const sanitizedImages = sanitizeUrls(images).map(toDirectDropbox);

    if (!sanitizedImages.length) {
      await putJob(jobId, {
        jobId,
        userId,
        state: "error",
        finishedAt: Date.now(),
        error: "No images provided",
      }, { key: jobKey });
      return { statusCode: 200 };
    }

    await putJob(jobId, { jobId, userId, state: "running", startedAt: Date.now() }, { key: jobKey });

    try {
      const result = await runAnalysis(sanitizedImages, batchSize);
      await putJob(jobId, {
        jobId,
        userId,
        state: "complete",
        finishedAt: Date.now(),
        status: "ok",
        info: result.info,
        summary: result.summary,
        warnings: result.warnings,
        groups: result.groups,
      }, { key: jobKey });
    } catch (err: any) {
      await putJob(jobId, {
        jobId,
        userId,
        state: "error",
        finishedAt: Date.now(),
        error: err?.message || "Unknown error",
      }, { key: jobKey });
    }
  } catch (err) {
    console.error("Background worker crashed:", err);
    if (jobId) {
      const message = err instanceof Error ? err.message : "Unexpected error";
      await putJob(jobId, {
        jobId,
        userId,
        state: "error",
        finishedAt: Date.now(),
        error: message,
      }, { key: jobKey });
    }
  }

  return { statusCode: 200 };
};
