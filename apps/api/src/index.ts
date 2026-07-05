import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { router } from './routes/index.js';
import { netlifyCompatMiddleware } from './lib/netlify-compat.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve public/ relative to repo root. __dirname is dist/apps/api/src when
// running the compiled build (`npm start`) but apps/api/src when running the
// TS source directly via tsx (`npm run dev`) — one level shallower — so try
// both instead of hardcoding a single "N levels up" that only fits one mode.
const publicDirCandidates = [
  join(__dirname, '../../../../public'),
  join(__dirname, '../../../public'),
];
const publicDir = publicDirCandidates.find((p) => existsSync(p)) ?? publicDirCandidates[0];

const app = express();
app.use(express.json({ limit: '6mb' }));

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true });
});

app.use('/api', router);

// Netlify backwards-compatibility: rewrite /.netlify/functions/:name → /api/*
// Must be mounted AFTER /api so path param parsing works, but the middleware
// internally dispatches through router (no HTTP redirect, auth headers preserved).
app.use('/.netlify/functions/:name', netlifyCompatMiddleware(router));

// eBay's registered OAuth redirect URI (RuName) still points at this legacy
// path from before the Netlify-functions → Express migration — forward it to
// the real route instead of re-registering a new RuName with eBay.
app.get('/api/auth/callback/ebay', (req, res) => {
  const queryString = req.originalUrl.split('?')[1];
  res.redirect(`/api/ebay/oauth/callback${queryString ? '?' + queryString : ''}`);
});

// Redirect rules from public/_redirects
app.get('/', (_req, res) => res.sendFile(join(publicDir, 'welcome.html')));
app.get('/location', (_req, res) => res.sendFile(join(publicDir, 'location.html')));
app.get('/analyze', (_req, res) => res.sendFile(join(publicDir, 'analyze.html')));
app.get('/setup', (_req, res) => res.sendFile(join(publicDir, 'setup.html')));
app.get('/active-listings', (_req, res) => res.sendFile(join(publicDir, 'active-listings.html')));
app.get('/edit-active-listing', (_req, res) => res.sendFile(join(publicDir, 'edit-active-listing.html')));
app.get('/admin/analyze', (_req, res) => res.redirect(301, '/analyze'));
app.get('/admin/analyze.html', (_req, res) => res.redirect(301, '/analyze'));

// Serve static files from public/
app.use(express.static(publicDir));

const PORT = Number(process.env.PORT) || 3000;

// Only start listening when this file is run directly (not when imported by tests).
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`[api] listening on :${PORT}`);
  });
}

export { app };

