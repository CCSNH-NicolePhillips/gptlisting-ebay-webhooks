/**
 * Promotion Job Status - Check status of queued promotion jobs
 */

import type { Handler, HandlerEvent } from '@netlify/functions';
import { requireAuthVerified } from '../../src/lib/_auth.js';
import { getJobStatus, getQueueStats } from '../../src/lib/promotion-queue.js';

export const handler: Handler = async (event: HandlerEvent) => {
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  try {
    // Verify authentication
    await requireAuthVerified(event);

    const params = event.queryStringParameters || {};

    // If jobId provided, return specific job status
    if (params.jobId) {
      const job = await getJobStatus(params.jobId);
      
      if (!job) {
        return {
          statusCode: 404,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            error: 'Job not found',
            message: 'Job may have completed or expired' 
          }),
        };
      }

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job }),
      };
    }

    // Otherwise return queue stats
    const stats = await getQueueStats();

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stats }),
    };

  } catch (error: any) {
    console.error('[promotion-status] Error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        error: 'Failed to get status',
        message: error.message 
      }),
    };
  }
};
