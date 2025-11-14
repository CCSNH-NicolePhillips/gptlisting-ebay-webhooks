import type { Handler } from "@netlify/functions";
import { createHash } from "node:crypto";
import { USE_CLIP, USE_NEW_SORTER, USE_ROLE_SORTING } from "../../src/config.js";
import { putJob, redisSet } from "../../src/lib/job-store.js";
import { decRunning } from "../../src/lib/quota.js";
import { runSmartDraftScan, type SmartDraftScanResponse } from "../../src/lib/smartdrafts-scan-core.js";
import { k } from "../../src/lib/user-keys.js";

type BackgroundPayload = {
  jobId?: string;
  userId?: string;
  folder?: string;
  stagedUrls?: string[];
  force?: boolean;
  limit?: number;
  debug?: boolean;
};

function parsePayload(raw: string | null | undefined): BackgroundPayload {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error("[smartdrafts-scan-background] invalid JSON", { preview: raw?.slice(0, 200) });
    return {};
  }
}

async function writeJob(jobId: string, userId: string | undefined, data: Record<string, unknown>) {
  const jobKey = userId ? k.job(userId, jobId) : undefined;
  await putJob(jobId, { jobId, userId, ...data }, { key: jobKey });
}

export const handler: Handler = async (event) => {
  const body = parsePayload(event.body);
  const jobId = typeof body.jobId === "string" ? body.jobId : undefined;
  const userId = typeof body.userId === "string" ? body.userId : undefined;

  if (!jobId || !userId) {
    if (jobId) {
      await writeJob(jobId, userId, {
        state: "error",
        error: "Missing job metadata",
        finishedAt: Date.now(),
      }).catch(() => {});
    }
    return { statusCode: 200 };
  }

  const folder = typeof body.folder === "string" ? body.folder.trim() : "";
  const stagedUrls = Array.isArray(body.stagedUrls) ? body.stagedUrls : [];
  const force = Boolean(body.force);
  const limit = Number.isFinite(body.limit) ? Number(body.limit) : undefined;
  const debugEnabled = Boolean(body.debug);

  // Log feature flags at startup
  console.log(`[Flags] USE_CLIP=${USE_CLIP} USE_NEW_SORTER=${USE_NEW_SORTER} USE_ROLE_SORTING=${USE_ROLE_SORTING}`);

  const jobKey = k.job(userId, jobId);

  const release = async () => {
    try {
      await decRunning(userId);
    } catch (err) {
      console.warn("[smartdrafts-scan-background] failed to release running slot", err);
    }
  };

  try {
    await writeJob(jobId, userId, {
      state: "running",
      startedAt: Date.now(),
      folder: folder || undefined,
      stagedUrls: stagedUrls.length > 0 ? stagedUrls : undefined,
    });

    const response: SmartDraftScanResponse = await runSmartDraftScan({
      userId,
      folder: folder || undefined,
      stagedUrls: stagedUrls.length > 0 ? stagedUrls : undefined,
      force,
      limit,
      debug: debugEnabled,
    });

    const payload = response.body;

    if (!payload?.ok) {
      const errorMessage = typeof payload?.error === "string" && payload.error
        ? payload.error
        : `Scan failed with status ${response.status}`;
      await writeJob(jobId, userId, {
        state: "error",
        folder,
        finishedAt: Date.now(),
        error: errorMessage,
        status: response.status,
      });
      await release();
      return { statusCode: 200 };
    }

    await writeJob(jobId, userId, {
      state: "complete",
      finishedAt: Date.now(),
      status: "ok",
      folder: payload.folder,
      signature: payload.signature,
      count: payload.count,
      warnings: payload.warnings,
      groups: payload.groups,
      orphans: payload.orphans,
      imageInsights: payload.imageInsights,
      cached: payload.cached,
      debug: payload.debug,
    });

    // Step 1A: Store analysis by jobId for pairing function to fetch
    const analysis = {
      groups: payload.groups,
      orphans: payload.orphans,
      imageInsights: payload.imageInsights,
      signature: payload.signature,
      jobId,
    };

    // ZF-1: Compute stable folder signature for zero-frontend lookup
    const folderSig = createHash('sha1').update(folder).digest('hex');

    try {
      // Store by jobId (existing)
      await redisSet(`analysis:${jobId}`, JSON.stringify(analysis), 60 * 60); // 1 hr TTL

      // ZF-1: Store by folder signature (so pairing can find by folder alone)
      await redisSet(`analysis:byFolder:${folderSig}`, JSON.stringify(analysis), 60 * 60);

      // ZF-1: Store lastJobId pointer for this folder
      await redisSet(`analysis:lastJobId:${folderSig}`, jobId, 60 * 60);

      console.log('[cache] write analysis', {
        jobId,
        folderSig,
        keys: [
          `analysis:${jobId}`,
          `analysis:byFolder:${folderSig}`,
          `analysis:lastJobId:${folderSig}`
        ]
      });
    } catch (err) {
      console.warn('[cache] failed to write analysis', { jobId, folderSig, err });
    }

    await release();
  } catch (err: any) {
    console.error("[smartdrafts-scan-background] execution failed", err);
    await writeJob(jobId, userId, {
      state: "error",
      finishedAt: Date.now(),
      folder,
      error: err?.message || "Unknown error",
    }).catch(() => {});
    await release();
  }

  return { statusCode: 200 };
};
