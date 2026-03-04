/**
 * connections.ts — Express routes for checking OAuth connection status.
 *
 * Mounts under /api/connections  (registered in routes/index.ts)
 *
 * Endpoints:
 *   GET /api/connections  ← connections.ts (Netlify)
 */

import { Router } from 'express';
import { requireUserAuth } from '../../../../src/lib/auth-user.js';
import { serverError } from '../http/respond.js';
import { getUserConnections } from '../../../../packages/core/src/services/connections/connections.service.js';
import { disconnectService } from '../../../../packages/core/src/services/connections/disconnect.service.js';

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/connections
//
// Probe eBay and Dropbox APIs for the authenticated user and return their
// connection status.
//
// Response 200:
//   { ok: true, ebay: { connected, ... }, dropbox: { connected, ... } }
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization || '');
    const result = await getUserConnections(userId);
    res.json(result);
  } catch (err: unknown) {
    if (err instanceof Error && (err.message.toLowerCase().includes('auth') || err.message.toLowerCase().includes('unauthorized'))) {
      return void res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/connections/disconnect
//
// Remove the stored OAuth refresh token for the specified service.
//
// Body: { service: 'ebay' | 'dropbox' }
//
// Response:
//   200 → { ok: true, service, message }
//   400 → { ok: false, error }  (invalid service)
//   401 → { ok: false, error }  (unauthenticated)
//   500 → { ok: false, error }  (unexpected)
// ---------------------------------------------------------------------------
router.post('/disconnect', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization || '');
    const service = req.body?.service as string | undefined;
    if (!service || (service !== 'ebay' && service !== 'dropbox')) {
      return void res.status(400).json({ ok: false, error: 'Invalid service parameter. Must be "ebay" or "dropbox"' });
    }
    const result = await disconnectService(userId, service);
    return void res.json(result);
  } catch (err: unknown) {
    if (err instanceof Error && (err.message.toLowerCase().includes('auth') || err.message.toLowerCase().includes('unauthorized'))) {
      return void res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    serverError(res, err);
  }
});

export default router;
