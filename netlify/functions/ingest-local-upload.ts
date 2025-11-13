// netlify/functions/ingest-local-upload.ts
/**
 * Server-side upload proxy for R2
 * 
 * Receives base64-encoded file data from browser and uploads to R2
 * This bypasses the SSL issue with presigned URLs
 * 
 * POST /.netlify/functions/ingest-local-upload
 * Body: { files: [{ name, mime, data: base64 }] }
 * Returns: { keys: string[] }
 */

import type { Handler } from '@netlify/functions';
import { getJwtSubUnverified, getBearerToken } from '../../src/lib/_auth.js';
import { getStagingConfig, generateStagingKey, uploadToStaging } from '../../src/lib/storage.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(status: number, body: any) {
  return {
    statusCode: status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

interface UploadFile {
  name: string;
  mime: string;
  data: string; // base64
}

export const handler: Handler = async (event) => {
  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }
  
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }
  
  try {
    console.log('[ingest-local-upload] Starting upload process');
    
    // Auth check
    const bearer = getBearerToken(event);
    const userId = getJwtSubUnverified(event);
    
    console.log('[ingest-local-upload] User ID:', userId);
    
    if (!bearer || !userId) {
      return jsonResponse(401, { error: 'Unauthorized' });
    }
    
    // Parse request
    const body = JSON.parse(event.body || '{}');
    const files = body.files as UploadFile[] | undefined;
    
    console.log('[ingest-local-upload] Files received:', files?.length || 0);
    
    if (!Array.isArray(files) || files.length === 0) {
      return jsonResponse(400, { error: 'files array required' });
    }
    
    // Enforce max files
    const MAX_FILES = 200;
    if (files.length > MAX_FILES) {
      return jsonResponse(429, {
        error: `Maximum ${MAX_FILES} files per batch`,
        maxFiles: MAX_FILES,
        requested: files.length,
      });
    }
    
    console.log('[ingest-local-upload] Loading storage config...');
    const config = getStagingConfig();
    console.log('[ingest-local-upload] Storage config loaded, bucket:', config.bucket);

    const keys: string[] = [];

    // Upload each file
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      console.log(`[ingest-local-upload] Processing file ${i + 1}/${files.length}: ${file.name}`);

      const key = generateStagingKey(userId, file.name);
      const buffer = Buffer.from(file.data, 'base64');

      console.log(`[ingest-local-upload] Generated key: ${key}, size: ${buffer.length} bytes`);

      // Upload to staging using helper function
      await uploadToStaging(key, buffer, file.mime, {
        uploadedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + config.retentionHours! * 3600000).toISOString(),
      });

      keys.push(key);

      console.log(`[ingest-local-upload] ✓ Uploaded ${file.name} (${buffer.length} bytes) as ${key}`);
    }
    
    console.log(`[ingest-local-upload] Upload complete! ${keys.length} files uploaded`);
    
    return jsonResponse(200, {
      ok: true,
      keys,
      count: keys.length,
      message: `${keys.length} file(s) uploaded successfully`,
    });
    
  } catch (error: any) {
    console.error('[ingest-local-upload] Error:', error);
    console.error('[ingest-local-upload] Error stack:', error.stack);
    
    return jsonResponse(500, {
      error: 'Failed to upload files',
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  }
};
