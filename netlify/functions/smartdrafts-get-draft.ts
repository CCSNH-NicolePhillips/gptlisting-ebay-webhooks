import type { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';

/**
 * GET /.netlify/functions/smartdrafts-get-draft?sku=xxx
 * 
 * Fetches a single draft from KV storage for editing by SKU.
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
    const { sku } = event.queryStringParameters || {};
    
    if (!sku) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ ok: false, error: 'Missing sku parameter' }),
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

    // Search through all draft jobs for this user to find the one with matching SKU
    // @ts-ignore - Netlify KV not in types yet
    const allKeys = await context.store?.list({ prefix: `draft:${userId}:` }) || [];
    
    for (const key of allKeys) {
      // @ts-ignore
      const stored = await context.store?.get(key);
      if (!stored) continue;
      
      const jobData = typeof stored === 'string' ? JSON.parse(stored) : stored;
      const drafts = jobData.drafts || [];
      
      const draft = drafts.find((d: any) => d.sku === sku);
      
      if (draft) {
        // Extract jobId from key (format: draft:userId:jobId)
        const jobId = key.split(':')[2];
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ 
            ok: true, 
            draft,
            jobId,
            groupId: draft.groupId 
          }),
        };
      }
    }

    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ ok: false, error: 'Draft not found for this SKU' }),
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
