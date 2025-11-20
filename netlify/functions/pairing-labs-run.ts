import type { Handler, HandlerEvent } from '@netlify/functions';

/**
 * Pairing Labs Runner
 * POST /.netlify/functions/pairing-labs-run
 * 
 * Experimental pairing endpoint for testing new algorithms.
 * Does not modify existing smartdrafts-pairing behavior.
 */

const ALLOWED_ORIGINS = [
  'http://localhost:8888',
  'http://localhost:3000',
  'https://draftpilot-ai.netlify.app'
];

function getCorsHeaders(origin: string | undefined) {
  const allowedOrigin = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[2];
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

export const handler: Handler = async (event: HandlerEvent) => {
  const origin = event.headers.origin;
  const corsHeaders = getCorsHeaders(origin);

  // Handle OPTIONS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: '',
    };
  }

  // Only accept POST
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  try {
    // Parse request body
    const body = JSON.parse(event.body || '{}');
    const { folder } = body;

    console.log('[PAIRING_LABS] payload', body);

    // Validate folder
    if (!folder || typeof folder !== 'string') {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          ok: false,
          error: 'Missing or invalid folder parameter',
        }),
      };
    }

    // Echo response
    return {
      statusCode: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ok: true,
        source: 'pairing-labs-run',
        receivedFolder: folder,
        timestamp: new Date().toISOString(),
      }),
    };
  } catch (err) {
    console.error('[PAIRING_LABS] error:', err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        ok: false,
        error: 'Internal server error',
        message: (err as Error)?.message || String(err),
      }),
    };
  }
};
