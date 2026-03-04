/**
 * admin.ts — Express routes for admin-only operations.
 *
 * Mounts under /api/admin  (registered in routes/index.ts)
 *
 * Endpoints:
 *   GET  /api/admin/refresh-token   ← admin-get-refresh-token
 *   GET  /api/admin/user-images     ← admin-list-user-images
 *   POST /api/admin/ebay-token      ← admin-set-ebay-token
 *   POST /api/admin/migrate-tokens  ← migrate-legacy-tokens
 */

import { Router } from 'express';
import { requireAdminAuth } from '../../../../src/lib/auth-admin.js';
import { badRequest, serverError } from '../http/respond.js';
import {
  getEbayRefreshToken,
  listUserImages,
  setEbayToken,
  migrateLegacyTokens,
  AdminNotFoundError,
  AdminTokenError,
  AdminStorageError,
} from '../../../../packages/core/src/services/admin/admin.service.js';

const router = Router();

// ---------------------------------------------------------------------------
// Auth helper — all admin routes share the same pattern
// ---------------------------------------------------------------------------

function parseAdmin(authHeader: string | undefined): string {
  requireAdminAuth(authHeader);           // throws if not authorized
  // Admin endpoints expose a userId via query or body; fall back to 'admin'
  return 'admin';
}

// ---------------------------------------------------------------------------
// GET /api/admin/refresh-token
//
// Returns the stored eBay refresh token for a given user (admin only).
// Query: ?userId=<sub>
// ---------------------------------------------------------------------------
router.get('/refresh-token', async (req, res) => {
  try {
    parseAdmin(req.headers.authorization);
    const userId = (req.query.userId as string) || '';
    if (!userId) return void badRequest(res, 'Missing userId query parameter');
    const result = await getEbayRefreshToken(userId);
    res.json({ ok: true, ...result });
  } catch (err: unknown) {
    if (err instanceof AdminNotFoundError) return void res.status(404).json({ ok: false, error: err.message });
    if (err instanceof Error && err.message.toLowerCase().includes('unauthorized')) {
      return void res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/user-images
//
// Lists staged images for a given user from S3/R2. (admin only)
// Query: ?userId=<sub>
// ---------------------------------------------------------------------------
router.get('/user-images', async (req, res) => {
  try {
    parseAdmin(req.headers.authorization);
    const userId = (req.query.userId as string) || '';
    if (!userId) return void badRequest(res, 'Missing userId query parameter');
    const result = await listUserImages(userId);
    res.json({ ok: true, ...result });
  } catch (err: unknown) {
    if (err instanceof AdminStorageError) return void res.status(500).json({ ok: false, error: err.message });
    if (err instanceof Error && err.message.toLowerCase().includes('unauthorized')) {
      return void res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/ebay-token
//
// Validate and store a new eBay refresh token for a user. (admin only)
// Body: { userId?: string, refresh_token: string }
// ---------------------------------------------------------------------------
router.post('/ebay-token', async (req, res) => {
  try {
    parseAdmin(req.headers.authorization);
    const body = req.body as { userId?: string; refresh_token?: string };
    const userId = body.userId || 'admin';
    const refreshToken = body.refresh_token;
    if (!refreshToken) return void badRequest(res, 'Missing refresh_token in body');
    const result = await setEbayToken(userId, refreshToken);
    res.json(result);
  } catch (err: unknown) {
    if (err instanceof AdminTokenError) return void res.status(400).json({ ok: false, error: err.message });
    if (err instanceof Error && err.message.toLowerCase().includes('unauthorized')) {
      return void res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/migrate-tokens
//
// Copy legacy global Redis tokens into user-scoped keys. (admin only)
// Body: { userId?: string }
// ---------------------------------------------------------------------------
router.post('/migrate-tokens', async (req, res) => {
  try {
    parseAdmin(req.headers.authorization);
    const body = req.body as { userId?: string };
    const userId = body.userId || 'admin';
    const result = await migrateLegacyTokens(userId);
    res.json({ ok: true, ...result });
  } catch (err: unknown) {
    if (err instanceof Error && err.message.toLowerCase().includes('unauthorized')) {
      return void res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    serverError(res, err);
  }
});

export default router;
