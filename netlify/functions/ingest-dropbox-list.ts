// netlify/functions/ingest-dropbox-list.ts
/**
 * List files from Dropbox folder
 * 
 * POST /.netlify/functions/ingest-dropbox-list
 * Body: { folderPath: string, skipStaging?: boolean }
 * Returns: { files: IngestedFile[] }
 */

import type { Handler } from '../../src/types/api-handler.js';
import { getJwtSubUnverified, getBearerToken, userScopedKey } from '../../src/lib/_auth.js';
import { tokensStore } from '../../src/lib/redis-store.js';
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
    const folderPath = body.folderPath;
    const skipStaging = body.skipStaging || false;
    const jobId = body.jobId;
    
    if (!folderPath || typeof folderPath !== 'string') {
      return jsonResponse(400, { error: 'folderPath required' });
    }
    
    // Get Dropbox refresh token from storage
    const store = tokensStore();
    const saved = (await store.get(userScopedKey(userId, 'dropbox.json'), { type: 'json' })) as any;
    const refreshToken = saved?.refresh_token;
    
    if (!refreshToken) {
      return jsonResponse(401, {
        error: 'Dropbox not connected',
        message: 'Please connect your Dropbox account first',
      });
    }
    
    // Ingest files
    const files = await ingestFiles({
      source: 'dropbox',
      userId,
      payload: {
        folderPath: folderPath.trim(),
        refreshToken,
        skipStaging,
        jobId,
      },
    });
    
    return jsonResponse(200, {
      ok: true,
      files,
      count: files.length,
      folderPath,
      staged: !skipStaging,
      message: files.length === 0
        ? 'No images found in folder'
        : `${files.length} file(s) ready for processing`,
    });
  } catch (error: any) {
    console.error('[ingest-dropbox-list] Error:', error);
    
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
      error: 'Failed to list Dropbox files',
      message: error.message,
    });
  }
};
