import type { Handler } from '@netlify/functions';
import { tokensStore } from '../../src/lib/redis-store.js';
import { getOrigin, jsonResponse } from '../../src/lib/http.js';

const METHODS = 'POST, OPTIONS';

/**
 * Cancel all running category fetch jobs.
 * 
 * POST /.netlify/functions/ebay-cancel-category-jobs
 * 
 * This will:
 * 1. Clear the active jobs index
 * 2. Mark all running jobs as 'failed' with reason 'cancelled'
 */
export const handler: Handler = async (event) => {
  const headers = event.headers as Record<string, string | undefined>;
  const originHdr = getOrigin(headers);

  if (event.httpMethod === 'OPTIONS') {
    return jsonResponse(200, {}, originHdr, METHODS);
  }

  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' }, originHdr, METHODS);
  }

  try {
    const store = tokensStore();

    // Get current active jobs
    const index = (await store.get('category-fetch-index.json', { type: 'json' }).catch(() => null)) as any;
    const activeJobs = (index?.activeJobs || []) as string[];

    if (activeJobs.length === 0) {
      return jsonResponse(200, {
        ok: true,
        message: 'No active jobs to cancel',
        cancelled: 0,
      }, originHdr, METHODS);
    }

    // Mark each job as failed/cancelled
    for (const jobId of activeJobs) {
      const statusKey = `category-fetch-status-${jobId}.json`;
      const status = (await store.get(statusKey, { type: 'json' }).catch(() => null)) as any;

      if (status) {
        status.status = 'failed';
        status.completedAt = Date.now();
        status.updatedAt = Date.now();
        if (!status.errors) status.errors = [];
        status.errors.push({ error: 'Job cancelled by user' });
        await store.setJSON(statusKey, status);
      }

      // Delete the queue to prevent worker from processing more
      const queueKey = `category-fetch-queue-${jobId}.json`;
      try {
        // Note: Netlify Blobs doesn't have delete yet, so we'll just empty the queue
        const queue = (await store.get(queueKey, { type: 'json' }).catch(() => null)) as any;
        if (queue) {
          queue.categories = [];
          await store.setJSON(queueKey, queue);
        }
      } catch (e) {
        console.warn(`Failed to clear queue ${queueKey}:`, e);
      }
    }

    // Clear the active jobs index
    await store.setJSON('category-fetch-index.json', { activeJobs: [] });

    return jsonResponse(200, {
      ok: true,
      message: 'All jobs cancelled',
      cancelled: activeJobs.length,
      jobIds: activeJobs,
    }, originHdr, METHODS);
  } catch (e: any) {
    console.error('Error cancelling jobs:', e);
    return jsonResponse(500, {
      error: 'Failed to cancel jobs',
      detail: e?.message || String(e),
    }, originHdr, METHODS);
  }
};
