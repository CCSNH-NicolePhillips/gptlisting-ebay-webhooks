import type { Handler, HandlerEvent } from '@netlify/functions';
import fetch from 'node-fetch';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { requireUserAuth } from '../../src/lib/auth-user.js';
import { tokensStore } from '../../src/lib/_blobs.js';
import { userScopedKey } from '../../src/lib/_auth.js';
import { runNewTwoStagePipeline, type PairingResult } from '../../src/smartdrafts/pairing-v2-core.js';

/**
 * SmartDrafts Pairing V2 - New Two-Stage Pipeline
 * POST /.netlify/functions/smartdrafts-pairing-v2
 * 
 * Phase 2: Backend wiring for the new deterministic + LLM pairing system.
 * 
 * This function:
 * 1. Lists images in a Dropbox folder
 * 2. Downloads them to /tmp
 * 3. Runs the new three-stage pairing pipeline:
 *    - Stage 1: Classification (product/non-product, front/back/side)
 *    - Stage 2: Text-only pairing from metadata
 *    - Stage 3: Verification pass
 * 4. Returns pairs, singletons, and metrics
 */

const ALLOWED_ORIGINS = [
  'http://localhost:8888',
  'http://localhost:3000',
  'https://ebaywebhooks.netlify.app',
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

interface LocalImage {
  dropboxPath: string;
  basename: string;
  localPath: string;
}

/**
 * Exchange Dropbox refresh token for access token
 */
async function dropboxAccessToken(refreshToken: string): Promise<string> {
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: process.env.DROPBOX_CLIENT_ID || '',
    client_secret: process.env.DROPBOX_CLIENT_SECRET || '',
  });
  
  const r = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    throw new Error(`Dropbox token exchange failed: ${r.status} ${JSON.stringify(j)}`);
  }
  
  return j.access_token as string;
}

/**
 * List image files in a Dropbox folder
 */
async function listDropboxImages(accessToken: string, folder: string): Promise<Array<{ name: string; path_lower: string }>> {
  console.log(`[smartdrafts-pairing-v2] Listing Dropbox folder: ${folder}`);
  
  const r = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
    method: 'POST',
    headers: { 
      Authorization: `Bearer ${accessToken}`, 
      'Content-Type': 'application/json' 
    },
    body: JSON.stringify({ path: folder, recursive: false }),
  });
  
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`Dropbox list_folder failed: ${r.status} ${JSON.stringify(j)}`);
  }
  
  const entries: any[] = j.entries || [];
  const images = entries.filter((e: any) => 
    e[".tag"] === "file" && 
    /\.(jpg|jpeg|png)$/i.test(e.name)
  );
  
  console.log(`[smartdrafts-pairing-v2] Found ${images.length} images in ${folder}`);
  
  return images.map((e: any) => ({
    name: e.name,
    path_lower: e.path_lower,
  }));
}

/**
 * Download a single image from Dropbox to local temp directory
 */
async function downloadImage(accessToken: string, dropboxPath: string, localPath: string): Promise<void> {
  try {
    const r = await fetch('https://content.dropboxapi.com/2/files/download', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Dropbox-API-Arg': JSON.stringify({ path: dropboxPath }),
      },
    });
    
    if (!r.ok) {
      const errorText = await r.text();
      throw new Error(`Download failed: ${r.status} ${errorText}`);
    }
    
    const buffer = await r.buffer();
    fs.writeFileSync(localPath, buffer);
  } catch (err: any) {
    console.error(`[smartdrafts-pairing-v2] Failed to download ${dropboxPath}:`, err.message);
    throw err;
  }
}

/**
 * Download all Dropbox images to a temp directory
 */
