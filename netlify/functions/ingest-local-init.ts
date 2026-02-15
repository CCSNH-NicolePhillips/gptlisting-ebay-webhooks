// netlify/functions/ingest-local-init.ts
/**
 * Initialize local file upload
 * 
 * POST /.netlify/functions/ingest-local-init
 * Body: { fileCount: number, mimeHints?: string[], filenames?: string[] }
 * Returns: { uploads: [{ url, key, mime }] }
 */

import type { Handler } from '../../src/types/api-handler.js';
import { getJwtSubUnverified, getBearerToken } from '../../src/lib/_auth.js';
import { stageUpload, IngestError, IngestErrorCode } from '../../src/ingestion/index.js';

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

export const handler: Handler = async (event) => {
  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }
  
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }
  
  try {
    // Auth check
    const bearer = getBearerToken(event);
    const userId = getJwtSubUnverified(event);
    
    if (!bearer || !userId) {
      return jsonResponse(401, { error: 'Unauthorized' });
    }
    
    // Parse request
    const body = JSON.parse(event.body || '{}');
    const fileCount = body.fileCount;
    const mimeHints = body.mimeHints;
    const filenames = body.filenames;
    
    if (!fileCount || typeof fileCount !== 'number' || fileCount <= 0) {
      return jsonResponse(400, { error: 'fileCount must be a positive number' });
    }
    
    // Enforce max files per batch
    const MAX_FILES = Number(process.env.MAX_FILES_PER_BATCH) || 200;
    if (fileCount > MAX_FILES) {
      return jsonResponse(429, {
        error: `Maximum ${MAX_FILES} files per batch`,
        maxFiles: MAX_FILES,
        requested: fileCount,
        suggestion: `Try splitting into batches of ${MAX_FILES} or fewer`,
      });
    }
    
    // Generate presigned URLs
    const result = await stageUpload({
      source: 'local',
      userId,
      payload: {
        fileCount,
        mimeHints,
        filenames,
      },
    });
    
    console.log('[ingest-local-init] Generated', result.uploads.length, 'presigned URLs');
    console.log('[ingest-local-init] Sample URL:', result.uploads[0]?.url?.substring(0, 100) + '...');
    
    return jsonResponse(200, {
      ok: true,
      uploads: result.uploads,
      expiresIn: 600, // 10 minutes
      instructions: [
        'PUT each file to its corresponding URL',
        'Set Content-Type header to match the mime type',
        'Call /ingest-local-complete with keys when done',
      ],
    });
  } catch (error: any) {
    console.error('[ingest-local-init] Error:', error);
    
    if (error instanceof IngestError) {
      const statusMap = {
        [IngestErrorCode.QUOTA_EXCEEDED]: 429,
        [IngestErrorCode.INVALID_SOURCE]: 400,
        [IngestErrorCode.AUTH_FAILED]: 401,
        [IngestErrorCode.STAGING_FAILED]: 500,
        [IngestErrorCode.INVALID_FILE_TYPE]: 400,
        [IngestErrorCode.FILE_TOO_LARGE]: 413,
      };
      
      return jsonResponse(statusMap[error.code] || 500, {
        error: error.message,
        code: error.code,
        details: error.details,
      });
    }
    
    return jsonResponse(500, {
      error: 'Failed to initialize upload',
      message: error.message,
    });
  }
};
