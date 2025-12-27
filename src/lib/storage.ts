// src/lib/storage.ts
/**
 * Staging storage layer (Cloudflare R2 or AWS S3)
 * Handles presigned URLs, signed GET URLs, and file staging
 */

import { createHash } from 'node:crypto';
import type { StagingConfig, PresignedUpload, IngestError, IngestErrorCode } from '../ingestion/types.js';
import { getExtensionFromMime, sanitizeFilename } from './mime.js';

// AWS SDK v3 imports (compatible with Cloudflare R2)
import { S3Client, PutObjectCommand, GetObjectCommand, CopyObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Get staging config from environment
 */
export function getStagingConfig(): StagingConfig {
  const bucket = process.env.R2_BUCKET || process.env.S3_BUCKET;
  if (!bucket) {
    throw new Error('R2_BUCKET or S3_BUCKET environment variable required. Please configure Cloudflare R2 or AWS S3 in Netlify environment variables.');
  }
  
  const accessKeyId = process.env.R2_ACCESS_KEY_ID || process.env.STORAGE_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || '';
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || process.env.STORAGE_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || '';
  
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('Storage credentials required. Set R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY, STORAGE_ACCESS_KEY_ID/STORAGE_SECRET_ACCESS_KEY, or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY in environment variables.');
  }
  
  return {
    bucket,
    accountId: process.env.R2_ACCOUNT_ID || process.env.STORAGE_REGION || process.env.AWS_REGION,
    accessKeyId,
    secretAccessKey,
    publicUrlBase: process.env.R2_PUBLIC_URL,
    retentionHours: Number(process.env.STAGING_RETENTION_HOURS) || 72,
  };
}

/**
 * Create S3Client configured for R2 or S3
 */
export function createStorageClient(config?: StagingConfig): S3Client {
  const cfg = config || getStagingConfig();
  
  // Cloudflare R2 endpoint format
  // R2 uses pattern: https://<account-id>.r2.cloudflarestorage.com
  // Check if accountId looks like AWS region (e.g., us-east-1) vs R2 account ID
  const isR2 = !!cfg.accountId && !cfg.accountId.match(/^[a-z]{2}-[a-z]+-\d$/);
  
  const clientConfig: any = {
    region: isR2 ? 'auto' : (cfg.accountId || 'us-east-1'),
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
  };
  
  if (isR2) {
    // For R2, use the account-specific endpoint
    // IMPORTANT: Do NOT include bucket name in endpoint
    clientConfig.endpoint = `https://${cfg.accountId}.r2.cloudflarestorage.com`;
    // R2 REQUIRES path-style for presigned URLs to work with CORS
    // This generates: https://account-id.r2.cloudflarestorage.com/bucket-name/key
    clientConfig.forcePathStyle = true;
    console.log('[R2] Using path-style URLs with endpoint:', clientConfig.endpoint);
  }
  
  return new S3Client(clientConfig);
}

/**
 * Generate object key for staging
 * Format: staging/{userId}/{jobId}/{sha256}.{ext}
 */
export function generateStagingKey(
  userId: string,
  filename: string,
  jobId?: string
): string {
  const sanitized = sanitizeFilename(filename);
  const hash = createHash('sha256')
    .update(`${userId}-${filename}-${Date.now()}`)
    .digest('hex')
    .slice(0, 16);
  
  const job = jobId || 'default';
  // Sanitize userId to avoid special characters in S3 keys (e.g., | in google-oauth2|123)
  // This prevents presigned URL signature mismatches
  const safeUserId = userId.replace(/[^a-zA-Z0-9-_.]/g, '_');
  return `staging/${safeUserId}/${job}/${hash}-${sanitized}`;
}

/**
 * Generate presigned PUT URL for direct upload
 * Valid for 10 minutes
 */
