/**
 * config.ts — GET /api/config
 *
 * Exposes minimal public auth configuration to the frontend.
 * Same JSON contract as /.netlify/functions/get-public-config.
 * No auth required — called during initial page load before Auth0 is initialised.
 */

import { Router } from 'express';

const router = Router();

/**
 * GET /api/config
 *
 * Same JSON contract as /.netlify/functions/get-public-config.
 * Returns: { AUTH_MODE, AUTH0_DOMAIN?, AUTH0_CLIENT_ID?, AUTH0_AUDIENCE?, AUTH_MODE_RAW? }
 */
router.get('/', (_req, res) => {
  const rawMode = (process.env.AUTH_MODE || 'none').toLowerCase();
  const hasAuth0 = Boolean(process.env.AUTH0_DOMAIN && process.env.AUTH0_CLIENT_ID);
  const resolvedMode =
    hasAuth0 && ['admin', 'user', 'mixed', 'auth0'].includes(rawMode) ? 'auth0' : rawMode;

  const body: Record<string, string> = { AUTH_MODE: resolvedMode };
  if (rawMode !== resolvedMode) body.AUTH_MODE_RAW = rawMode;
  if (resolvedMode === 'auth0') {
    if (process.env.AUTH0_DOMAIN) body.AUTH0_DOMAIN = process.env.AUTH0_DOMAIN;
    if (process.env.AUTH0_CLIENT_ID) body.AUTH0_CLIENT_ID = process.env.AUTH0_CLIENT_ID;
    if (process.env.AUTH0_AUDIENCE) body.AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE;
  }

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(body);
});

export default router;
