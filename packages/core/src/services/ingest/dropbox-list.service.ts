/**
 * packages/core/src/services/ingest/dropbox-list.service.ts
 *
 * List image files from a Dropbox folder and return staged URLs for the
 * SmartDrafts scan pipeline.
 *
 * Mirrors: netlify/functions/ingest-dropbox-list.ts
 * Route:   POST /api/ingest/dropbox
 */

import { tokensStore } from '../../../../../src/lib/redis-store.js';
import { userScopedKey } from '../../../../../src/lib/_auth.js';
import {
  ingestFiles,
  type IngestedFile,
  IngestError,
  IngestErrorCode,
} from '../../../../../src/ingestion/index.js';

// ─── Error classes ────────────────────────────────────────────────────────────

export class DropboxListError extends Error {
  readonly statusCode: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(message: string, statusCode: number, code?: string, details?: unknown) {
    super(message);
    this.name = 'DropboxListError';
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

export interface DropboxListParams {
  userId: string;
  folderPath: string;
  skipStaging?: boolean;
  jobId?: string;
}

export interface DropboxListResult {
  files: IngestedFile[];
  count: number;
  folderPath: string;
  staged: boolean;
  message: string;
}

/**
 * List images from a Dropbox folder for the given user.
 * Requires the user to have a connected Dropbox account (refresh token in Redis).
 *
 * @throws {DropboxListError} on auth / validation / ingestion errors.
 */
export async function listDropboxFiles(
  params: DropboxListParams,
): Promise<DropboxListResult> {
  const { userId, folderPath, skipStaging = false, jobId } = params;

  if (!folderPath || typeof folderPath !== 'string') {
    throw new DropboxListError('folderPath required', 400);
  }

  // Resolve Dropbox refresh token from Redis
  const store = tokensStore();
  const saved = (await store.get(userScopedKey(userId, 'dropbox.json'), {
    type: 'json',
  })) as any;
  const refreshToken = saved?.refresh_token;

  if (!refreshToken) {
    throw new DropboxListError(
      'Dropbox not connected. Please connect your Dropbox account first.',
      401,
    );
  }

  try {
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

    return {
      files,
      count: files.length,
      folderPath,
      staged: !skipStaging,
      message:
        files.length === 0
          ? 'No images found in folder'
          : `${files.length} file(s) ready for processing`,
    };
  } catch (err) {
    if (err instanceof IngestError) {
      throw new DropboxListError(
        err.message,
        INGEST_ERROR_STATUS[err.code] ?? 500,
        err.code,
        err.details,
      );
    }
    throw err;
  }
}