export async function generatePresignedPutUrl(
  key: string,
  mime: string,
  expiresIn: number = 600 // 10 minutes
): Promise<string> {
  const client = createStorageClient();
  const config = getStagingConfig();
  
  const command = new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    ContentType: mime,
    // Add metadata for auto-deletion
    Metadata: {
      uploadedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + config.retentionHours! * 3600000).toISOString(),
    },
  });
  
  return await getSignedUrl(client, command, { expiresIn });
}

/**
 * Generate signed GET URL for private objects
 * Valid for 24 hours by default
 */
export async function generateSignedGetUrl(
  key: string,
  expiresIn: number = 86400 // 24 hours
): Promise<string> {
  const client = createStorageClient();
  const config = getStagingConfig();
  
  const command = new GetObjectCommand({
    Bucket: config.bucket,
    Key: key,
  });
  
  return await getSignedUrl(client, command, { expiresIn });
}

/**
 * Get public or signed URL for staged file
 */
export async function getStagedUrl(key: string): Promise<string> {
  const config = getStagingConfig();
  
  // If R2 public URL is configured, use it
  if (config.publicUrlBase) {
    return `${config.publicUrlBase}/${key}`;
  }
  
  // Otherwise generate signed URL
  return await generateSignedGetUrl(key);
}

/**
 * Copy file from external URL to staging
 * Returns the staging key
 */
export async function copyToStaging(
  sourceUrl: string,
  userId: string,
  filename: string,
  mime: string,
  jobId?: string
): Promise<string> {
  const key = generateStagingKey(userId, filename, jobId);
  const client = createStorageClient();
  const config = getStagingConfig();
  
  try {
    // Fetch from source
    const response = await fetch(sourceUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch source: ${response.status}`);
    }
    
    const buffer = await response.arrayBuffer();
    
    // Upload to staging
    const command = new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: new Uint8Array(buffer),
      ContentType: mime,
      Metadata: {
        uploadedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + config.retentionHours! * 3600000).toISOString(),
        sourceUrl,
      },
    });
    
    await client.send(command);
    return key;
  } catch (error: any) {
    throw new Error(`Failed to copy to staging: ${error.message}`);
  }
}

/**
 * Generate multiple presigned PUT URLs for batch upload
 */
export async function generatePresignedUploads(
  userId: string,
  fileInfos: Array<{ name: string; mime: string }>,
  jobId?: string
): Promise<PresignedUpload[]> {
  const uploads: PresignedUpload[] = [];
  
  for (const info of fileInfos) {
    const key = generateStagingKey(userId, info.name, jobId);
    const url = await generatePresignedPutUrl(key, info.mime);
    
    uploads.push({
      url,
      key,
      mime: info.mime,
    });
  }
  
  return uploads;
}

/**
 * Calculate total staging usage for a user
 */
export async function getUserStagingUsage(userId: string): Promise<number> {
  // TODO: Implement if needed for quota enforcement
  // Could use S3 ListObjectsV2 with prefix=staging/{userId}/
  // and sum up sizes
  return 0;
}

/**
 * Upload buffer directly to staging
 * Returns the public/signed URL for the uploaded file
 */
export async function uploadBufferToStaging(
  buffer: Buffer | Uint8Array,
  userId: string,
  filename: string,
  mime: string,
  jobId?: string
): Promise<string> {
  const key = generateStagingKey(userId, filename, jobId);
  const client = createStorageClient();
  const config = getStagingConfig();
  
  const command = new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    Body: buffer instanceof Buffer ? new Uint8Array(buffer) : buffer,
    ContentType: mime,
    Metadata: {
      uploadedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + (config.retentionHours || 72) * 3600000).toISOString(),
    },
  });
  
  await client.send(command);
  
  // Return public or signed URL
  return await getStagedUrl(key);
}

/**
 * Delete staged files (for cleanup after processing)
 */
export async function deleteStagedFiles(keys: string[]): Promise<void> {
  // TODO: Implement batch delete if needed
  // For now, rely on lifecycle rules for auto-deletion
}
