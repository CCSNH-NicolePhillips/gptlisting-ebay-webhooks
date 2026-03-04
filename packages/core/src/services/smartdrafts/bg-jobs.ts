/**
 * packages/core/src/services/smartdrafts/bg-jobs.ts
 *
 * Enqueue and fire background SmartDrafts jobs (scan and create-drafts).
 * The "fire" step calls the existing background Netlify function / worker URL
 * so the same worker code handles both Netlify and Railway deployments.
 */

import crypto from 'crypto';
import { putJob } from '../../../../../src/lib/job-store.js';
import { canStartJob, decRunning, incRunning } from '../../../../../src/lib/quota.js';
import { k } from '../../../../../src/lib/user-keys.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class QuotaExceededError extends Error {
  readonly statusCode = 429;
  constructor() {
    super('Too many running jobs');
    this.name = 'QuotaExceededError';
  }
}

export class BgInvokeError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 502) {
    super(message);
    this.name = 'BgInvokeError';
    this.statusCode = statusCode;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function workerBaseUrl(): string {
  return (
    process.env.APP_URL ||
    process.env.URL ||
    process.env.DEPLOY_PRIME_URL ||
    process.env.DEPLOY_URL ||
    'https://draftpilot-ai.netlify.app'
  );
}

async function invokeBackground(
  path: string,
  body: Record<string, unknown>,
  jobId: string,
  userId: string,
  jobKey: string,
): Promise<void> {
  const base = workerBaseUrl().replace(/\/$/, '');
  const target = `${base}${path}`;

  let resp: Response;
  try {
    resp = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err: any) {
    await putJob(
      jobId,
      { jobId, userId, status: 'failed', finishedAt: Date.now(), error: err?.message || 'fetch failed' },
      { key: jobKey },
    );
    throw new BgInvokeError('Background fetch exception', 502);
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    await putJob(
      jobId,
      {
        jobId,
        userId,
        status: 'failed',
        finishedAt: Date.now(),
        error: `${resp.status} ${resp.statusText}: ${detail.slice(0, 300)}`,
      },
      { key: jobKey },
    );
    throw new BgInvokeError('Background invoke failed', 502);
  }
}

// ---------------------------------------------------------------------------
// Create-Drafts background job
// ---------------------------------------------------------------------------

export type CreateDraftsPromotion = { enabled: boolean; rate: number | null };

export async function startCreateDraftsJob(
  userId: string,
  products: unknown[],
  promotion?: CreateDraftsPromotion,
): Promise<{ jobId: string }> {
  const jobId = crypto.randomUUID();
  const jobKey = k.job(userId, jobId);

  await putJob(
    jobId,
    {
      jobId,
      userId,
      status: 'pending',
      createdAt: Date.now(),
      totalProducts: products.length,
      processedProducts: 0,
    },
    { key: jobKey },
  );

  await invokeBackground(
    '/api/smartdrafts/create-drafts/background',
    { jobId, userId, products, promotion: promotion ?? { enabled: false, rate: null } },
    jobId,
    userId,
    jobKey,
  );

  return { jobId };
}

// ---------------------------------------------------------------------------
// Scan background job
// ---------------------------------------------------------------------------

export type ScanJobParams = {
  folder?: string;
  stagedUrls?: string[];
  force?: boolean;
  limit?: number;
  debug?: boolean;
};

const MAX_IMAGES = Math.max(1, Math.min(500, Number(process.env.SMARTDRAFT_MAX_IMAGES || 200)));

export async function startScanJob(
  userId: string,
  params: ScanJobParams,
): Promise<{ jobId: string }> {
  const allowed = await canStartJob(userId);
  if (!allowed) throw new QuotaExceededError();

  await incRunning(userId);

  const jobId = crypto.randomUUID();
  const jobKey = k.job(userId, jobId);

  const { folder, stagedUrls = [], force = false, debug = false } = params;
  const rawLimit = Number(params.limit);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_IMAGES) : MAX_IMAGES;

  try {
    await putJob(
      jobId,
      {
        jobId,
        userId,
        status: 'pending',
        createdAt: Date.now(),
        folder: folder || undefined,
        stagedUrls: stagedUrls.length > 0 ? stagedUrls : undefined,
        options: { force, limit, debug },
      },
      { key: jobKey },
    );
  } catch (err) {
    await decRunning(userId).catch(() => {});
    throw err;
  }

  try {
    await invokeBackground(
      '/api/smartdrafts/scan/background',
      {
        jobId,
        userId,
        folder: folder || undefined,
        stagedUrls: stagedUrls.length > 0 ? stagedUrls : undefined,
        force,
        limit,
        debug,
      },
      jobId,
      userId,
      jobKey,
    );
  } catch (err) {
    await decRunning(userId).catch(() => {});
    throw err;
  }

  return { jobId };
}
