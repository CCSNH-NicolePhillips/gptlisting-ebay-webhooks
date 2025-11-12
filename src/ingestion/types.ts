// src/ingestion/types.ts
/**
 * Ingestion Adapter System
 * 
 * Unified interface for all file sources (local upload, Dropbox, Google Drive, etc.)
 * Files from any source are normalized into IngestedFile[] and staged to R2/S3.
 */

export type SourceType = 'dropbox' | 'local' | 'gdrive' | 's3' | 'icloud';

/**
 * Request to ingest files from a source
 */
export interface IngestRequest {
  /** The source type (dropbox, local, etc.) */
  source: SourceType;
  
  /** User ID from Auth0 JWT */
  userId: string;
  
  /** 
   * Source-specific payload:
   * - Dropbox: { folderPath: string, cursor?: string }
   * - Local: { keys: string[] } (after upload to staging)
   * - GDrive: { folderId: string, pageToken?: string }
   */
  payload: Record<string, any>;
}

/**
 * A file that has been ingested and staged
 */
export interface IngestedFile {
  /** Canonical ID (unique per file) */
  id: string;
  
  /** Original filename */
  name: string;
  
  /** MIME type (e.g., 'image/jpeg') */
  mime: string;
  
  /** File size in bytes (optional) */
  bytes?: number;
  
  /** Public or signed URL in staging storage (R2/S3) */
  stagedUrl: string;
  
  /** Source-specific metadata */
  meta?: {
    /** Original path in source system */
    sourcePath?: string;
    /** Dropbox file ID, Drive file ID, etc. */
    sourceId?: string;
    /** Timestamp when file was created in source */
    sourceCreatedAt?: string;
    /** Any other source-specific data */
    [key: string]: any;
  };
}

/**
 * Response from init endpoint (for local uploads)
 */
export interface PresignedUpload {
  /** Presigned PUT URL (valid for 10 minutes) */
  url: string;
  
  /** Object key in staging storage */
  key: string;
  
  /** Expected MIME type */
  mime?: string;
}

/**
 * Adapter interface - all sources must implement this
 */
export interface IngestionAdapter {
  /**
   * List/enumerate files from source and ensure they're staged
   * @param req - Ingestion request with source-specific payload
   * @returns Array of ingested files with stagedUrl populated
   */
  list(req: IngestRequest): Promise<IngestedFile[]>;
  
  /**
   * (Optional) Initialize upload for sources that need presigned URLs
   * @param req - Request with file count, MIME hints, etc.
   * @returns Presigned upload URLs and keys
   */
  stage?(req: IngestRequest): Promise<{ uploads: PresignedUpload[] }>;
}

/**
 * Configuration for staging storage
 */
export interface StagingConfig {
  /** R2/S3 bucket name */
  bucket: string;
  
  /** Account ID (Cloudflare) or region (AWS) */
  accountId?: string;
  
  /** Access key ID */
  accessKeyId: string;
  
  /** Secret access key */
  secretAccessKey: string;
  
  /** Public URL base (for Cloudflare R2 public buckets) */
  publicUrlBase?: string;
  
  /** Retention period in hours (default 72) */
  retentionHours?: number;
}

/**
 * Per-user quota limits
 */
export interface QuotaLimits {
  /** Max files per init/batch (default 200) */
  maxFilesPerBatch: number;
  
  /** Max staging bytes per user (default 2GB) */
  maxStagingBytes: number;
  
  /** Max concurrent jobs per user (default 3) */
  maxConcurrentJobs: number;
}

/**
 * Error types for ingestion failures
 */
export enum IngestErrorCode {
  QUOTA_EXCEEDED = 'QUOTA_EXCEEDED',
  INVALID_SOURCE = 'INVALID_SOURCE',
  AUTH_FAILED = 'AUTH_FAILED',
  STAGING_FAILED = 'STAGING_FAILED',
  INVALID_FILE_TYPE = 'INVALID_FILE_TYPE',
  FILE_TOO_LARGE = 'FILE_TOO_LARGE',
}

export class IngestError extends Error {
  constructor(
    public code: IngestErrorCode,
    message: string,
    public details?: any
  ) {
    super(message);
    this.name = 'IngestError';
  }
}
