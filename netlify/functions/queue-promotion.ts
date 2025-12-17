/**
 * Queue Promotion - API endpoint to queue promotion jobs
 * 
 * Called after draft publishing or manual promotion request.
 * Queues jobs for background processing with retry logic.
 */

import type { Handler, HandlerEvent } from '@netlify/functions';
import { requireAuthVerified } from '../../src/lib/_auth.js';
import { queuePromotionJob, queuePromotionBatch, getJobStatus } from '../../src/lib/promotion-queue.js';

export const handler: Handler = async (event: HandlerEvent) => {
  // Only allow POST
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  try {
    // Verify authentication
    const auth = await requireAuthVerified(event);
    if (!auth) {
      return {
        statusCode: 401,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Unauthorized' }),
      };
    }
    const userId = auth.sub;

    const body = JSON.parse(event.body || '{}');

    // Support both single job and batch
    if (body.batch && Array.isArray(body.batch)) {
      // Batch mode - queue multiple jobs
      const { batch } = body;

      if (batch.length === 0) {
        return {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Empty batch' }),
        };
      }

      if (batch.length > 50) {
        return {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Batch size limited to 50 jobs' }),
        };
      }

      // Validate batch items
      for (const item of batch) {
        if (!item.listingId || typeof item.adRate !== 'number') {
          return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              error: 'Each batch item must have listingId and adRate',
              invalidItem: item 
            }),
          };
        }
      }

      // Queue batch
      const jobs = batch.map((item: any) => ({
        userId,
        listingId: item.listingId,
        adRate: item.adRate,
        campaignId: item.campaignId,
      }));

      const jobIds = await queuePromotionBatch(jobs);

      console.log(`[queue-promotion] Queued batch of ${jobIds.length} jobs for user ${userId}`);

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: true,
          jobIds,
          count: jobIds.length,
          message: `Queued ${jobIds.length} promotion jobs. They will be processed over the next few minutes.`,
        }),
      };

    } else {
      // Single job mode
      const { listingId, adRate, campaignId } = body;

      if (!listingId || typeof adRate !== 'number') {
        return {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'listingId and adRate required' }),
        };
      }

      if (adRate < 1 || adRate > 100) {
        return {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'adRate must be between 1 and 100' }),
        };
      }

      // Queue single job
      const jobId = await queuePromotionJob(userId, listingId, adRate, { campaignId });

      console.log(`[queue-promotion] Queued job ${jobId} for user ${userId}, listing ${listingId}`);

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: true,
          jobId,
          message: 'Promotion queued. It will be processed within 1-2 minutes.',
        }),
      };
    }

  } catch (error: any) {
    console.error('[queue-promotion] Error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        error: 'Failed to queue promotion',
        message: error.message 
      }),
    };
  }
};
