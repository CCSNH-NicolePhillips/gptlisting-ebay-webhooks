import type { Handler } from "@netlify/functions";
import { runAnalysis } from "../../src/lib/analyze-core.js";
import { putJob } from "../../src/lib/job-store.js";
import { sanitizeUrls, toDirectDropbox } from "../../src/lib/merge.js";

interface BackgroundPayload {
  jobId?: string;
  images?: string[];
  batchSize?: number;
}

export const handler: Handler = async (event) => {
  let jobId: string | undefined;

  try {
    const body: BackgroundPayload = JSON.parse(event.body || "{}");
    jobId = body.jobId;
    const { images = [], batchSize = 12 } = body;

    if (!jobId) {
      throw new Error("Missing jobId in background payload");
    }

    const sanitizedImages = sanitizeUrls(images).map(toDirectDropbox);

    if (!sanitizedImages.length) {
      await putJob(jobId, {
        jobId,
        state: "error",
        finishedAt: Date.now(),
        error: "No images provided",
      });
      return { statusCode: 200 };
    }

    await putJob(jobId, { jobId, state: "running", startedAt: Date.now() });

    try {
      const result = await runAnalysis(sanitizedImages, batchSize);
      await putJob(jobId, {
        jobId,
        state: "complete",
        finishedAt: Date.now(),
        status: "ok",
        info: result.info,
        summary: result.summary,
        warnings: result.warnings,
        groups: result.groups,
      });
    } catch (err: any) {
      await putJob(jobId, {
        jobId,
        state: "error",
        finishedAt: Date.now(),
        error: err?.message || "Unknown error",
      });
    }
  } catch (err) {
    console.error("Background worker crashed:", err);
    if (jobId) {
      const message = err instanceof Error ? err.message : "Unexpected error";
      await putJob(jobId, {
        jobId,
        state: "error",
        finishedAt: Date.now(),
        error: message,
      });
    }
  }

  return { statusCode: 200 };
};
