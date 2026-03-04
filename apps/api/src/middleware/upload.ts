/**
 * apps/api/src/middleware/upload.ts
 *
 * Multer middleware for multipart file uploads.
 * Stores files in memory (buffer available at req.file / req.files).
 *
 * Limits:
 *   - File size: UPLOAD_MAX_BYTES env var (default 10 MiB)
 *   - Accepted MIME types: image/jpeg, image/png, image/webp (default)
 *
 * Error handling:
 *   - LIMIT_FILE_SIZE → 413 { ok: false, error: "File too large" }
 *   - Unsupported MIME type → 415 { ok: false, error: "Unsupported media type" }
 *
 * Per-route configuration via factory functions:
 *   makeUploadSingle(fieldName, opts?)
 *   makeUploadArray(fieldName, maxCount, opts?)
 */

import multer, { MulterError } from 'multer';
import type { Request, Response, NextFunction, RequestHandler } from 'express';

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const DEFAULT_MAX_FILE_BYTES = parseInt(process.env.UPLOAD_MAX_BYTES || '', 10) || 10 * 1024 * 1024; // 10 MiB

// ─── Upload options type ──────────────────────────────────────────────────────

export interface UploadOptions {
  /** MIME types to allow. Defaults to image/jpeg, image/png, image/webp. */
  allowedMimes?: string[];
  /** Max file size in bytes. Defaults to UPLOAD_MAX_BYTES env var or 10 MiB. */
  maxBytes?: number;
}

// ─── Internal factory ─────────────────────────────────────────────────────────

function buildMulter(opts?: UploadOptions) {
  const allowed = opts?.allowedMimes ? new Set(opts.allowedMimes) : DEFAULT_ALLOWED_MIMES;
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_FILE_BYTES;

  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes },
    fileFilter(_req, file, cb) {
      if (allowed.has(file.mimetype)) {
        cb(null, true);
      } else {
        const err = new Error(`Unsupported media type: ${file.mimetype}`) as any;
        err.code = 'INVALID_MIME';
        cb(err, false);
      }
    },
  });
}

// ─── Error-handling wrapper ───────────────────────────────────────────────────

function wrapWithErrorHandler(
  multerFn: (req: Request, res: Response, cb: (err: unknown) => void) => void,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    multerFn(req, res, (err: unknown) => {
      if (!err) return next();

      if (err instanceof MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          res.status(413).json({ ok: false, error: 'File too large' });
          return;
        }
        res.status(400).json({ ok: false, error: err.message });
        return;
      }

      const anyErr = err as any;
      if (anyErr?.code === 'INVALID_MIME') {
        res.status(415).json({ ok: false, error: 'Unsupported media type' });
        return;
      }

      next(err);
    });
  };
}

// ─── Per-route factory functions ──────────────────────────────────────────────

/**
 * Create a single-file upload middleware for any field name.
 *
 * @example
 *   router.post('/upload', makeUploadSingle('image'), async (req, res) => { ... })
 */
export function makeUploadSingle(fieldName: string, opts?: UploadOptions): RequestHandler {
  const m = buildMulter(opts);
  return wrapWithErrorHandler(m.single(fieldName));
}

/**
 * Create a multi-file upload middleware for any field name.
 *
 * @example
 *   router.post('/batch', makeUploadArray('files', 50), async (req, res) => { ... })
 */
export function makeUploadArray(
  fieldName: string,
  maxCount = 200,
  opts?: UploadOptions,
): RequestHandler {
  const m = buildMulter(opts);
  return wrapWithErrorHandler(m.array(fieldName, maxCount));
}

// ─── Backward-compatible convenience exports ──────────────────────────────────

const _defaultMulter = buildMulter();

/** @deprecated Use makeUploadSingle('file') instead. */
export const uploadSingle = _defaultMulter.single('file');

/** @deprecated Use makeUploadArray('files') instead. */
export const uploadArray = _defaultMulter.array('files', 200);

/**
 * Single-file upload middleware with error handling.
 * Expects field name "file". Equivalent to makeUploadSingle('file').
 */
export const handleUploadSingle = makeUploadSingle('file');

/**
 * Multi-file upload middleware with error handling.
 * Expects field name "files". Equivalent to makeUploadArray('files').
 */
export const handleUploadArray = makeUploadArray('files');
