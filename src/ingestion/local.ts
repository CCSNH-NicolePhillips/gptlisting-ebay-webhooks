// src/ingestion/local.ts
/**
 * Local Upload Adapter
 * 
 * Handles direct file uploads from user devices (Android/iOS/Desktop).
 * Files are uploaded to staging via presigned URLs, then processed.
 */

import type { IngestionAdapter, IngestRequest, IngestedFile, PresignedUpload } from './types.js';
import { guessMime, hasImageExtension } from '../lib/mime.js';
import { getStagedUrl, generatePresignedUploads, createStorageClient, getStagingConfig, generateStagingKey } from '../lib/storage.js';
import { IngestError, IngestErrorCode } from './types.js';
import { PutObjectCommand } from '@aws-sdk/client-s3';

export const LocalAdapter: IngestionAdapter = {
  /**
   * List already-uploaded files from staging
   * req.payload.keys: string[] - object keys in staging storage
   */
  async list(req: IngestRequest): Promise<IngestedFile[]> {
    const keys = req.payload.keys as string[] | undefined;
    
    if (!Array.isArray(keys) || keys.length === 0) {
      throw new IngestError(
        IngestErrorCode.INVALID_SOURCE,
        'Local adapter requires keys array in payload'
      );
    }
    
    const files: IngestedFile[] = [];
    
    for (const key of keys) {
      const name = key.split('/').pop() || key;
      
      // Skip non-image files
      if (!hasImageExtension(name)) {
        console.log(`[LocalAdapter] Skipping non-image file: ${name}`);
        continue;
      }
      
      const mime = guessMime(name);
      const stagedUrl = await getStagedUrl(key);
      
      files.push({
        id: key,
        name,
        mime,
        stagedUrl,
        meta: {
          sourcePath: key,
          sourceId: key,
          uploadedAt: new Date().toISOString(),
        },
      });
    }
    
    return files;
  },
  
  /**
   * Generate presigned URLs for upload initialization
   * req.payload: { fileCount: number, mimeHints?: string[], filenames?: string[] }
   */
  async stage(req: IngestRequest): Promise<{ uploads: PresignedUpload[] }> {
    const fileCount = req.payload.fileCount as number | undefined;
    const mimeHints = (req.payload.mimeHints as string[] | undefined) || [];
    const filenames = (req.payload.filenames as string[] | undefined) || [];
    
    if (!fileCount || fileCount <= 0) {
      throw new IngestError(
        IngestErrorCode.INVALID_SOURCE,
        'fileCount required for local upload staging'
      );
    }
    
    // Enforce max files per batch
    const MAX_FILES = 200;
    if (fileCount > MAX_FILES) {
      throw new IngestError(
        IngestErrorCode.QUOTA_EXCEEDED,
        `Maximum ${MAX_FILES} files per batch. Try splitting into smaller batches.`,
        { maxFiles: MAX_FILES, requested: fileCount }
      );
    }
    
    // Generate file info array
    const fileInfos = Array.from({ length: fileCount }, (_, i) => {
      const name = filenames[i] || `image-${i + 1}.jpg`;
      const mime = mimeHints[i] || guessMime(name);
      return { name, mime };
    });
    
    // Generate presigned URLs
    const uploads = await generatePresignedUploads(
      req.userId,
      fileInfos,
      req.payload.jobId as string | undefined
    );
    
    return { uploads };
  },
};

/**
 * Validate local upload payload for list operation
 */
export function validateLocalListPayload(payload: any): string[] {
  if (!payload || typeof payload !== 'object') {
    throw new IngestError(
      IngestErrorCode.INVALID_SOURCE,
      'Invalid payload for local adapter'
    );
  }
  
  const keys = payload.keys;
  if (!Array.isArray(keys)) {
    throw new IngestError(
      IngestErrorCode.INVALID_SOURCE,
      'keys must be an array'
    );
  }
  
  if (keys.length === 0) {
    throw new IngestError(
      IngestErrorCode.INVALID_SOURCE,
      'keys array cannot be empty'
    );
  }
  
  // Validate all keys are strings
  if (!keys.every(k => typeof k === 'string')) {
    throw new IngestError(
      IngestErrorCode.INVALID_SOURCE,
      'All keys must be strings'
    );
  }
  
  return keys;
}

/**
 * Upload files server-side (for Netlify function)
 * payload: { files: [{ name, mime, data: base64 }] }
 */
export async function uploadFilesServerSide(userId: string, files: Array<{ name: string; mime: string; data: string }>): Promise<string[]> {
  const client = createStorageClient();
  const config = getStagingConfig();
  const keys: string[] = [];
  
  console.log('[uploadFilesServerSide] Starting upload of', files.length, 'files');
  console.log('[uploadFilesServerSide] Bucket:', config.bucket);
  console.log('[uploadFilesServerSide] Account ID:', config.accountId);
  
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const key = generateStagingKey(userId, file.name);
    const buffer = Buffer.from(file.data, 'base64');
    
    console.log(`[uploadFilesServerSide] [${i + 1}/${files.length}] Uploading ${file.name} (${buffer.length} bytes) as ${key}`);
    
    try {
      const command = new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: buffer,
        ContentType: file.mime,
        Metadata: {
          uploadedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + config.retentionHours! * 3600000).toISOString(),
        },
      });
      
      await client.send(command);
      keys.push(key);
      console.log(`[uploadFilesServerSide] [${i + 1}/${files.length}] ✓ Success: ${key}`);
      
    } catch (error: any) {
      console.error(`[uploadFilesServerSide] [${i + 1}/${files.length}] ✗ Failed: ${file.name}`);
      console.error(`[uploadFilesServerSide] Error:`, error.message);
      throw error; // Re-throw to stop the upload process
    }
  }
  
  console.log('[uploadFilesServerSide] Upload complete!', keys.length, 'files uploaded');
  return keys;
}

/**
 * Validate local upload payload for stage operation
 */
export function validateLocalStagePayload(payload: any): {
  fileCount: number;
  mimeHints?: string[];
  filenames?: string[];
} {
  if (!payload || typeof payload !== 'object') {
    throw new IngestError(
      IngestErrorCode.INVALID_SOURCE,
      'Invalid payload for local adapter staging'
    );
  }
  
  const fileCount = payload.fileCount;
  if (typeof fileCount !== 'number' || fileCount <= 0) {
    throw new IngestError(
      IngestErrorCode.INVALID_SOURCE,
      'fileCount must be a positive number'
    );
  }
  
  return {
    fileCount,
    mimeHints: payload.mimeHints,
    filenames: payload.filenames,
  };
}
