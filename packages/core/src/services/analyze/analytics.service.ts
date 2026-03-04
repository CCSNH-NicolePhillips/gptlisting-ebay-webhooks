/**
 * packages/core/src/services/analyze/analytics.service.ts
 *
 * Aggregate pricing analytics for recent jobs (admin use).
 * Route: GET /api/analyze/analytics
 */

import { listJobs } from '../../../../../src/lib/job-store.js';
import { getAllPriceKeys, getPriceState } from '../../../../../src/lib/price-store.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PriceSummary {
  jobId: string;
  userId?: string;
  folder?: string;
  state: string;
  createdAt?: string;
  priceGroupCount: number;
  avgPrice: number | null;
  minPrice: number | null;
  maxPrice: number | null;
}

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * List recent jobs and aggregate pricing data per job.
 * Aggregates avg/min/max prices from the price-store for each job.
 */
export async function getAnalytics(limit = 50): Promise<{ summaries: PriceSummary[] }> {
  const jobs = await listJobs(limit);
  if (!Array.isArray(jobs) || jobs.length === 0) return { summaries: [] };

  const summaries = await Promise.all(
    jobs.map(async (job: any): Promise<PriceSummary> => {
      const jobId: string = job?.jobId || job?.id || '';
      const userId: string = job?.userId || '';
      const folder: string = job?.folder || '';
      const state: string = job?.state || 'unknown';
      const createdAt: string | undefined = job?.createdAt;

      let priceGroupCount = 0;
      let avgPrice: number | null = null;
      let minPrice: number | null = null;
      let maxPrice: number | null = null;

      if (jobId) {
        try {
          const prefix = userId ? `price:${userId}:${jobId}:` : `price::${jobId}:`;
          const keys = await getAllPriceKeys(prefix);
          priceGroupCount = Array.isArray(keys) ? keys.length : 0;

          const prices: number[] = [];
          if (priceGroupCount > 0) {
            const states = await Promise.all(keys.slice(0, 50).map((k) => getPriceState(k)));
            for (const s of states) {
              const p = (s as any)?.price ?? (s as any)?.bestPrice ?? (s as any)?.suggestedPrice;
              const n = Number(p);
              if (Number.isFinite(n) && n > 0) prices.push(n);
            }
          }

          if (prices.length > 0) {
            avgPrice = Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 100) / 100;
            minPrice = Math.min(...prices);
            maxPrice = Math.max(...prices);
          }
        } catch {
          // best-effort; don't fail the whole analytics call
        }
      }

      return { jobId, userId: userId || undefined, folder: folder || undefined, state, createdAt, priceGroupCount, avgPrice, minPrice, maxPrice };
    }),
  );

  return { summaries };
}
