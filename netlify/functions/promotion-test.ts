import type { Handler } from '@netlify/functions';
import { requireAuthVerified } from '../../src/lib/_auth.js';
import { queuePromotionJob, getQueueStats } from '../../src/lib/promotion-queue.js';

/**
 * Test endpoint for promotion queue
 * GET /.netlify/functions/promotion-test - Get queue stats
 * POST /.netlify/functions/promotion-test - Queue a test job
 */
export const handler: Handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  try {
    const auth = await requireAuthVerified(event);
    if (!auth) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
    }
    const userId = auth.sub;

    if (event.httpMethod === 'GET') {
      // Return queue stats
      const stats = await getQueueStats();
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          message: 'Promotion queue stats',
          userId,
          stats,
          redisConfigured: !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN),
        }),
      };
    }

    if (event.httpMethod === 'POST') {
      // Queue a test job
      const body = event.body ? JSON.parse(event.body) : {};
      const testListingId = body.listingId || 'test-listing-' + Date.now();
      const adRate = body.adRate || 5;

      console.log(`[promotion-test] Queueing test job for user ${userId}, listing ${testListingId}`);
      
      const jobId = await queuePromotionJob(userId, testListingId, adRate, {
        sku: 'test-sku',
      });

      console.log(`[promotion-test] Queued job ${jobId}`);

      const stats = await getQueueStats();

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          message: 'Test job queued successfully',
          userId,
          jobId,
          listingId: testListingId,
          adRate,
          stats,
        }),
      };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (error: any) {
    console.error('[promotion-test] Error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message || String(error) }),
    };
  }
};
