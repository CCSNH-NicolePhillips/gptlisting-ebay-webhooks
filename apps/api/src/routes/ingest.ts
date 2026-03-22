/**
 * apps/api/src/routes/ingest.ts
 *
 * POST /api/ingest/local/upload    — multipart file upload → stage to S3/R2
 * POST /api/ingest/local/init      — request presigned PUT URLs for direct upload
 * POST /api/ingest/local/complete  — register keys after direct PUT is done
 * POST /api/ingest/dropbox         — list + stage images from a Dropbox folder
 *
 * Mirrors:
 *   /.netlify/functions/ingest-local-upload
 *   /.netlify/functions/ingest-local-init
 *   /.netlify/functions/ingest-local-complete
 *   /.netlify/functions/ingest-dropbox-list
 */

import { Router } from 'express';
import { requireUserAuth } from '../../../../src/lib/auth-user.js';
import { handleUploadArray } from '../middleware/upload.js';
import {
  uploadLocalFiles,
  LocalUploadError,
} from '../../../../packages/core/src/services/images/local-upload.service.js';
import {
  completeLocalUpload,
  LocalCompleteError,
} from '../../../../packages/core/src/services/ingest/local-complete.service.js';
import {
  initLocalUpload,
  LocalInitError,
} from '../../../../packages/core/src/services/ingest/local-init.service.js';
import {
  listDropboxFiles,
  DropboxListError,
} from '../../../../packages/core/src/services/ingest/dropbox-list.service.js';
import { serverError, badRequest } from '../http/respond.js';

const router = Router();

// ---------------------------------------------------------------------------
// POST /api/ingest/local   (JSON body with base64 images)
//
// Mirrors: /.netlify/functions/ingest-local-upload
//
// The quick-list.html frontend sends JSON: { files: [{ name, mime, data }] }
// where data is a base64-encoded image string.
// This route decodes the base64 → Buffer and delegates to the same
// uploadLocalFiles service used by the multipart handler below.
//
// The netlify-compat layer maps ingest-local-upload → /ingest/local,
// so this handler catches that rewritten path.
// ---------------------------------------------------------------------------
router.post('/local', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization || '');
    const body = req.body as { files?: Array<{ name?: string; mime?: string; data?: string }> };

    if (!Array.isArray(body?.files) || body.files.length === 0) {
      return badRequest(res, 'Missing files array in request body');
    }

    // Decode base64 → Buffer for each file
    const incoming: Array<{ originalname: string; mimetype: string; buffer: Buffer }> = [];
    for (const f of body.files) {
      if (!f.data || !f.name) continue;
      const raw = f.data.includes(',')
        ? f.data.split(',')[1]  // strip data:mime;base64, prefix if present
        : f.data;
      incoming.push({
        originalname: f.name,
        mimetype: f.mime || 'image/jpeg',
        buffer: Buffer.from(raw, 'base64'),
      });
    }

    if (incoming.length === 0) {
      return badRequest(res, 'No valid files found in request body');
    }

    const result = await uploadLocalFiles(userId, incoming);
    return res.status(200).json({
      ok: true,
      files: result.files,
      count: result.count,
      message: `${result.count} file(s) uploaded successfully`,
    });
  } catch (err) {
    if (err instanceof LocalUploadError) {
      return res.status(err.statusCode).json({ ok: false, error: err.message });
    }
    if (err instanceof Error && err.message.toLowerCase().includes('auth')) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    return serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/ingest/local/upload   (multipart/form-data via multer)
// ---------------------------------------------------------------------------

router.post(
  '/local/upload',
  async (req, res, next) => {
    // Auth before multer so we 401 before consuming the stream
    try {
      const user = await requireUserAuth(req.headers.authorization || '');
      (req as any).__userId = user.userId;
      next();
    } catch {
      res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
  },
  handleUploadArray,
  async (req, res) => {
    try {
      const userId: string = (req as any).__userId;
      const files = req.files as Express.Multer.File[] | undefined;

      if (!files || files.length === 0) {
        return badRequest(res, 'No files uploaded (use field name "files")');
      }

      const result = await uploadLocalFiles(userId, files);

      return res.status(200).json({
        ok: true,
        files: result.files,
        count: result.count,
        message: `${result.count} file(s) uploaded successfully`,
      });
    } catch (err) {
      if (err instanceof LocalUploadError) {
        return res.status(err.statusCode).json({ ok: false, error: err.message });
      }
      return serverError(res, err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/ingest/local/init
//
// Request presigned S3/R2 PUT URLs so the browser can upload files directly
// to object storage (bypassing the API server).
//
// Mirrors: /.netlify/functions/ingest-local-init
//
// Body: { fileCount: number, mimeHints?: string[], filenames?: string[] }
//
// Response 200: { ok: true, uploads: PresignedUpload[], expiresIn: 600, instructions: string[] }
// Response 400: bad request
// Response 429: too many files
// ---------------------------------------------------------------------------
router.post('/local/init', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization || '');
    const body = req.body as {
      fileCount?: number;
      mimeHints?: string[];
      filenames?: string[];
    };

    const fileCount = Number(body?.fileCount);
    if (!fileCount || fileCount <= 0) {
      return badRequest(res, 'fileCount must be a positive number');
    }

    const result = await initLocalUpload({
      userId,
      fileCount,
      mimeHints: body.mimeHints,
      filenames: body.filenames,
    });

    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof LocalInitError) {
      return res.status(err.statusCode).json({ ok: false, error: err.message, code: err.code });
    }
    if (err instanceof Error && err.message.toLowerCase().includes('auth')) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    return serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/ingest/local/complete
//
// Register S3/R2 object keys for files the client already PUT directly.
// Returns IngestedFile descriptors ready for the SmartDrafts scan pipeline.
//
// Mirrors: /.netlify/functions/ingest-local-complete
//
// Body: { keys: string[] }
//
// Response 200: { ok: true, files: IngestedFile[], count: number, message: string }
// ---------------------------------------------------------------------------
router.post('/local/complete', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization || '');
    const body = req.body as { keys?: unknown };

    if (!Array.isArray(body?.keys) || body.keys.length === 0) {
      return badRequest(res, 'keys must be a non-empty array of strings');
    }

    const result = await completeLocalUpload({ userId, keys: body.keys as string[] });
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof LocalCompleteError) {
      return res.status(err.statusCode).json({ ok: false, error: err.message, code: err.code });
    }
    if (err instanceof Error && err.message.toLowerCase().includes('auth')) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    return serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/ingest/dropbox
//
// List images from a Dropbox folder and stage them for the SmartDrafts pipeline.
// Requires the user to have a connected Dropbox account.
//
// Mirrors: /.netlify/functions/ingest-dropbox-list
//
// Body: { folderPath: string, skipStaging?: boolean, jobId?: string }
//
// Response 200: { ok: true, files: IngestedFile[], count, folderPath, staged, message }
// Response 401: Dropbox not connected
// ---------------------------------------------------------------------------
router.post('/dropbox', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization || '');
    const body = req.body as {
      folderPath?: string;
      skipStaging?: boolean;
      jobId?: string;
    };

    if (!body?.folderPath) {
      return badRequest(res, 'folderPath is required');
    }

    const result = await listDropboxFiles({
      userId,
      folderPath: body.folderPath,
      skipStaging: body.skipStaging,
      jobId: body.jobId,
    });
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof DropboxListError) {
      return res.status(err.statusCode).json({ ok: false, error: err.message, code: err.code });
    }
    if (err instanceof Error && err.message.toLowerCase().includes('auth')) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    return serverError(res, err);
  }
});

export default router;
