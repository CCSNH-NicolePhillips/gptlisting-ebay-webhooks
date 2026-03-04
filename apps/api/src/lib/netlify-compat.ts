/**
 * netlify-compat.ts
 *
 * Backwards-compatibility shim: rewrites /.netlify/functions/<name> requests
 * to the corresponding Express /api/* paths and handles them internally.
 *
 * This lets legacy client-side code (auth-client.js, HTML pages) continue
 * calling the old Netlify function URLs without any frontend changes.
 */

import type { Request, Response, NextFunction, Router } from 'express';

type ParamsFn = (
  query: Record<string, string>,
  body: Record<string, unknown>,
) => string;

/** For each Netlify function name, the new Express sub-router path (without /api prefix). */
const MAP: Record<string, string | ParamsFn> = {
  // ── CDN ─────────────────────────────────────────────────────────────────
  'cdn-auth0-spa': '/cdn/auth0-spa',

  // ── Connections ──────────────────────────────────────────────────────────
  'connections': '/connections',
  'disconnect': '/connections/disconnect',

  // ── Admin ────────────────────────────────────────────────────────────────
  'admin-list-user-images': '/admin/user-images',
  'admin-get-refresh-token': '/admin/refresh-token',
  'admin-set-ebay-token': '/admin/ebay-token',
  'migrate-legacy-tokens': '/admin/migrate-tokens',

  // ── Auth ─────────────────────────────────────────────────────────────────
  'auth-debug-user': '/auth/debug',

  // ── Analyze ──────────────────────────────────────────────────────────────
  'analyze-analytics': '/analyze/analytics',
  'analyze-images': '/analyze/images',
  'analyze-images-bg': '/analyze/images/bg',
  'analyze-images-bg-user': '/analyze/user/images/bg',
  'analyze-images-status': '/analyze/images/status',
  'analyze-images-status-user': '/analyze/user/images/status',
  'analyze-images-user': '/analyze/user/images',
  'analyze-jobs': '/analyze/jobs',
  'analyze-jobs-user': '/analyze/user/jobs',
  'analyze-job': (q) => `/analyze/jobs/${encodeURIComponent(q.jobId || q.id || '_')}`,
  'ai-gpt-drafts': '/analyze/gpt-drafts',
  'process': '/analyze/process',

  // ── Drafts ───────────────────────────────────────────────────────────────
  'draft-logs-get': '/drafts/logs',

  // ── Dropbox ──────────────────────────────────────────────────────────────
  'dropbox-list-files': '/dropbox/files',
  'dropbox-list-folders': '/dropbox/folders',
  'dropbox-list-images': '/dropbox/images',
  'dropbox-list-grouped': '/dropbox/grouped',
  'dropbox-get-thumbnails': '/dropbox/thumbnails',
  'dropbox-list-tree-user': '/dropbox/tree',
  'dropbox-oauth-start': '/dropbox/oauth/start',
  'dropbox-oauth-callback': '/dropbox/oauth/callback',

  // ── eBay OAuth ──────────────────────────────────────────────────────────
  'ebay-oauth-start': '/ebay/oauth/start',
  'ebay-oauth-callback': '/ebay/oauth/callback',

  // ── eBay Offers / Inventory ──────────────────────────────────────────────
  'ebay-list-offers': '/ebay/offers',
  'ebay-delete-offer': (q, b) => {
    const id = q.offerId || (b as any)?.offerId || '_';
    return `/ebay/offers/${encodeURIComponent(id)}`;
  },
  'ebay-publish-offer': (q, b) => {
    const id = q.offerId || (b as any)?.offerId || '_';
    return `/ebay/offers/${encodeURIComponent(id)}/publish`;
  },
  'ebay-offer-thumb': (q) => {
    const id = q.offerId || q.id || '_';
    return `/ebay/offers/${encodeURIComponent(id)}/thumb`;
  },
  'ebay-get-inventory-item': (q) => `/ebay/inventory/${encodeURIComponent(q.sku || '_')}`,
  'ebay-get-active-item': (q) => `/ebay/active-listings/${encodeURIComponent(q.itemId || '_')}`,
  'ebay-end-listing': '/ebay/listings/end',
  'ebay-update-listing': (q) => `/ebay/listings/${encodeURIComponent(q.id || q.itemId || '_')}`,

  // ── eBay Locations ───────────────────────────────────────────────────────
  'ebay-create-location': (q, b) => {
    const key = q.key || (b as any)?.key || '_';
    return `/ebay/locations/${encodeURIComponent(key)}`;
  },
  'ebay-delete-location': (q, b) => {
    const key = q.key || (b as any)?.key || '_';
    return `/ebay/locations/${encodeURIComponent(key)}`;
  },
  'ebay-enable-location': (q, b) => {
    const key = q.key || (b as any)?.key || '_';
    return `/ebay/locations/${encodeURIComponent(key)}/enable`;
  },
  'ebay-ensure-location': '/ebay/locations/ensure',
  'ebay-init-location-post': '/ebay/locations/init',

  // ── eBay Policies ────────────────────────────────────────────────────────
  'ebay-list-policies': '/ebay/policies',
  'ebay-create-policy': '/ebay/policies',
  'ebay-get-policy': (q) => `/ebay/policies/${encodeURIComponent(q.id || q.policyId || '_')}`,
  'ebay-delete-policy': (q, b) => {
    const id = q.id || q.policyId || (b as any)?.id || '_';
    return `/ebay/policies/${encodeURIComponent(id)}`;
  },
  'ebay-get-policy-defaults': '/ebay/policies/defaults',
  'ebay-ensure-policies': '/ebay/policies/ensure',
  'ebay-provision-policies': '/ebay/policies/provision',
  'ebay-set-policy-defaults': '/ebay/policies/set-defaults',
  'ebay-update-policy': '/ebay/policies/update',
  'ebay-policy-create-fulfillment': '/ebay/policies/fulfillment',

  // ── eBay Categories / Taxonomy ───────────────────────────────────────────
  'ebay-category-browse': '/ebay/categories/browse',
  'ebay-category-requirements': '/ebay/categories/requirements',
  'ebay-category-tree': '/ebay/categories/tree',
  'ebay-export-categories': '/ebay/categories/export',
  'ebay-fetch-all-categories': '/ebay/categories/fetch-all',
  'ebay-fetch-categories-background': '/ebay/categories/background',
  'ebay-fetch-categories-bulk': '/ebay/categories/fetch-bulk',
  'ebay-fetch-categories-status': '/ebay/categories/fetch-status',
  'ebay-cancel-category-jobs': '/ebay/categories/cancel',
  'ebay-fetch-category-aspects': '/ebay/categories/fetch-aspects',
  'ebay-category-suggestions': '/ebay/category-suggestions',
  'ebay-taxonomy-tree-id': '/ebay/taxonomy/tree-id',
  'ebay-taxonomy-aspects': '/ebay/taxonomy/aspects',

  // ── eBay Campaigns / Promotions ──────────────────────────────────────────
  'ebay-list-campaigns': '/ebay/campaigns',
  'ebay-list-active-trading': '/ebay/listings/active',
  'ebay-remove-promo': '/ebay/promotions/remove',
  'ebay-update-active-promo': '/ebay/promotions/active',
  'ebay-update-draft-promo': '/ebay/promotions/draft',
  'promote-drafts': '/ebay/promotions/promote-drafts',

  // ── eBay Optin / Debug ─────────────────────────────────────────────────
  'ebay-check-optin': '/ebay/optin',
  'ebay-debug-account': '/ebay/debug/account',
  'ebay-mad': '/ebay/mad',

  // ── eBay Drafts ──────────────────────────────────────────────────────────
  'ebay-create-draft': '/ebay/drafts/create',
  'ebay-fix-draft-aspects': '/ebay/drafts/fix-aspects',
  'ebay-fix-invalid-skus': '/ebay/drafts/fix-skus',
  'ebay-clean-drafts': '/ebay/drafts/clean',
  'ebay-clean-broken-drafts': '/ebay/drafts/clean-broken',
  'create-ebay-draft-user': '/ebay/drafts/create',

  // ── Images ───────────────────────────────────────────────────────────────
  'image-proxy': '/images/proxy',

  // ── Ingest ───────────────────────────────────────────────────────────────
  'ingest-local-upload': '/ingest/local',

  // ── Smartdrafts ──────────────────────────────────────────────────────────
  'smartdrafts-create-drafts-status': '/smartdrafts/create-drafts/status',
  'smartdrafts-scan-status': '/smartdrafts/scan/status',
  'smartdrafts-get-draft': '/smartdrafts/drafts',
  'smartdrafts-pairing-v2-start-local': '/smartdrafts/pairing/v2/start-local',
  'smartdrafts-pairing-v2-start': '/smartdrafts/pairing/v2/start',
  'smartdrafts-pairing-v2-status': '/smartdrafts/pairing/v2/status',
  'smartdrafts-scan-bg': '/smartdrafts/scan/start',
  'smartdrafts-scan': '/smartdrafts/scan',

  // ── Promotions queue ─────────────────────────────────────────────────────
  'promotion-process': '/promotions/process',
  'promotion-status': '/promotions/status',
  'queue-promotion': '/promotions/queue',
  'promotion-worker': '/promotions/worker',

  // ── Taxonomy override ────────────────────────────────────────────────────
  'taxonomy-override-upsert': '/taxonomy/override',

  // ── Diag ─────────────────────────────────────────────────────────────────
  'diag-env': '/diag/env',
  'diag-clip': '/diag/clip',
  'diag-offer': '/diag/offer',
  'diag-offers': '/diag/offers',
  'diag-payments-program': '/diag/payments-program',
  'diag-privileges': '/diag/privileges',
  'diag-whoami': '/diag/whoami',
  'debug-price': '/diag/debug-price',

  // ── Bind / Listings ──────────────────────────────────────────────────────
  'bind-listing': '/listings/bind',

  // ── Settings / Status ─────────────────────────────────────────────────────
  'connections-status': '/status',
};

/**
 * Returns Express middleware that resolves /.netlify/functions/:name requests
 * to the correct internal Express sub-router path.
 *
 * @param apiRouter  The sub-router mounted at /api in the main app.
 */
export function netlifyCompatMiddleware(apiRouter: Router) {
  return function netlifyCompat(req: Request, res: Response, next: NextFunction) {
    const name = req.params?.name as string | undefined;
    if (!name) return next();

    const entry = MAP[name];
    if (!entry) {
      return res.status(404).json({
        ok: false,
        error: `Netlify function '${name}' has no Express equivalent.`,
      });
    }

    const query = req.query as Record<string, string>;
    const body = (req.body as Record<string, unknown>) ?? {};

    // Build the new sub-router path (e.g. '/ebay/offers/abc123')
    const subPath = typeof entry === 'function' ? entry(query, body) : entry;

    // Preserve the original query string (everything after '?')
    const originalQs = req.originalUrl.includes('?')
      ? '?' + req.originalUrl.split('?').slice(1).join('?')
      : '';

    // Rewrite url so the sub-router sees the correct path + query string
    req.url = subPath + originalQs;

    // Dispatch through the API sub-router directly (no HTTP round-trip)
    apiRouter(req, res, next);
  };
}
