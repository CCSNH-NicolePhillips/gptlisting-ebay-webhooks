/**
 * Express Server — Railway Deployment
 * 
 * Each API handler becomes a route at /.netlify/functions/{name}
 * (path kept for backward compatibility with frontend)
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { wrapHandler, wrapBackgroundHandler } from './adapter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8888;

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: '50mb' }));

// CORS middleware
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  next();
});

// Health check
const BUILD_TIME = new Date().toISOString();
const GIT_SHA = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.COMMIT_SHA || 'unknown';
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), buildTime: BUILD_TIME, gitSha: GIT_SHA });
});

// Legacy OAuth callback redirects (eBay RuName may point to old paths)
app.get('/api/auth/callback/ebay', (req, res) => {
  // Preserve query params (code, state, etc.)
  const queryString = req.originalUrl.split('?')[1] || '';
  res.redirect(`/.netlify/functions/ebay-oauth-callback${queryString ? '?' + queryString : ''}`);
});

app.get('/api/auth/callback/dropbox', (req, res) => {
  const queryString = req.originalUrl.split('?')[1] || '';
  res.redirect(`/.netlify/functions/dropbox-oauth-callback${queryString ? '?' + queryString : ''}`);
});

// Dropbox may be configured to redirect to /lander - catch this
app.get('/lander', (req, res) => {
  console.log('[server] /lander route hit with query:', req.query);
  const queryString = req.originalUrl.split('?')[1] || '';
  // If there's a code param, this is a Dropbox OAuth callback
  if (req.query.code) {
    console.log('[server] Redirecting /lander to dropbox-oauth-callback');
    res.redirect(`/.netlify/functions/dropbox-oauth-callback${queryString ? '?' + queryString : ''}`);
  } else {
    res.redirect('/');
  }
});

// Static files (public folder)
// In dev: src/server -> ../../public
// In prod: dist/src/server -> ../../../public
const publicPath = path.join(__dirname, '../../../public');
app.use(express.static(publicPath));

// ============================================================================
// Function Routes - Auto-generated from netlify/functions
// Route pattern: /.netlify/functions/{function-name}
// ============================================================================

// Background functions (long-running, respond immediately with 202)
const backgroundFunctions = [
  'analyze-images-background',
  'smartdrafts-scan-background',
  'smartdrafts-create-drafts-background',
  'pairing-v2-processor-background',
  'ebay-fetch-categories-background',
];

async function registerRoutes() {
  const functions = [
    'admin-get-refresh-token',
    'admin-list-user-images',
    'admin-set-ebay-token',
    'ai-gpt-drafts',
    'analyze-analytics',
    'analyze-images',
    'analyze-images-background',
    'analyze-images-bg',
    'analyze-images-bg-user',
    'analyze-images-status',
    'analyze-images-status-user',
    'analyze-images-user',
    'analyze-job',
    'analyze-jobs',
    'analyze-jobs-user',
    'auth-debug-user',
    'bind-listing',
    'cdn-auth0-spa',
    'connections',
    'create-ebay-draft-user',
    'dbx-list-tree-user',
    'debug-get-ebay-token',
    'debug-price',
    'diag-clip',
    'diag-env',
    'diag-offer',
    'diag-offers',
    'diag-payments-program',
    'diag-privileges',
    'diag-whoami',
    'disconnect',
    'draft-logs-get',
    'dropbox-get-thumbnails',
    'dropbox-list-files',
    'dropbox-list-folders',
    'dropbox-list-grouped',
    'dropbox-list-images',
    'dropbox-oauth-callback',
    'dropbox-oauth-start',
    'ebay-cancel-category-jobs',
    'ebay-category-browse',
    'ebay-category-requirements',
    'ebay-category-suggestions',
    'ebay-category-tree',
    'ebay-check-optin',
    'ebay-clean-broken-drafts',
    'ebay-clean-drafts',
    'ebay-create-draft',
    'ebay-create-location',
    'ebay-create-policy',
    'ebay-debug-account',
    'ebay-delete-location',
    'ebay-delete-offer',
    'ebay-delete-policy',
    'ebay-enable-location',
    'ebay-end-listing',
    'ebay-ensure-location',
    'ebay-ensure-policies',
    'ebay-export-categories',
    'ebay-fetch-all-categories',
    'ebay-fetch-categories-background',
    'ebay-fetch-categories-bulk',
    'ebay-fetch-categories-status',
    'ebay-fetch-category-aspects',
    'ebay-fix-draft-aspects',
    'ebay-fix-invalid-skus',
    'ebay-get-active-item',
    'ebay-get-inventory-item',
    'ebay-get-location-user',
    'ebay-get-marketing-defaults',
    'ebay-get-offer',
    'ebay-get-policy',
    'ebay-get-policy-defaults',
    // 'ebay-get-promoted-listings', // Empty file, not implemented
    'ebay-init-location',
    'ebay-init-location-post',
    'ebay-list-active',
    'ebay-list-active-trading',
    'ebay-list-active-v2',
    'ebay-list-campaigns',
    'ebay-list-locations',
    'ebay-list-offers',
    'ebay-list-policies',
    'ebay-mad',
    'ebay-oauth-callback',
    'ebay-oauth-start',
    'ebay-offer-thumb',
    'ebay-optin',
    'ebay-platform',
    'ebay-policy-create-fulfillment',
    'ebay-provision-policies',
    'ebay-publish-offer',
    'ebay-remove-promo',
    'ebay-set-location-user',
    'ebay-set-marketing-default',
    'ebay-set-policy-defaults',
    'ebay-taxonomy-aspects',
    'ebay-taxonomy-tree-id',
    'ebay-update-active-item',
    'ebay-update-active-promo',
    'ebay-update-draft-promo',
    'ebay-update-policy',
    'get-my-ebay-token',
    'get-public-config',
    'image-proxy',
    'img',
    'ingest-dropbox-list',
    'ingest-local-complete',
    'ingest-local-init',
    'ingest-local-upload',
    'listing-plan',
    'me',
    'migrate-legacy-tokens',
    'pairing-v2-processor-background',
    'price-reduction-list',
    'price-reduction-update',
    'price-tick',
    'process',
    'promote-drafts',
    'promotion-process',
    'promotion-status',
    'promotion-test',
    'promotion-worker',
    'queue-promotion',
    'reprice',
    'show-my-ebay-token',
    'smartdrafts-analyze',
    'smartdrafts-create-drafts',
    'smartdrafts-create-drafts-background',
    'smartdrafts-create-drafts-bg',
    'smartdrafts-create-drafts-status',
    'smartdrafts-get-draft',
    'smartdrafts-metrics',
    'smartdrafts-pairing-v2-start',
    'smartdrafts-pairing-v2-start-from-scan',
    'smartdrafts-pairing-v2-start-local',
    'smartdrafts-pairing-v2-status',
    'smartdrafts-quick-list-pipeline',
    'smartdrafts-quick-list-processor',
    'smartdrafts-reset',
    'smartdrafts-save-drafts',
    'smartdrafts-scan',
    'smartdrafts-scan-background',
    'smartdrafts-scan-bg',
    'smartdrafts-scan-status',
    'smartdrafts-update-draft',
    'status',
    'taxonomy-get',
    'taxonomy-list',
    'taxonomy-override-upsert',
    'taxonomy-upsert',
    'test-upload-simple',
    'user-settings-get',
    'user-settings-save',
    'verify-image',
    'view-images',
  ];

  for (const name of functions) {
    try {
      // Dynamic import of the function module
      // At runtime we're in dist/src/server/, functions are in dist/netlify/functions/
      const absolutePath = path.join(__dirname, '../../netlify/functions', `${name}.js`);
      const moduleUrl = `file://${absolutePath.replace(/\\/g, '/')}`;
      const module = await import(moduleUrl);
      const handler = module.handler;

      if (!handler) {
        console.warn(`[server] No handler exported from ${name}`);
        continue;
      }

      const routePath = `/.netlify/functions/${name}`;
      const isBackground = backgroundFunctions.includes(name);

      if (isBackground) {
        app.all(routePath, wrapBackgroundHandler(handler));
        console.log(`[server] Registered background: ${routePath}`);
      } else {
        app.all(routePath, wrapHandler(handler));
        console.log(`[server] Registered: ${routePath}`);
      }
    } catch (err) {
      console.error(`[server] Failed to load ${name}:`, err);
    }
  }
}

// Start server
async function start() {
  // Register all function routes first
  await registerRoutes();
  
  // ============================================================================
  // Scheduled Jobs - Replace Netlify scheduled functions
  // ============================================================================
  
  // Import promotion worker handler for scheduled execution
  try {
    const promotionWorkerPath = path.join(__dirname, '../../netlify/functions', 'promotion-worker.js');
    const promotionWorkerUrl = `file://${promotionWorkerPath.replace(/\\/g, '/')}`;
    const promotionWorkerModule = await import(promotionWorkerUrl);
    
    if (promotionWorkerModule.handler) {
      // Run promotion worker every minute
      const PROMOTION_INTERVAL_MS = 60 * 1000; // 1 minute
      
      const runPromotionWorker = async () => {
        try {
          console.log('[scheduler] Running promotion-worker...');
          const fakeEvent = {
            httpMethod: 'POST',
            path: '/.netlify/functions/promotion-worker',
            headers: { 'x-scheduler': 'internal' },
            body: null,
            queryStringParameters: {},
            rawUrl: 'http://localhost/.netlify/functions/promotion-worker',
            rawQuery: '',
            isBase64Encoded: false,
          };
          await promotionWorkerModule.handler(fakeEvent, {});
          console.log('[scheduler] promotion-worker completed');
        } catch (err) {
          console.error('[scheduler] promotion-worker error:', err);
        }
      };
      
      // Start the interval
      setInterval(runPromotionWorker, PROMOTION_INTERVAL_MS);
      console.log('[scheduler] Promotion worker scheduled to run every minute');
      
      // Run immediately on startup after a short delay (let server stabilize)
      setTimeout(runPromotionWorker, 10000);
    }
  } catch (err) {
    console.error('[scheduler] Failed to initialize promotion worker:', err);
  }
  
  // Fallback for SPA routing (serve index.html for non-API routes)
  // Must come AFTER route registration
  app.get('*', (req, res) => {
    // Don't serve index.html for API routes
    if (req.path.startsWith('/.netlify/')) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.sendFile(path.join(publicPath, 'index.html'));
  });
  
  const server = app.listen(PORT, () => {
    console.log(`[server] DraftPilot running on port ${PORT}`);
    console.log(`[server] Health check: http://localhost:${PORT}/health`);
    console.log(`[server] API base: http://localhost:${PORT}/.netlify/functions/`);
  });

  // Keep process alive and handle shutdown gracefully
  server.on('error', (err) => {
    console.error('[server] Server error:', err);
    process.exit(1);
  });

  process.on('SIGTERM', () => {
    console.log('[server] SIGTERM received, shutting down...');
    server.close(() => process.exit(0));
  });

  process.on('SIGINT', () => {
    console.log('[server] SIGINT received, shutting down...');
    server.close(() => process.exit(0));
  });
}

// Handle unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('[server] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[server] Uncaught Exception:', err);
  process.exit(1);
});

start().catch((err) => {
  console.error('[server] Failed to start:', err);
  process.exit(1);
});
