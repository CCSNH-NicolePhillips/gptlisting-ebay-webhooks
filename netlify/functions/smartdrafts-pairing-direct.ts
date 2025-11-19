// DP2: Direct Pairing Netlify Function
// Accepts images and returns GPT-4o paired products
// Completely isolated from existing pairing logic

import type { Handler } from '@netlify/functions';
import { requireUserAuth } from '../../src/lib/auth-user.js';
import { directPairProductsFromImages, type DirectPairImageInput } from '../../src/lib/directPairing.js';

function json(status: number, body: any, headers: Record<string, string> = {}) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

export const handler: Handler = async (event) => {
  const originHdr = {};

  try {
    // Handle OPTIONS for CORS
    if (event.httpMethod === 'OPTIONS') {
      return json(200, {}, originHdr);
    }

    if (event.httpMethod !== 'POST') {
      return json(405, { ok: false, error: 'Method Not Allowed' }, originHdr);
    }

    const headers = event.headers || {};

    // Require authentication (same as other SmartDrafts endpoints)
    try {
      await requireUserAuth(
        headers.authorization || headers.Authorization || headers['x-forwarded-authorization'] || ''
      );
    } catch (err) {
      console.error('[smartdrafts-pairing-direct] Auth failed', err);
      return json(401, { ok: false, error: 'Unauthorized' }, originHdr);
    }

    if (!event.body) {
      return json(400, { ok: false, error: 'Missing body' }, originHdr);
    }

    const parsed = JSON.parse(event.body);

    const images = parsed.images;
    if (!Array.isArray(images) || images.length === 0) {
      return json(400, { ok: false, error: 'images[] is required' }, originHdr);
    }

    // Normalize input into the DP1 type
    const inputs: DirectPairImageInput[] = images.map((img: any) => ({
      url: String(img.url || ''),
      filename: String(img.filename || ''),
    }));

    // Validate inputs
    for (const input of inputs) {
      if (!input.url || !input.filename) {
        return json(400, { ok: false, error: 'Each image must have url and filename' }, originHdr);
      }
    }

    console.log('[smartdrafts-pairing-direct] Request', {
      imageCount: inputs.length,
      sampleFilenames: inputs.slice(0, 3).map(i => i.filename),
    });

    const result = await directPairProductsFromImages(inputs);

    console.log('[smartdrafts-pairing-direct] Success', {
      productCount: result.products.length,
    });

    return json(
      200,
      {
        ok: true,
        products: result.products,
      },
      originHdr
    );
  } catch (err) {
    console.error('[smartdrafts-pairing-direct] Unhandled error', err);
    return json(
      500,
      { ok: false, error: 'Internal error', detail: (err as Error).message },
      originHdr
    );
  }
};
