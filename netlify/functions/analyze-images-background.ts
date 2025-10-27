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

function extractHints(raw: string): Pick<BackgroundPayload, "jobId" | "userId"> {
  const hints: Pick<BackgroundPayload, "jobId" | "userId"> = {};

  if (!raw) return hints;

  try {
    const params = new URLSearchParams(raw);
    const pJob = params.get("jobId");
    const pUser = params.get("userId");
    if (pJob) hints.jobId = pJob;
    if (pUser) hints.userId = pUser;
  } catch {
    // ignore URLSearchParams failure – fall back to regex extraction below
  }

  const jobMatch = raw.match(/jobId["'\s:=]+([a-z0-9-]{6,})/i);
  if (!hints.jobId && jobMatch) {
    hints.jobId = jobMatch[1];
  }

  const userMatch = raw.match(/userId["'\s:=]+([a-z0-9-]{3,})/i);
  if (!hints.userId && userMatch) {
    hints.userId = userMatch[1];
  }

  return hints;
}

function safeParsePayload(
  raw: string | null | undefined,
): {
  payload: BackgroundPayload;
  parseError: Error | null;
  hints: Pick<BackgroundPayload, "jobId" | "userId">;
} {
  if (!raw) {
    return { payload: {} as BackgroundPayload, parseError: null, hints: {} as Pick<BackgroundPayload, "jobId" | "userId"> };
  }

  try {
    return {
      payload: JSON.parse(raw) as BackgroundPayload,
      parseError: null,
      hints: {} as Pick<BackgroundPayload, "jobId" | "userId">,
    };
  } catch (err) {
    return {
      payload: {} as BackgroundPayload,
      parseError: err instanceof Error ? err : new Error(String(err ?? "")),
      hints: extractHints(raw),
    };
  }
}

export const handler: Handler = async (event) => {
  const rawBody = event.body || "";
  const parsed = safeParsePayload(rawBody);
  let jobId: string | undefined = parsed.payload.jobId || parsed.hints.jobId;
  let userId: string | undefined = parsed.payload.userId || parsed.hints.userId;
  let jobKey: string | undefined = userId && jobId ? k.job(userId, jobId) : undefined;

  if (parsed.parseError) {
    console.error("[bg-worker] Invalid JSON payload", {
      preview: rawBody.slice(0, 200),
      jobId,
      userId,
    });

    if (jobId) {
      await putJob(jobId, {
        jobId,
        userId,
        state: "error",
        finishedAt: Date.now(),
        error: "Invalid background payload",
      }, { key: jobKey });
    }

    return { statusCode: 200 };
  }

  try {
    const body = parsed.payload;
    jobId = body.jobId;
    userId = typeof body.userId === "string" && body.userId.trim() ? body.userId.trim() : undefined;
    const derivedJobKey = userId && jobId ? k.job(userId, jobId) : undefined;
    jobKey = derivedJobKey || jobKey;
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
