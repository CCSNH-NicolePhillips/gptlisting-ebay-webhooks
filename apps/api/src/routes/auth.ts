/**
 * auth.ts — Express routes for auth diagnostics.
 *
 * Mounts under /api/auth  (registered in routes/index.ts)
 *
 * Endpoints:
 *   GET /api/auth/debug  ← auth-debug-user
 */

import { Router } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { badRequest, serverError } from '../http/respond.js';

const router = Router();

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (_jwks) return _jwks;
  const domain = process.env.AUTH0_DOMAIN;
  if (!domain) throw new Error('AUTH0_DOMAIN not set');
  const url = new URL(`https://${domain}/.well-known/jwks.json`);
  _jwks = createRemoteJWKSet(url);
  return _jwks;
}

function safeDecodeJwt(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return { header: {}, payload: {} };
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return { header, payload };
  } catch {
    return { header: {}, payload: {} };
  }
}

// ---------------------------------------------------------------------------
// GET /api/auth/debug
//
// Decode and verify the bearer token, returning diagnostic information.
// Does NOT require the token to be valid — verifications errors are returned
// as structured data so clients can diagnose auth problems.
// ---------------------------------------------------------------------------
router.get('/debug', async (req, res) => {
  try {
    const raw = req.headers.authorization || '';
    if (!raw.startsWith('Bearer ')) return void badRequest(res, 'Missing Bearer token');

    const token = raw.slice(7).trim();
    const { header, payload } = safeDecodeJwt(token);

    const domain = process.env.AUTH0_DOMAIN || '';
    const audiences = (process.env.AUTH0_AUDIENCE || process.env.AUTH0_CLIENT_ID || '').split(',').filter(Boolean);
    const issuer = domain ? `https://${domain}/` : undefined;

    let verifyResult: { ok: boolean; subject?: string; error?: string } = { ok: false };
    try {
      const jwks = getJwks();
      const { payload: verified } = await jwtVerify(token, jwks, {
        ...(issuer ? { issuer } : {}),
        ...(audiences.length ? { audience: audiences } : {}),
      });
      verifyResult = { ok: true, subject: String(verified.sub || '') };
    } catch (verifyErr: unknown) {
      verifyResult = { ok: false, error: (verifyErr instanceof Error ? verifyErr.message : String(verifyErr)) };
    }

    res.json({
      mode: process.env.AUTH_MODE || 'admin',
      issuerExpected: issuer || null,
      audiencesExpected: audiences,
      tokenHeader: header,
      tokenClaims: payload,
      verify: verifyResult,
    });
  } catch (err: unknown) {
    serverError(res, err);
  }
});

export default router;
