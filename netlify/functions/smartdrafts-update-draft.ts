import type { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';

/**
 * POST /.netlify/functions/smartdrafts-update-draft
 * 
 * Updates a single draft in KV storage.
 * Body: { sku, draft: { title, description, price, condition, aspects, images, ... } }
 */
const handler: Handler = async (event: HandlerEvent, context: HandlerContext) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ ok: false, error: 'Method not allowed' }),
    };
  }

  try {
    const { sku, draft } = JSON.parse(event.body || '{}');
    
    if (!sku || !draft) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ ok: false, error: 'Missing sku or draft' }),
      };
    }

    // Validate draft fields
    if (!draft.title || draft.title.length > 80) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ ok: false, error: 'Title is required and must be ≤ 80 characters' }),
      };
    }

    if (!draft.price || draft.price <= 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ ok: false, error: 'Price must be > 0' }),
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
    
    for (const kvKey of allKeys) {
      // @ts-ignore
      const stored = await context.store?.get(kvKey);
      if (!stored) continue;
      
      const jobData = typeof stored === 'string' ? JSON.parse(stored) : stored;
      const drafts = jobData.drafts || [];
      
      const draftIndex = drafts.findIndex((d: any) => d.sku === sku);
      
      if (draftIndex !== -1) {
        // Update the draft, preserving fields not included in the update
        drafts[draftIndex] = {
          ...drafts[draftIndex],
          ...draft,
          sku, // Ensure SKU doesn't change
        };

        jobData.drafts = drafts;
        jobData.updatedAt = new Date().toISOString();

        // Save back to KV
        // @ts-ignore
        await context.store?.set(kvKey, JSON.stringify(jobData));

        console.log(`✓ Updated draft: sku=${sku}`);

        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ ok: true }),
        };
      }
    }

    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ ok: false, error: 'Draft not found for this SKU' }),
    };
  } catch (error: any) {
    console.error('[smartdrafts-update-draft] Error:', error);
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
