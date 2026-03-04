/**
 * cdn.ts — Express routes for proxied CDN assets.
 *
 * Mounts under /api/cdn  (registered in routes/index.ts)
 *
 * Endpoints:
 *   GET /api/cdn/auth0-spa  ← cdn-auth0-spa.ts (Netlify)
 */

import { Router } from 'express';
import { serverError } from '../http/respond.js';
import { fetchAuth0SpaSdk, Auth0SpaFetchError } from '../../../../packages/core/src/services/cdn/auth0-spa.service.js';

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/cdn/auth0-spa
//
// Proxy / serve the Auth0 SPA SDK with a long-lived cache header.
//
// Query params:
//   v   — SDK version   (default: '2.0.3')
//   esm — 'true' | '1' → return ESM build from unpkg.com
//
// Response 200: JavaScript file with Cache-Control: public, max-age=86400
// ---------------------------------------------------------------------------
router.get('/auth0-spa', async (req, res) => {
  try {
    const version = ((req.query.v as string) || '2.0.3').replace(/[^0-9a-zA-Z.\-]/g, '');
    const esm = req.query.esm === 'true' || req.query.esm === '1';

    const { body, contentType } = await fetchAuth0SpaSdk(version, esm);

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(body);
  } catch (err: unknown) {
    if (err instanceof Auth0SpaFetchError) {
      return void res.status(err.statusCode).json({ ok: false, error: err.message });
    }
    serverError(res, err);
  }
});

export default router;
