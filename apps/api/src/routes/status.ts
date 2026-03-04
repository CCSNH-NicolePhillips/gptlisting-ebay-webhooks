/**
 * status.ts — GET /api/status, POST /api/status
 *
 * Returns eBay + Dropbox connection status and usage stats for the
 * authenticated user.  POST with query ?dropbox=disconnect or
 * ?ebay=disconnect clears the provider token.
 *
 * Same JSON contract as /.netlify/functions/status.
 */

import { Router } from 'express';
import { requireUserAuthFull } from '../../../../src/lib/auth-user.js';
import {
  getConnectionStatus,
  disconnectProvider,
} from '../../../../src/services/user-status.service.js';

const router = Router();

async function resolveUser(authHeader: string | undefined) {
  return requireUserAuthFull(authHeader);
}

/**
 * GET /api/status
 *
 * Same JSON contract as /.netlify/functions/status (GET).
 * Returns: { dropbox, ebay, stats, user }
 */
router.get('/', async (req, res) => {
  try {
    const { userId, claims } = await resolveUser(req.headers.authorization);
    const status = await getConnectionStatus(userId, claims);
    return res.status(200).json(status);
  } catch (err) {
    return res.status(401).json({ error: 'unauthorized', detail: String(err) });
  }
});

/**
 * POST /api/status?dropbox=disconnect
 * POST /api/status?ebay=disconnect
 *
 * Same contract as /.netlify/functions/status (POST).
 * Returns: { ok: true }
 */
router.post('/', async (req, res) => {
  try {
    const { userId } = await resolveUser(req.headers.authorization);
    const { dropbox, ebay } = req.query as { dropbox?: string; ebay?: string };

    if (dropbox === 'disconnect') {
      await disconnectProvider(userId, 'dropbox');
      return res.status(200).json({ ok: true });
    }
    if (ebay === 'disconnect') {
      await disconnectProvider(userId, 'ebay');
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Missing disconnect query param (dropbox or ebay)' });
  } catch (err) {
    return res.status(401).json({ error: 'unauthorized', detail: String(err) });
  }
});

export default router;
