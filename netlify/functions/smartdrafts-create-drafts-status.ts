import type { Handler } from '@netlify/functions';
import { tokensStore } from '../../src/lib/_blobs.js';

export const handler: Handler = async (event) => {
  try {
    const jobId = event.queryStringParameters?.jobId;
    
    if (!jobId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'jobId required' }),
      };
    }

    const store = tokensStore();
    
    // Get status
    const statusKey = `drafts-status-${jobId}.json`;
    const status = await store.get(statusKey, { type: 'json' }).catch(() => null);
    
    if (!status) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Job not found' }),
      };
    }

    // Get results if job is completed
    let drafts = [];
    if (status.status === 'completed') {
      const resultsKey = `drafts-results-${jobId}.json`;
      const results = await store.get(resultsKey, { type: 'json' }).catch(() => ({ drafts: [] }));
      drafts = results.drafts || [];
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ok: true,
        status,
        drafts,
      }),
    };
  } catch (e: any) {
    console.error('Status check error:', e);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: e?.message || 'Internal error' }),
    };
  }
};
