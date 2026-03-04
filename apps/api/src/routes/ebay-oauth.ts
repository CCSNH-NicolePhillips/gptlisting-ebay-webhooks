/**
 * ebay-oauth.ts — Express routes for the eBay OAuth 2.0 connect/disconnect flow.
 *
 * Mounts under /api/ebay/oauth  (registered in routes/ebay.ts)
 *
 * Endpoints:
 *   GET  /api/ebay/oauth/start      ← /.netlify/functions/ebay-oauth-start
 *   GET  /api/ebay/oauth/callback   ← /.netlify/functions/ebay-oauth-callback
 */

import { Router } from 'express';
import { requireUserAuth } from '../../../../src/lib/auth-user.js';
import {
  startEbayOAuth,
  callbackEbayOAuth,
  sanitizeReturnTo,
  EbayOAuthConfigError,
  EbayOAuthStateError,
  EbayOAuthTokenError,
} from '../../../../packages/core/src/services/oauth/ebay-oauth.service.js';

const router = Router();

// ── Popup-success HTML template ───────────────────────────────────────────────
function popupSuccessHtml(service: string, label: string): string {
  return `<!DOCTYPE html>
<html>
<head><title>${label} Connected</title></head>
<body style="background:#0a0a1a;color:#fff;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
<div style="text-align:center;">
<h2 style="color:#4ade80;">&#10003; ${label} Connected!</h2>
<p>This window will close automatically...</p>
</div>
<script>
  if (window.opener) {
    try { window.opener.postMessage({ type: 'oauth-complete', service: '${service}', success: true }, '*'); } catch(e) {}
  }
  setTimeout(() => window.close(), 1500);
</script>
</body>
</html>`;
}

// ── GET /api/ebay/oauth/start ─────────────────────────────────────────────────
//
// Initiates the eBay OAuth flow.  Requires a valid Auth0 JWT — either via the
// Authorization header or the ?token= query parameter (popup flows).
//
// Query params:
//   returnTo  (optional) — relative path or 'popup' to redirect after callback
//   mode      (optional) — 'json' to return { redirect: url } instead of 302
//
// Response:
//   302  → eBay authorization URL
//   200  → { redirect: string }  (when mode=json or Accept: application/json)
//   401  → { error: 'Unauthorized' }
//   500  → { error: string }
// ─────────────────────────────────────────────────────────────────────────────
router.get('/start', async (req, res) => {
  // Support Bearer in header or ?token= query param (used by popup flows)
  const authHeader =
    req.headers.authorization ||
    (req.query.token ? `Bearer ${req.query.token}` : '');

  let userId: string;
  try {
    const user = await requireUserAuth(authHeader);
    userId = user.userId;
  } catch {
    const wantsJson =
      /application\/json/i.test(req.headers.accept || '') ||
      req.query.mode === 'json';
    if (wantsJson) {
      return void res.status(401).json({ error: 'Unauthorized' });
    }
    return void res.redirect('/login.html');
  }

  const queryReturnTo = sanitizeReturnTo(req.query.returnTo);
  const returnTo = queryReturnTo;

  try {
    const { redirectUrl } = await startEbayOAuth(userId, returnTo);
    const wantsJson =
      /application\/json/i.test(req.headers.accept || '') ||
      req.query.mode === 'json';
    if (wantsJson) {
      return void res.json({ redirect: redirectUrl });
    }
    return void res.redirect(redirectUrl);
  } catch (err) {
    if (err instanceof EbayOAuthConfigError) {
      return void res.status(500).json({ error: err.message });
    }
    return void res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/ebay/oauth/callback ──────────────────────────────────────────────
//
// eBay redirects the browser here after the user authorizes the app.
// No auth header required — the sub is recovered from the Redis state record.
//
// Query params:
//   code   — authorization code from eBay
//   state  — opaque nonce created by /start
//
// Response:
//   302  → returnTo path (or /index.html) on success
//   200  → popup HTML page if state.returnTo === 'popup'
//   400  → { error, hint }  on validation failure
//   500  → { error }  on unexpected failure
// ─────────────────────────────────────────────────────────────────────────────
router.get('/callback', async (req, res) => {
  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;

  if (!code) {
    return void res.status(400).json({ error: 'Missing ?code' });
  }
  if (!state) {
    return void res.status(400).json({ error: 'Missing ?state' });
  }

  try {
    const { returnTo, isPopup } = await callbackEbayOAuth(code, state);

    if (isPopup) {
      return void res
        .set('Content-Type', 'text/html; charset=utf-8')
        .send(popupSuccessHtml('ebay', 'eBay'));
    }

    return void res.redirect(returnTo || '/index.html');
  } catch (err) {
    if (err instanceof EbayOAuthStateError) {
      return void res.status(400).json({
        error: 'invalid_state',
        hint: 'Start eBay connect from the app while signed in',
      });
    }
    if (err instanceof EbayOAuthTokenError) {
      return void res.status(err.statusCode).json({
        error: err.message,
        detail: err.detail,
        hint: 'Ensure EBAY_ENV=PROD matches your RUName and the redirect URL is correct',
      });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return void res.status(500).json({ error: `OAuth error: ${msg}` });
  }
});

export default router;
