/**
 * identity.ts — GET /api/me
 *
 * Returns the authenticated user's identity (sub, email, name).
 * Same JSON contract as /.netlify/functions/me.
 */

import { Router } from 'express';
import { requireUserAuthFull } from '../../../../src/lib/auth-user.js';

const router = Router();

/**
 * GET /api/me
 *
 * Same JSON contract as /.netlify/functions/me.
 * Returns: { ok: true, sub, email?, name? }
 * Errors:  401 { error: 'unauthorized' }
 */
router.get('/', async (req, res) => {
  try {
    const { userId, claims } = await requireUserAuthFull(req.headers.authorization);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      ok: true,
      sub: userId,
      email: typeof claims.email === 'string' ? claims.email : undefined,
      name: typeof claims.name === 'string' ? claims.name : undefined,
    });
  } catch (err) {
    return res.status(401).json({
      error: 'unauthorized',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

export default router;
