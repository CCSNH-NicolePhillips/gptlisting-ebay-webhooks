/**
 * packages/core/src/services/smartdrafts/quick-list.service.ts
 *
 * Create and retrieve quick-list pipeline jobs.
 *   startQuickList      — POST /api/smartdrafts/quick-list
 *   getQuickListStatus  — GET  /api/smartdrafts/quick-list?jobId=
 */

import { randomUUID } from 'crypto';

// ─── Error classes ────────────────────────────────────────────────────────────

export class QuickListNotFoundError extends Error {
  readonly statusCode = 404;
  constructor(jobId: string) { super(`Quick-list job not found: ${jobId}`); this.name = 'QuickListNotFoundError'; }
}

export class QuickListRedisError extends Error {
  readonly statusCode = 500;
  constructor(msg: string) { super(msg); this.name = 'QuickListRedisError'; }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface QuickListJob {
  jobId: string;
  userId: string;
  scanJobId?: string;
  state: string;
  createdAt: string;
  updatedAt?: string;
  result?: unknown;
  error?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function upstashHeaders() {
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!token) throw new QuickListRedisError('Redis not configured');
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

function baseUrl() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  if (!url) throw new QuickListRedisError('Redis not configured');
  return url;
}

async function redisSet(key: string, value: string, ttlSeconds = 3600) {
  const url = baseUrl();
  const headers = upstashHeaders();
  const res = await fetch(`${url}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}/ex/${ttlSeconds}`, {
    method: 'GET',
    headers,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new QuickListRedisError(`Redis set failed (${res.status}): ${txt.slice(0, 200)}`);
  }
}

async function redisGet(key: string): Promise<string | null> {
  const url = baseUrl();
  const headers = upstashHeaders();
  const res = await fetch(`${url}/get/${encodeURIComponent(key)}`, { headers });
  const j = (await res.json()) as any;
  return j?.result ?? null;
}

function quickListKey(jobId: string) {
  return `quick-list-job:${jobId}`;
}

// ─── Services ─────────────────────────────────────────────────────────────────

/**
 * Create a quick-list pipeline job.
 * Stores job metadata in Redis, then triggers the downstream processor.
 */
export async function startQuickList(
  userId: string,
  scanJobId?: string,
): Promise<{ ok: true; jobId: string }> {
  const jobId = randomUUID();
  const now = new Date().toISOString();

  const job: QuickListJob = {
    jobId,
    userId,
    scanJobId,
    state: 'pending',
    createdAt: now,
  };

  await redisSet(quickListKey(jobId), JSON.stringify(job), 3600);

  // Trigger processor (fire-and-forget)
  const BASE_URL = process.env.API_BASE_URL || process.env.URL;
  if (BASE_URL) {
    const processorUrl = `${BASE_URL.replace(/\/$/, '')}/api/smartdrafts/quick-list/process`;
    fetch(processorUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, userId, scanJobId }),
    }).catch(() => { /* fire-and-forget */ });
  }

  return { ok: true, jobId };
}

/**
 * Retrieve the status of a quick-list job.
 */
export async function getQuickListStatus(
  userId: string,
  jobId: string,
): Promise<QuickListJob> {
  const raw = await redisGet(quickListKey(jobId));
  if (!raw) throw new QuickListNotFoundError(jobId);
  let job: QuickListJob;
  try { job = JSON.parse(raw); } catch { throw new QuickListNotFoundError(jobId); }
  // Basic authorization: only allow the job owner to read it
  if (job.userId && job.userId !== userId) throw new QuickListNotFoundError(jobId);
  return job;
}
