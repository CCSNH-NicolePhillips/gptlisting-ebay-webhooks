/**
 * packages/core/src/services/smartdrafts/scan-direct.service.ts
 *
 * Synchronous SmartDrafts scan (runs in-process, no background job).
 * Route: POST /api/smartdrafts/scan
 */

import { runSmartdraftsAnalysis } from '../../../../../src/smartdrafts/analysisCore.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DirectScanOptions {
  force?: boolean;
  limit?: number;
  debug?: boolean;
}

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * Run a synchronous SmartDrafts scan on the given folder for userId.
 * Returns the analysis result directly (no job queue).
 */
export async function runDirectScan(userId: string, folder: string, opts: DirectScanOptions = {}) {
  const overrides: Record<string, unknown> = {};
  if (opts.force) overrides.forceRescan = true;
  if (typeof opts.limit === 'number') overrides.limit = opts.limit;
  if (opts.debug)  overrides.debugMode = true;

  const result = await runSmartdraftsAnalysis(folder, overrides, userId, undefined, false);

  return {
    ok: true,
    cached: result.cached ?? false,
    folder,
    signature: result.signature ?? null,
    count: Array.isArray((result as any).groups)
      ? (result as any).groups.reduce((acc: number, g: any) => acc + (Array.isArray(g.images) ? g.images.length : 0), 0)
      : 0,
    warnings: (result as any).warnings ?? [],
    groups: (result as any).groups ?? [],
    imageInsights: (result as any).imageInsights ?? null,
  };
}
