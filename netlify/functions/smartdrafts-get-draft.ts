import type { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';

/**
 * GET /.netlify/functions/smartdrafts-get-draft?jobId=xxx&groupId=yyy
 * 
 * Fetches a single draft from KV storage for editing.
 */
const handler: Handler = async (event: HandlerEvent, context: HandlerContext) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ ok: false, error: 'Method not allowed' }),
    };
  }

  try {
    const { jobId, groupId } = event.queryStringParameters || {};
    
    if (!jobId || !groupId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ ok: false, error: 'Missing jobId or groupId' }),
      };
    }

    // Get userId from context (Netlify Identity)
    const userId = context.clientContext?.user?.sub;
    if (!userId) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ ok: false, error: 'Not authenticated' }),
      };
    }

    const kvKey = `draft:${userId}:${jobId}`;
    
    // @ts-ignore - Netlify KV not in types yet
    const stored = await context.store?.get(kvKey);
    if (!stored) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ ok: false, error: 'Job not found' }),
      };
    }

    const jobData = typeof stored === 'string' ? JSON.parse(stored) : stored;
    const drafts = jobData.drafts || [];
    
    const draft = drafts.find((d: any) => d.groupId === groupId);
    
    if (!draft) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ ok: false, error: 'Draft not found' }),
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, draft }),
    };
  } catch (error: any) {
    console.error('[smartdrafts-get-draft] Error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        ok: false,
        error: error.message || 'Internal server error',
      }),
    };
  }
};

export { handler };
