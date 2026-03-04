/**
 * apps/api/src/routes/images.ts
 *
 * GET /api/images/proxy?url=<src>   — proxy + re-encode external image
 * GET /api/images/verify?url=<src>  — check whether URL is a valid image
 * GET /api/images                   — HTML gallery (wraps Dropbox image list)
 *
 * Mirrors:
 *   /.netlify/functions/image-proxy
 *   /.netlify/functions/verify-image
 *   /.netlify/functions/view-images
 */

import { Router } from 'express';
import {
  proxyImage,
  ImageProxyError,
} from '../../../../packages/core/src/services/images/image-proxy.service.js';
import {
  verifyImage,
  VerifyImageError,
} from '../../../../packages/core/src/services/images/verify-image.service.js';
import { serverError } from '../http/respond.js';

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/images/proxy
// ---------------------------------------------------------------------------

router.get('/proxy', async (req, res) => {
  try {
    const url = (req.query.url as string | undefined)?.trim() ?? '';
    const { buffer, contentType } = await proxyImage(url);
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.set('Access-Control-Allow-Origin', '*');
    res.send(buffer);
  } catch (err) {
    if (err instanceof ImageProxyError) {
      // For client errors return JSON; for binary path keep it short
      return res.status(err.statusCode).send(err.message);
    }
    return serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/images/verify?url=<encoded-url>
//
// Checks whether a URL resolves to a valid image.
// Mirrors: /.netlify/functions/verify-image
//
// Query params:
//   url — the image URL to verify (required)
//
// Response 200: { ok: true, status, contentType, contentLength, sizeBytes, finalUrl }
// Response 422: { ok: false, ... } (URL resolves but is not an image)
// Response 400: { error: string } (missing url param)
// Response 502: { error: string } (network/upstream error)
// ---------------------------------------------------------------------------
router.get('/verify', async (req, res) => {
  const url = (req.query.url as string | undefined)?.trim() ?? '';
  if (!url) {
    return res.status(400).json({ error: 'Missing required query parameter: url' });
  }
  try {
    const result = await verifyImage(url);
    return res.status(result.ok ? 200 : 422).json(result);
  } catch (err) {
    if (err instanceof VerifyImageError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    return serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/images
//
// Serves a lightweight HTML image gallery page.
// Mirrors: /.netlify/functions/view-images
//
// The page fetches its own image list via the /api/dropbox/images endpoint
// (client-side JS) and renders thumbnails in the browser.
//
// Note: the Dropbox images endpoint must be ported separately for the gallery
// to load data; until then the gallery shows an empty state gracefully.
// ---------------------------------------------------------------------------
router.get('/', (_req, res) => {
  const apiBase = process.env.PUBLIC_URL || '';
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Image Gallery</title>
  <style>
    body { font-family: sans-serif; margin: 0; padding: 16px; background: #f5f5f5; }
    h1 { font-size: 1.25rem; color: #333; }
    #gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; margin-top: 16px; }
    .thumb { border-radius: 6px; overflow: hidden; background: #eee; aspect-ratio: 1; }
    .thumb img { width: 100%; height: 100%; object-fit: cover; }
    #status { color: #666; font-size: 0.9rem; margin-top: 8px; }
    .error { color: #c00; }
  </style>
</head>
<body>
  <h1>Dropbox Images</h1>
  <div id="status">Loading…</div>
  <div id="gallery"></div>
  <script>
    (async function () {
      const status = document.getElementById('status');
      const gallery = document.getElementById('gallery');
      try {
        const r = await fetch('${apiBase}/api/dropbox/images');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const data = await r.json();
        const urls = data.images || data.files || [];
        if (urls.length === 0) {
          status.textContent = 'No images found.';
          return;
        }
        status.textContent = urls.length + ' image(s) found.';
        urls.forEach(function (src) {
          const d = document.createElement('div');
          d.className = 'thumb';
          const img = document.createElement('img');
          img.src = typeof src === 'string' ? src : (src.url || src.src || '');
          img.loading = 'lazy';
          d.appendChild(img);
          gallery.appendChild(d);
        });
      } catch (err) {
        status.textContent = 'Error loading images: ' + err.message;
        status.className = 'error';
      }
    })();
  </script>
</body>
</html>`;
  res.set('Content-Type', 'text/html; charset=utf-8').send(html);
});

export default router;
