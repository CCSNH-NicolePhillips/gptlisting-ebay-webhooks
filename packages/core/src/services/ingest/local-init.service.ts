/**
 * packages/core/src/services/ingest/local-init.service.ts
 *
 * Initialize a client-side local file upload:
 * generate S3/R2 presigned PUT URLs so the browser can upload directly
 * without going through the API server.
 *
 * Mirrors: netlify/functions/ingest-local-init.ts
 * Route:   POST /api/ingest/local/init
 */

import {
  stageUpload,
  type PresignedUpload,
  IngestError,
  IngestErrorCode,
} from '../../../../../src/ingestion/index.js';

// ─── Error classes ────────────────────────────────────────────────────────────

export class LocalInitError extends Error {
  readonly statusCode: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(message: string, statusCode: number, code?: string, details?: unknown) {
    super(message);
    this.name = 'LocalInitError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const INGEST_ERROR_STATUS: Record<IngestErrorCode, number> = {
  [IngestErrorCode.QUOTA_EXCEEDED]: 429,
  [IngestErrorCode.INVALID_SOURCE]: 400,
  [IngestErrorCode.AUTH_FAILED]: 401,
  [IngestErrorCode.STAGING_FAILED]: 500,
  [IngestErrorCode.INVALID_FILE_TYPE]: 400,
  [IngestErrorCode.FILE_TOO_LARGE]: 413,
};

const DEFAULT_MAX_FILES = 200;

// ─── Service ──────────────────────────────────────────────────────────────────

export interface LocalInitParams {
  userId: string;
  fileCount: number;
  mimeHints?: string[];
  filenames?: string[];
}

export interface LocalInitResult {
  uploads: PresignedUpload[];
  expiresIn: number;
  instructions: string[];
}

/**
 * Generate presigned PUT URLs for a batch of local files.
 *
 * @throws {LocalInitError} on validation or staging errors.
 */
export async function initLocalUpload(
  params: LocalInitParams,
): Promise<LocalInitResult> {
  const { userId, fileCount, mimeHints, filenames } = params;

  if (!fileCount || typeof fileCount !== 'number' || fileCount <= 0) {
    throw new LocalInitError('fileCount must be a positive number', 400);
  }

  const maxFiles = Number(process.env.MAX_FILES_PER_BATCH) || DEFAULT_MAX_FILES;
  if (fileCount > maxFiles) {
    throw new LocalInitError(
      `Maximum ${maxFiles} files per batch`,
      429,
    );
  }

  try {
    const result = await stageUpload({
      source: 'local',
      userId,
      payload: { fileCount, mimeHints, filenames },
    });

    return {
      uploads: result.uploads,
      expiresIn: 600, // 10 minutes
      instructions: [
        'PUT each file to its corresponding URL',
        'Set Content-Type header to match the mime type',
        'Call /api/ingest/local/complete with keys when done',
      ],
    };
  } catch (err) {
    if (err instanceof IngestError) {
      throw new LocalInitError(
        err.message,
        INGEST_ERROR_STATUS[err.code] ?? 500,
        err.code,
        err.details,
      );
    }
    throw err;
  }
}