async function downloadImagesToTemp(
  accessToken: string,
  images: Array<{ name: string; path_lower: string }>,
  workDir: string
): Promise<LocalImage[]> {
  const localImages: LocalImage[] = [];
  
  console.log(`[smartdrafts-pairing-v2] Downloading ${images.length} images to ${workDir}`);
  
  for (const img of images) {
    const localPath = path.join(workDir, img.name);
    
    try {
      await downloadImage(accessToken, img.path_lower, localPath);
      
      localImages.push({
        dropboxPath: img.path_lower,
        basename: img.name,
        localPath,
      });
    } catch (err: any) {
      console.error(`[smartdrafts-pairing-v2] Failed to download ${img.name}, skipping:`, err.message);
      // Continue with other images
    }
  }
  
  console.log(`[smartdrafts-pairing-v2] Downloaded ${localImages.length}/${images.length} images successfully`);
  
  return localImages;
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
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: 'Method not allowed' }),
    };
  }

  let workDir: string | null = null;

  try {
    // Require authentication (user needs Dropbox access)
    let user;
    try {
      user = await requireUserAuth(event.headers.authorization || event.headers.Authorization);
    } catch (authErr) {
      console.error('[smartdrafts-pairing-v2] auth failed:', authErr);
      return {
        statusCode: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ok: false,
          error: 'Unauthorized - please log in',
        }),
      };
    }

    // Parse request body
    const body = JSON.parse(event.body || '{}');
    const { folder } = body;

    // Validate folder parameter
    if (!folder || typeof folder !== 'string') {
      return {
        statusCode: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ok: false,
          error: 'folder parameter is required',
        }),
      };
    }

    console.log('[smartdrafts-pairing-v2] start', { folder, userId: user.userId });

    // Get Dropbox refresh token from user's token store
    const store = tokensStore();
    const saved = (await store.get(userScopedKey(user.userId, 'dropbox.json'), { type: 'json' })) as any;
    const refreshToken = typeof saved?.refresh_token === 'string' ? saved.refresh_token.trim() : '';
    
    if (!refreshToken) {
      return {
        statusCode: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ok: false,
          error: 'Please connect Dropbox first',
        }),
      };
    }

    // Exchange refresh token for access token
    const accessToken = await dropboxAccessToken(refreshToken);

    // List images in the folder
    const images = await listDropboxImages(accessToken, folder);

    // Handle empty folder
    if (images.length === 0) {
      console.log('[smartdrafts-pairing-v2] No images found in folder');
      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ok: true,
          folder,
          pairs: [],
          singletons: [],
          metrics: {
            totals: {
              images: 0,
              fronts: 0,
              backs: 0,
              candidates: 0,
              autoPairs: 0,
              modelPairs: 0,
              globalPairs: 0,
              singletons: 0,
            },
            byBrand: {},
            reasons: {},
            durationMs: 0,
            engineVersion: 'v2',
          },
        }),
      };
    }

    // Create temp working directory
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairing-v2-'));
    console.log('[smartdrafts-pairing-v2] Created temp directory:', workDir);

    // Download all images to temp directory
    const localImages = await downloadImagesToTemp(accessToken, images, workDir);

    if (localImages.length === 0) {
      return {
        statusCode: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ok: false,
          error: 'Failed to download any images from Dropbox',
        }),
      };
    }

    // Run the new two-stage pairing pipeline
    const startedAt = Date.now();

    const localPaths = localImages.map(img => img.localPath);
    console.log('[smartdrafts-pairing-v2] Running pairing pipeline on', localPaths.length, 'images');

    const pairingResult: PairingResult = await runNewTwoStagePipeline(localPaths);

    const durationMs = Date.now() - startedAt;

    console.log('[smartdrafts-pairing-v2] pairing complete', {
      images: localImages.length,
      pairs: pairingResult.pairs.length,
      unpaired: pairingResult.unpaired.length,
      durationMs,
    });

    // Map results back to original basenames
    const byLocalPath = new Map<string, LocalImage>();
    for (const img of localImages) {
      byLocalPath.set(img.localPath, img);
    }

    const responsePairs = pairingResult.pairs.map(p => {
      const front = byLocalPath.get(p.front);
      const back = byLocalPath.get(p.back);
      return {
        front: front ? front.basename : path.basename(p.front),
        back: back ? back.basename : path.basename(p.back),
        confidence: p.confidence,
        brand: p.brand ?? null,
        product: p.product ?? null,
      };
    });

    const responseSingletons = pairingResult.unpaired.map(u => {
      const img = byLocalPath.get(u.imagePath);
      return {
        image: img ? img.basename : path.basename(u.imagePath),
        reason: u.reason,
        needsReview: u.needsReview,
      };
    });

    // Build final metrics
    const totals = pairingResult.metrics?.totals ?? {
      images: localImages.length,
      fronts: 0,
      backs: 0,
      candidates: 0,
      autoPairs: 0,
      modelPairs: responsePairs.length,
      globalPairs: 0,
      singletons: responseSingletons.length,
    };

    const responseBody = {
      ok: true,
      folder,
      pairs: responsePairs,
      singletons: responseSingletons,
      metrics: {
        ...pairingResult.metrics,
        totals: {
          ...totals,
          images: localImages.length,
        },
        durationMs,
        engineVersion: 'v2',
      },
    };

    // Clean up temp directory
    if (workDir) {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
        console.log('[smartdrafts-pairing-v2] Cleaned up temp directory:', workDir);
      } catch (cleanupErr) {
        console.warn('[smartdrafts-pairing-v2] Failed to clean up temp directory:', cleanupErr);
      }
    }

    return {
      statusCode: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(responseBody, null, 2),
    };

  } catch (err: any) {
    console.error('[smartdrafts-pairing-v2] ERROR', err);

    // Clean up temp directory on error
    if (workDir) {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }

    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: false,
        error: 'internal_error',
        detail: err.message || String(err),
        stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
      }),
    };
  }
};
