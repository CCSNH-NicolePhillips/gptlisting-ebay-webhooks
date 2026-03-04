/**
 * packages/core/src/services/ingest/local-complete.service.ts
 *
 * Complete a local file upload:
 * given a list of S3/R2 object keys that the client PUT directly,
 * return canonical IngestedFile descriptors for the scan pipeline.
 *
 * Mirrors: netlify/functions/ingest-local-complete.ts
 * Route:   POST /api/ingest/local/complete
 */

import {
  ingestFiles,
  type IngestedFile,
  IngestError,
  IngestErrorCode,
} from '../../../../../src/ingestion/index.js';

// ─── Error classes ────────────────────────────────────────────────────────────

export class LocalCompleteError extends Error {
  readonly statusCode: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(message: string, statusCode: number, code?: string, details?: unknown) {
    super(message);
    this.name = 'LocalCompleteError';
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

// ─── Service ──────────────────────────────────────────────────────────────────

export interface LocalCompleteParams {
  userId: string;
  /** S3/R2 object keys for the files the client already PUT. */
  keys: string[];
}

export interface LocalCompleteResult {
  files: IngestedFile[];
  count: number;
  message: string;
}

/**
 * Resolve a list of S3 staging keys into IngestedFile descriptors.
 *
 * @throws {LocalCompleteError} on validation or ingestion errors.
 */
export async function completeLocalUpload(
  params: LocalCompleteParams,
): Promise<LocalCompleteResult> {
  const { userId, keys } = params;

  if (!Array.isArray(keys) || keys.length === 0) {
    throw new LocalCompleteError('keys must be a non-empty array', 400);
  }
  if (!keys.every((k) => typeof k === 'string')) {
    throw new LocalCompleteError('All keys must be strings', 400);
  }

  try {
    const files = await ingestFiles({
      source: 'local',
      userId,
      payload: { keys },
    });

    return {
      files,
      count: files.length,
      message:
        files.length === 0
          ? 'No valid image files found'
          : `${files.length} file(s) ready for processing`,
    };
  } catch (err) {
    if (err instanceof IngestError) {
      throw new LocalCompleteError(
        err.message,
        INGEST_ERROR_STATUS[err.code] ?? 500,
        err.code,
        err.details,
      );
    }
    throw err;
  }
}
