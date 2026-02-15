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

import type { Handler } from '../../src/types/api-handler.js';
import { getJwtSubUnverified, getBearerToken } from '../../src/lib/_auth.js';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'crypto';

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
  try {
    console.log('[ingest-local-upload] Handler invoked');
    console.log('[ingest-local-upload] HTTP method:', event.httpMethod);
    console.log('[ingest-local-upload] Headers:', JSON.stringify(event.headers));
    
    // Handle preflight
    if (event.httpMethod === 'OPTIONS') {
      console.log('[ingest-local-upload] Returning OPTIONS response');
      return { statusCode: 204, headers: CORS_HEADERS, body: '' };
    }
    
    if (event.httpMethod !== 'POST') {
      console.log('[ingest-local-upload] Invalid method');
      return jsonResponse(405, { error: 'Method not allowed' });
    }
    console.log('[ingest-local-upload] Starting upload process');
    
    // Auth check
    const bearer = getBearerToken(event);
    const userId = getJwtSubUnverified(event);
    
    console.log('[ingest-local-upload] User ID:', userId);
    console.log('[ingest-local-upload] Has bearer token:', !!bearer);
    
    if (!bearer || !userId) {
      console.log('[ingest-local-upload] Auth failed');
      return jsonResponse(401, { error: 'Unauthorized' });
    }
    
    // Parse request
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (parseError: any) {
      console.error('[ingest-local-upload] JSON parse error:', parseError.message);
      return jsonResponse(400, { error: 'Invalid JSON', message: parseError.message });
    }
    
    const filesInput = body.files;
    
    console.log('[ingest-local-upload] Files received:', Array.isArray(filesInput) ? filesInput.length : 0);
    
    if (!Array.isArray(filesInput)) {
      return jsonResponse(400, { error: 'files array required' });
    }
    if (filesInput.length === 0) {
      return jsonResponse(400, { error: 'files array required' });
    }
    const uploadFiles = filesInput as UploadFile[];
    
    // Enforce max files
    const MAX_FILES = 200;
    if (uploadFiles.length > MAX_FILES) {
      return jsonResponse(429, {
        error: `Maximum ${MAX_FILES} files per batch`,
        maxFiles: MAX_FILES,
        requested: uploadFiles.length,
      });
    }
    
    console.log('[ingest-local-upload] Creating storage client...');
    
    // Get S3/R2 config from environment
    // Note: AWS_* variables are reserved by Netlify, so we use STORAGE_* instead
    const bucket = process.env.S3_BUCKET || process.env.R2_BUCKET;
    const region = process.env.STORAGE_REGION || process.env.AWS_REGION || process.env.R2_ACCOUNT_ID || 'us-east-1';
    const accessKeyId = process.env.STORAGE_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID || '';
    const secretAccessKey = process.env.STORAGE_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY || '';
    
    if (!bucket || !accessKeyId || !secretAccessKey) {
      return jsonResponse(500, { 
        error: 'Storage not configured',
        message: 'S3_BUCKET/STORAGE_ACCESS_KEY_ID/STORAGE_SECRET_ACCESS_KEY environment variables required'
      });
    }
    
    console.log('[ingest-local-upload] Bucket:', bucket, 'Region:', region);
    
    // Create S3 client
    const client = new S3Client({
      region,
      credentials: { accessKeyId, secretAccessKey }
    });
    
    const uploadedFiles: Array<{ key: string; name: string; stagedUrl: string }> = [];
    
    // Upload each file
    for (let i = 0; i < uploadFiles.length; i++) {
      const file = uploadFiles[i];
      console.log(`[ingest-local-upload] [${i + 1}/${uploadFiles.length}] Uploading ${file.name}`);
      
      // Generate staging key: staging/{userId}/{jobId}/{hash}-{filename}
      const hash = createHash('md5').update(`${userId}-${file.name}-${Date.now()}`).digest('hex').substring(0, 16);
      const key = `staging/${userId}/default/${hash}-${file.name}`;
      const buffer = Buffer.from(file.data, 'base64');
      
      console.log(`[ingest-local-upload] Key: ${key}, Size: ${buffer.length} bytes`);
      
      try {
        await client.send(new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: buffer,
          ContentType: file.mime,
          Metadata: {
            uploadedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 72 * 3600000).toISOString(), // 72 hours
          },
        }));
        
        // Generate signed URL for the uploaded file (valid for 7 days)
        // This allows users to publish drafts within a week of uploading images
        const signedUrl = await getSignedUrl(
          client,
          new GetObjectCommand({ Bucket: bucket, Key: key }),
          { expiresIn: 604800 } // 7 days (604800 seconds)
        );
        
        uploadedFiles.push({
          key,
          name: file.name,
          stagedUrl: signedUrl,
        });
        
        console.log(`[ingest-local-upload] [${i + 1}/${uploadFiles.length}] ✓ Success - ${signedUrl.substring(0, 80)}...`);
        
      } catch (uploadError: any) {
        console.error(`[ingest-local-upload] [${i + 1}/${uploadFiles.length}] ✗ Failed:`, uploadError.message);
        throw uploadError;
      }
    }
    
    console.log(`[ingest-local-upload] Upload complete! ${uploadedFiles.length} files uploaded`);
    
    return jsonResponse(200, {
      ok: true,
      files: uploadedFiles,
      count: uploadedFiles.length,
      message: `${uploadedFiles.length} file(s) uploaded successfully`,
    });
    
  } catch (error: any) {
    console.error('[ingest-local-upload] Error:', error);
    console.error('[ingest-local-upload] Error stack:', error.stack);
    
    // Build detail string with max 500 chars
    let detail = error.message || String(error) || 'Unknown error';
    if (error.stack && process.env.NODE_ENV === 'development') {
      detail = `${detail}\n${error.stack}`;
    }
    if (detail.length > 500) {
      detail = detail.substring(0, 500) + '...';
    }
    
    return jsonResponse(500, {
      error: 'ingest-local-upload failed',
      detail,
    });
  }
};
