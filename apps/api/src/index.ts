import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { router } from './routes/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve public/ relative to repo root (4 levels up from apps/api/src/)
const publicDir = join(__dirname, '../../../../public');

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true });
});

app.use('/api', router);

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

