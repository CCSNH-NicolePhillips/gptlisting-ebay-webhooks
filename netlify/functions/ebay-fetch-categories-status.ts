import type { Handler } from '@netlify/functions';
import { tokensStore } from '../../src/lib/_blobs.js';
import { getOrigin, jsonResponse } from '../../src/lib/http.js';

const METHODS = 'GET, OPTIONS';

/**
 * Check the status of a background category fetch job.
 * 
 * GET /.netlify/functions/ebay-fetch-categories-status?jobId=job-12345
 * 
 * Returns:
 * {
 *   ok: true,
 *   status: {
 *     jobId: "job-12345",
 *     totalCategories: 100,
 *     processed: 45,
 *     success: 40,
 *     failed: 5,
 *     status: "processing" | "completed" | "queued" | "failed",
 *     createdAt: 1234567890,
 *     updatedAt: 1234567890,
 *     parentCategory: "Health & Beauty (26395)"
 *   }
 * }
 */
export const handler: Handler = async (event) => {
  const headers = event.headers as Record<string, string | undefined>;
  const originHdr = getOrigin(headers);

  if (event.httpMethod === 'OPTIONS') {
    return jsonResponse(200, {}, originHdr, METHODS);
  }

  if (event.httpMethod !== 'GET') {
    return jsonResponse(405, { error: 'Method not allowed' }, originHdr, METHODS);
  }

  try {
    const jobId = event.queryStringParameters?.jobId;

    if (!jobId) {
      return jsonResponse(400, {
        error: 'Missing jobId parameter',
      }, originHdr, METHODS);
    }

    // Get job status from blob storage
    const store = tokensStore();
    const status = await store.get(`category-fetch-status-${jobId}.json`, { type: 'json' }) as any;

    if (!status) {
      return jsonResponse(404, {
        error: 'Job not found',
        jobId,
      }, originHdr, METHODS);
    }

    return jsonResponse(200, {
      ok: true,
      status,
    }, originHdr, METHODS);
  } catch (e: any) {
    console.error('Error fetching job status:', e);
    return jsonResponse(500, {
      error: 'Failed to fetch job status',
      detail: e?.message || String(e),
    }, originHdr, METHODS);
  }
};
