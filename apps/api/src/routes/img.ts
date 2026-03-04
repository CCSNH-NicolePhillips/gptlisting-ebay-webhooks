/**
 * apps/api/src/routes/img.ts
 *
 * GET /api/img?k=<s3-key>
 *
 * Short URL redirect for S3/R2 images.
 * eBay requires picture URLs ≤500 characters; presigned URLs are often
 * 550+ chars.  This endpoint generates a signed GET URL and issues a 302.
 *
 * Mirrors: /.netlify/functions/img
 */

import { Router } from 'express';
import {
  getSignedImageUrl,
  InvalidImageKeyError,
} from '../../../../packages/core/src/services/images/img.service.js';
import { serverError } from '../http/respond.js';

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/img
// ---------------------------------------------------------------------------

router.get('/', async (req, res) => {
  try {
    const key = (req.query.k as string | undefined)?.trim() ?? '';
    const signedUrl = await getSignedImageUrl(key);
    res.set('Cache-Control', 'private, max-age=3600');
    res.redirect(302, signedUrl);
  } catch (err) {
    if (err instanceof InvalidImageKeyError) {
      return res.status(err.statusCode).json({ ok: false, error: err.message });
    }
    return serverError(res, err);
  }
});

export default router;
