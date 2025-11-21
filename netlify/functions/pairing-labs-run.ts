import type { Handler, HandlerEvent } from '@netlify/functions';
import { runSmartdraftsAnalysis } from '../../src/smartdrafts/analysisCore.js';
import { requireUserAuth } from '../../src/lib/auth-user.js';

/**
 * Pairing Labs Runner
 * POST /.netlify/functions/pairing-labs-run
 * 
 * Phase 2: Runs SmartDrafts analysis pipeline
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
    // Require authentication (user needs Dropbox access)
    let user;
    try {
      user = await requireUserAuth(event.headers.authorization || event.headers.Authorization);
    } catch (authErr) {
      console.error('[PAIRING_LABS] auth failed:', authErr);
      return {
        statusCode: 401,
        headers: corsHeaders,
        body: JSON.stringify({
          ok: false,
          error: 'Unauthorized - please log in',
        }),
      };
    }

    // Parse request body
    const body = JSON.parse(event.body || '{}');
    const { folder, overrides } = body;

    console.log('[PAIRING_LABS] start', { folder, overrides, userId: user.userId });

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

    // Run analysis using shared core
    const analysis = await runSmartdraftsAnalysis(
      folder,
      overrides || {},
      user.userId, // Use authenticated user ID
      undefined, // no stagedUrls
      true // skipQuota = true for labs
    );

    console.log('[PAIRING_LABS] analysis done', {
      folder,
      jobId: analysis.jobId,
      groups: analysis.groups?.length || 0,
    });

    // Return clean JSON summary for UI
    return {
      statusCode: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ok: true,
        source: 'pairing-labs-run',
        folder,
        analysisSummary: {
          jobId: analysis.jobId,
          cached: analysis.cached,
          imageCount: analysis.imageCount ?? analysis.groups?.length ?? 0,
          groupCount: analysis.groups?.length ?? 0,
        },
        // Expose raw groups for pairing debug later
        groups: analysis.groups,
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
