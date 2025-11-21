import type { Handler, HandlerEvent } from '@netlify/functions';
import { runSmartdraftsAnalysis } from '../../src/smartdrafts/analysisCore.js';
import { requireUserAuth } from '../../src/lib/auth-user.js';
import OpenAI from 'openai';
import { runPairingV2 } from '../../src/pairing/pairing-v2.js';
import { buildFeatures } from '../../src/pairing/featurePrep.js';

/**
 * Pairing V2 Labs Runner
 * POST /.netlify/functions/pairing-v2-labs-run
 * 
 * Phase 1.B: Sandbox for testing pairing-v2.ts
 * Loads analysis, builds features, calls runPairingV2
 * Does not modify existing pairing behavior.
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
      console.error('[PAIRING_V2_LABS] auth failed:', authErr);
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
    const { folder, model, maxImages } = body;

    console.log('[PAIRING_V2_LABS] start', { 
      folder, 
      model, 
      maxImages,
      userId: user.userId 
    });

    // Validate folder
    const targetFolder = folder || '/newStuff';
    if (typeof targetFolder !== 'string') {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          ok: false,
          error: 'Invalid folder parameter',
        }),
      };
    }

    // Run analysis using shared core
    const analysis = await runSmartdraftsAnalysis(
      targetFolder,
      {}, // no overrides
      user.userId, // Use authenticated user ID
      undefined, // no stagedUrls
      true // skipQuota = true for labs
    );

    console.log('[PAIRING_V2_LABS] analysis done', {
      folder: targetFolder,
      jobId: analysis.jobId,
      groups: analysis.groups?.length || 0,
      imageInsights: Object.keys(analysis.imageInsights || {}).length,
    });

    // Build features from analysis
    const normalizedAnalysis = {
      groups: analysis.groups || [],
      imageInsights: Array.isArray(analysis.imageInsights)
        ? analysis.imageInsights
        : Object.values(analysis.imageInsights || {}),
    };

    const features = buildFeatures(normalizedAnalysis);

    console.log('[PAIRING_V2_LABS] features built', {
      count: features.size,
    });

    // Create OpenAI client
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

    // Collect logs
    const logLines: string[] = [];
    const log = (line: string) => {
      logLines.push(line);
      console.log(line);
    };

    // Run pairing v2
    const { result, metrics, rawText } = await runPairingV2({
      features,
      client,
      model: model || 'gpt-4o-mini',
      log,
      config: { maxImages: maxImages || 100 },
    });

    console.log('[PAIRING_V2_LABS] pairing done', {
      pairs: result.pairs.length,
      singletons: result.singletons.length,
      durationMs: metrics.durationMs,
    });

    // Return results
    return {
      statusCode: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ok: true,
        source: 'pairing-v2-labs-run',
        folder: targetFolder,
        jobId: analysis.jobId,
        result,
        metrics,
        logLines,
        rawText: rawText.substring(0, 1000), // Truncate for response size
      }, null, 2),
    };

  } catch (err: any) {
    console.error('[PAIRING_V2_LABS] error', err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        ok: false,
        error: err.message || String(err),
        stack: err.stack,
      }),
    };
  }
};
