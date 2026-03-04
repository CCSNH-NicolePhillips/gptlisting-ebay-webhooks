/**
 * packages/core/src/services/smartdrafts/pairing-from-scan.service.ts
 *
 * Start a pairing-v2 job seeded from a completed scan job.
 * Route: POST /api/smartdrafts/pairing/v2/start-from-scan
 */

import { schedulePairingV2Job } from '../../../../../src/lib/pairingV2Jobs.js';

// ─── Error classes ────────────────────────────────────────────────────────────

export class ScanJobNotFoundError extends Error {
  readonly statusCode = 404;
  constructor(jobId: string) { super(`Scan job not found: ${jobId}`); this.name = 'ScanJobNotFoundError'; }
}

export class ScanJobNotCompleteError extends Error {
  readonly statusCode = 400;
  constructor(state: string) { super(`Scan job is not completed (state: ${state})`); this.name = 'ScanJobNotCompleteError'; }
}

export class PairingFromScanError extends Error {
  readonly statusCode = 500;
  constructor(msg: string) { super(msg); this.name = 'PairingFromScanError'; }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchScanJob(userId: string, jobId: string): Promise<any> {
  const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!UPSTASH_URL || !UPSTASH_TOKEN) throw new PairingFromScanError('Redis not configured');

  const key = `job:${userId}:${jobId}`;
  const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  const j = (await res.json()) as any;
  const raw = j?.result;
  if (!raw || raw === null) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
}

function normalizeJobStatus(job: any): string {
  const state = (job?.state || job?.status || '').toString().toLowerCase();
  if (state === 'done' || state === 'finished') return 'completed';
  if (state === 'error' || state === 'failed') return 'failed';
  return state;
}

function extractImagePaths(scanJob: any): { imagePaths: string[]; folder: string; uploadMethod: string } {
  const folder: string = scanJob.folder || scanJob.scanFolder || '';

  // Method 1: stagedUrls (array of URLs)
  if (Array.isArray(scanJob.stagedUrls) && scanJob.stagedUrls.length > 0) {
    return { imagePaths: scanJob.stagedUrls.map(String), folder, uploadMethod: 'staged' };
  }

  // Method 2: extract from groups
  const groups: any[] = Array.isArray(scanJob.groups) ? scanJob.groups : [];
  const urls: string[] = [];
  for (const group of groups) {
    if (Array.isArray(group.images)) {
      for (const img of group.images) {
        const u = img?.url || img?.stagedUrl || img?.path || img?.key || '';
        if (u) urls.push(String(u));
      }
    }
    if (typeof group.frontUrl === 'string') urls.push(group.frontUrl);
    if (typeof group.backUrl === 'string') urls.push(group.backUrl);
  }

  if (urls.length > 0) return { imagePaths: [...new Set(urls)], folder, uploadMethod: 'groups' };

  // Method 3: result.imagePaths fallback
  if (Array.isArray(scanJob.result?.imagePaths) && scanJob.result.imagePaths.length > 0) {
    return { imagePaths: scanJob.result.imagePaths.map(String), folder, uploadMethod: 'result' };
  }

  return { imagePaths: [], folder, uploadMethod: 'none' };
}

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * Start a pairing-v2 job from a previously completed scan job.
 * Returns jobId (202 Accepted equivalent).
 */
export async function startPairingFromScan(
  userId: string,
  scanJobId: string,
): Promise<{ ok: true; jobId: string; imageCount: number; uploadMethod: string }> {
  const scanJob = await fetchScanJob(userId, scanJobId);
  if (!scanJob) throw new ScanJobNotFoundError(scanJobId);

  const status = normalizeJobStatus(scanJob);
  if (status !== 'completed') throw new ScanJobNotCompleteError(status);

  const { imagePaths, folder, uploadMethod } = extractImagePaths(scanJob);
  if (imagePaths.length === 0) {
    throw new PairingFromScanError('No image paths found in completed scan job');
  }

  const jobId = await schedulePairingV2Job(userId, folder, imagePaths, undefined);

  return { ok: true, jobId, imageCount: imagePaths.length, uploadMethod };
}
