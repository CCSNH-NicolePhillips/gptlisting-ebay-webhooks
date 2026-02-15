// netlify/functions/ingest-local-complete.ts
/**
 * Complete local file upload
 * 
 * POST /.netlify/functions/ingest-local-complete
 * Body: { keys: string[] }
 * Returns: { files: IngestedFile[] }
 */

import type { Handler } from '../../src/types/api-handler.js';
import { getJwtSubUnverified, getBearerToken } from '../../src/lib/_auth.js';
import { ingestFiles, IngestError, IngestErrorCode } from '../../src/ingestion/index.js';

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
    const keys = body.keys;
    
    if (!Array.isArray(keys) || keys.length === 0) {
      return jsonResponse(400, { error: 'keys must be a non-empty array' });
    }
    
    // Validate all keys are strings
    if (!keys.every(k => typeof k === 'string')) {
      return jsonResponse(400, { error: 'All keys must be strings' });
    }
    
    // List staged files
    const files = await ingestFiles({
      source: 'local',
      userId,
      payload: { keys },
    });
    
    return jsonResponse(200, {
      ok: true,
      files,
      count: files.length,
      message: files.length === 0 
        ? 'No valid image files found'
        : `${files.length} file(s) ready for processing`,
    });
  } catch (error: any) {
    console.error('[ingest-local-complete] Error:', error);
    
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
      error: 'Failed to complete upload',
      message: error.message,
    });
  }
};
