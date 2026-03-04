# Endpoints Migration Inventory

Tracks the migration from Netlify Functions (`/.netlify/functions/*`) to the
Express API (`/api/*`).

**Status values**

| Value | Meaning |
|---|---|
| `ported` | Express route live, tests written, frontend updated |
| `stubbed` | Route file created but not fully implemented |
| `not-started` | No Express equivalent yet |

**Notes tags**

| Tag | Meaning |
|---|---|
| `auth` | Requires Auth0 user JWT (`Authorization: Bearer`) |
| `admin` | Admin-only endpoint |
| `redis` | Reads/writes Upstash Redis |
| `bg` | Background worker — long-running (10 min+) |
| `OAuth` | OAuth redirect flow — needs HTTPS callback URL |
| `binary` | Returns binary / image data |
| `upload` | Accepts multipart file uploads |

Auto-generated rows can be refreshed with:

```
npx tsx scripts/list-netlify-functions.ts
```

Diff against filesystem (fails if new functions are unlisted):

```
npx tsx scripts/list-netlify-functions.ts --diff
```

---

## Admin

| Function file | Old URL | New target URL | Status | Notes |
|---|---|---|---|---|
| netlify/functions/admin-get-refresh-token.ts | /.netlify/functions/admin-get-refresh-token | /api/admin/refresh-token | ported | admin, redis |
| netlify/functions/admin-list-user-images.ts | /.netlify/functions/admin-list-user-images | /api/admin/user-images | ported | admin |
| netlify/functions/admin-set-ebay-token.ts | /.netlify/functions/admin-set-ebay-token | /api/admin/ebay-token | ported | admin, redis |
| netlify/functions/migrate-legacy-tokens.ts | /.netlify/functions/migrate-legacy-tokens | /api/admin/migrate-tokens | ported | admin, redis |

## AI / Analyze

| Function file | Old URL | New target URL | Status | Notes |
|---|---|---|---|---|
| netlify/functions/ai-gpt-drafts.ts | /.netlify/functions/ai-gpt-drafts | /api/ai/gpt-drafts | not-started | auth |
| netlify/functions/analyze-analytics.ts | /.netlify/functions/analyze-analytics | /api/analyze/analytics | ported | auth, redis |
| netlify/functions/analyze-images-background.ts | /.netlify/functions/analyze-images-background | /api/analyze/images/worker | not-started | redis, bg |
| netlify/functions/analyze-images-bg-user.ts | /.netlify/functions/analyze-images-bg-user | /api/analyze/images/start | not-started | auth, redis, bg |
| netlify/functions/analyze-images-bg.ts | /.netlify/functions/analyze-images-bg | /api/analyze/images/start-admin | not-started | redis, bg |
| netlify/functions/analyze-images-status-user.ts | /.netlify/functions/analyze-images-status-user | /api/analyze/images/status | not-started | auth, redis |
| netlify/functions/analyze-images-status.ts | /.netlify/functions/analyze-images-status | /api/analyze/images/status-admin | not-started | redis |
| netlify/functions/analyze-images-user.ts | /.netlify/functions/analyze-images-user | /api/analyze/images | not-started | auth |
| netlify/functions/analyze-images.ts | /.netlify/functions/analyze-images | /api/analyze/images-admin | not-started | |
| netlify/functions/analyze-job.ts | /.netlify/functions/analyze-job | /api/analyze/jobs/:id | not-started | auth |
| netlify/functions/analyze-jobs-user.ts | /.netlify/functions/analyze-jobs-user | /api/analyze/jobs | not-started | auth, redis |
| netlify/functions/analyze-jobs.ts | /.netlify/functions/analyze-jobs | /api/analyze/jobs-admin | not-started | redis |

## Auth / Identity

| Function file | Old URL | New target URL | Status | Notes |
|---|---|---|---|---|
| netlify/functions/auth-debug-user.ts | /.netlify/functions/auth-debug-user | /api/auth/debug | ported | auth |
| netlify/functions/me.ts | /.netlify/functions/me | /api/me | ported | auth |
| netlify/functions/connections.ts | /.netlify/functions/connections | /api/connections | ported | redis |
| netlify/functions/disconnect.ts | /.netlify/functions/disconnect | /api/connections/disconnect | ported | redis |

## Dropbox

| Function file | Old URL | New target URL | Status | Notes |
|---|---|---|---|---|
| netlify/functions/dbx-list-tree-user.ts | /.netlify/functions/dbx-list-tree-user | /api/dropbox/tree | not-started | auth, redis |
| netlify/functions/dropbox-get-thumbnails.ts | /.netlify/functions/dropbox-get-thumbnails | /api/dropbox/thumbnails | not-started | redis |
| netlify/functions/dropbox-list-files.ts | /.netlify/functions/dropbox-list-files | /api/dropbox/files | not-started | redis |
| netlify/functions/dropbox-list-folders.ts | /.netlify/functions/dropbox-list-folders | /api/dropbox/folders | not-started | redis |
| netlify/functions/dropbox-list-grouped.ts | /.netlify/functions/dropbox-list-grouped | /api/dropbox/grouped | not-started | redis |
| netlify/functions/dropbox-list-images.ts | /.netlify/functions/dropbox-list-images | /api/dropbox/images | not-started | redis |
| netlify/functions/dropbox-oauth-callback.ts | /.netlify/functions/dropbox-oauth-callback | /api/dropbox/oauth/callback | ported | redis, OAuth |
| netlify/functions/dropbox-oauth-start.ts | /.netlify/functions/dropbox-oauth-start | /api/dropbox/oauth/start | ported | redis, OAuth |

## Debug / Diagnostics

| Function file | Old URL | New target URL | Status | Notes |
|---|---|---|---|---|
| netlify/functions/debug-price.ts | /.netlify/functions/debug-price | /api/debug/price | not-started | |
| netlify/functions/diag-clip.ts | /.netlify/functions/diag-clip | /api/diag/clip | not-started | |
| netlify/functions/diag-env.ts | /.netlify/functions/diag-env | /api/diag/env | not-started | |
| netlify/functions/diag-offer.ts | /.netlify/functions/diag-offer | /api/diag/offer | not-started | redis |
| netlify/functions/diag-offers.ts | /.netlify/functions/diag-offers | /api/diag/offers | not-started | redis |
| netlify/functions/diag-payments-program.ts | /.netlify/functions/diag-payments-program | /api/diag/payments | not-started | redis |
| netlify/functions/diag-privileges.ts | /.netlify/functions/diag-privileges | /api/diag/privileges | not-started | redis |
| netlify/functions/diag-whoami.ts | /.netlify/functions/diag-whoami | /api/diag/whoami | not-started | redis |

## Drafts

| Function file | Old URL | New target URL | Status | Notes |
|---|---|---|---|---|
| netlify/functions/create-ebay-draft-user.ts | /.netlify/functions/create-ebay-draft-user | /api/drafts | ported | auth, redis |
| netlify/functions/draft-logs-get.ts | /.netlify/functions/draft-logs-get | /api/drafts/logs | ported | redis |
| netlify/functions/bind-listing.ts | /.netlify/functions/bind-listing | /api/listings/bind | ported | |
| netlify/functions/listing-plan.ts | /.netlify/functions/listing-plan | /api/listings/plan | ported | redis |

## eBay — Categories & Taxonomy

| Function file | Old URL | New target URL | Status | Notes |
|---|---|---|---|---|
| netlify/functions/ebay-cancel-category-jobs.ts | /.netlify/functions/ebay-cancel-category-jobs | /api/ebay/categories/jobs/cancel | not-started | redis |
| netlify/functions/ebay-category-browse.ts | /.netlify/functions/ebay-category-browse | /api/ebay/categories/browse | not-started | |
| netlify/functions/ebay-category-requirements.ts | /.netlify/functions/ebay-category-requirements | /api/ebay/categories/requirements | not-started | redis |
| netlify/functions/ebay-category-suggestions.ts | /.netlify/functions/ebay-category-suggestions | /api/ebay/category-suggestions | ported | |
| netlify/functions/ebay-category-tree.ts | /.netlify/functions/ebay-category-tree | /api/ebay/categories/tree | not-started | redis |
| netlify/functions/ebay-export-categories.ts | /.netlify/functions/ebay-export-categories | /api/ebay/categories/export | not-started | redis |
| netlify/functions/ebay-fetch-all-categories.ts | /.netlify/functions/ebay-fetch-all-categories | /api/ebay/categories | not-started | redis |
| netlify/functions/ebay-fetch-categories-background.ts | /.netlify/functions/ebay-fetch-categories-background | /api/ebay/categories/fetch-worker | not-started | redis, bg |
| netlify/functions/ebay-fetch-categories-bulk.ts | /.netlify/functions/ebay-fetch-categories-bulk | /api/ebay/categories/bulk | not-started | redis |
| netlify/functions/ebay-fetch-categories-status.ts | /.netlify/functions/ebay-fetch-categories-status | /api/ebay/categories/status | not-started | redis |
| netlify/functions/ebay-fetch-category-aspects.ts | /.netlify/functions/ebay-fetch-category-aspects | /api/ebay/categories/aspects | not-started | redis |
| netlify/functions/ebay-taxonomy-aspects.ts | /.netlify/functions/ebay-taxonomy-aspects | /api/ebay/taxonomy/aspects | not-started | redis |
| netlify/functions/ebay-taxonomy-tree-id.ts | /.netlify/functions/ebay-taxonomy-tree-id | /api/ebay/taxonomy/tree-id | not-started | |
| netlify/functions/taxonomy-get.ts | /.netlify/functions/taxonomy-get | /api/taxonomy/:id | not-started | |
| netlify/functions/taxonomy-list.ts | /.netlify/functions/taxonomy-list | /api/taxonomy | not-started | |
| netlify/functions/taxonomy-override-upsert.ts | /.netlify/functions/taxonomy-override-upsert | /api/taxonomy/overrides | not-started | auth |
| netlify/functions/taxonomy-upsert.ts | /.netlify/functions/taxonomy-upsert | /api/taxonomy | not-started | |

## eBay — Drafts & Inventory

| Function file | Old URL | New target URL | Status | Notes |
|---|---|---|---|---|
| netlify/functions/ebay-clean-broken-drafts.ts | /.netlify/functions/ebay-clean-broken-drafts | /api/ebay/drafts/clean-broken | not-started | redis |
| netlify/functions/ebay-clean-drafts.ts | /.netlify/functions/ebay-clean-drafts | /api/ebay/drafts/clean | not-started | redis |
| netlify/functions/ebay-create-draft.ts | /.netlify/functions/ebay-create-draft | /api/ebay/drafts | not-started | auth, redis |
| netlify/functions/ebay-delete-offer.ts | /.netlify/functions/ebay-delete-offer | DELETE /api/ebay/offers/:offerId | ported | redis, auth |
| netlify/functions/ebay-fix-draft-aspects.ts | /.netlify/functions/ebay-fix-draft-aspects | /api/ebay/drafts/fix-aspects | not-started | auth, redis |
| netlify/functions/ebay-fix-invalid-skus.ts | /.netlify/functions/ebay-fix-invalid-skus | /api/ebay/drafts/fix-skus | not-started | redis |
| netlify/functions/ebay-get-inventory-item.ts | /.netlify/functions/ebay-get-inventory-item | /api/ebay/inventory/:sku | ported | redis |
| netlify/functions/ebay-get-offer.ts | /.netlify/functions/ebay-get-offer | GET /api/ebay/offers/:offerId | ported | redis, auth |
| netlify/functions/ebay-list-offers.ts | /.netlify/functions/ebay-list-offers | GET /api/ebay/offers | ported | redis, auth |
| netlify/functions/ebay-offer-thumb.ts | /.netlify/functions/ebay-offer-thumb | /api/ebay/offers/:id/thumb | ported | redis, binary |
| netlify/functions/ebay-publish-offer.ts | /.netlify/functions/ebay-publish-offer | POST /api/ebay/offers/:offerId/publish | ported | redis, auth |

## eBay — Listings

| Function file | Old URL | New target URL | Status | Notes |
|---|---|---|---|---|
| netlify/functions/ebay-end-listing.ts | /.netlify/functions/ebay-end-listing | POST /api/ebay/listings/end | ported | redis, auth |
| netlify/functions/ebay-get-active-item.ts | /.netlify/functions/ebay-get-active-item | /api/ebay/active-listings/:itemId | ported | redis |
| netlify/functions/ebay-list-active-trading.ts | /.netlify/functions/ebay-list-active-trading | /api/ebay/listings/active | ported | redis |
| netlify/functions/ebay-update-active-item.ts | /.netlify/functions/ebay-update-active-item | /api/ebay/listings/:id | ported | redis |

## eBay — Locations

| Function file | Old URL | New target URL | Status | Notes |
|---|---|---|---|---|
| netlify/functions/ebay-create-location.ts | /.netlify/functions/ebay-create-location | /api/ebay/locations | not-started | redis |
| netlify/functions/ebay-delete-location.ts | /.netlify/functions/ebay-delete-location | /api/ebay/locations/:id | not-started | redis |
| netlify/functions/ebay-enable-location.ts | /.netlify/functions/ebay-enable-location | /api/ebay/locations/:id/enable | not-started | redis |
| netlify/functions/ebay-ensure-location.ts | /.netlify/functions/ebay-ensure-location | /api/ebay/locations/ensure | not-started | redis |
| netlify/functions/ebay-get-location-user.ts | /.netlify/functions/ebay-get-location-user | /api/ebay/locations/user | ported | auth, redis |
| netlify/functions/ebay-init-location-post.ts | /.netlify/functions/ebay-init-location-post | /api/ebay/locations/init | not-started | redis |
| netlify/functions/ebay-list-locations.ts | /.netlify/functions/ebay-list-locations | /api/ebay/locations | ported | redis |
| netlify/functions/ebay-set-location-user.ts | /.netlify/functions/ebay-set-location-user | /api/ebay/locations/user | ported | auth, redis |

## eBay — OAuth

| Function file | Old URL | New target URL | Status | Notes |
|---|---|---|---|---|
| netlify/functions/ebay-oauth-callback.ts | /.netlify/functions/ebay-oauth-callback | /api/ebay/oauth/callback | ported | redis, OAuth |
| netlify/functions/ebay-oauth-start.ts | /.netlify/functions/ebay-oauth-start | /api/ebay/oauth/start | ported | OAuth |

## eBay — Policies

| Function file | Old URL | New target URL | Status | Notes |
|---|---|---|---|---|
| netlify/functions/ebay-create-policy.ts | /.netlify/functions/ebay-create-policy | /api/ebay/policies | ported | redis |
| netlify/functions/ebay-delete-policy.ts | /.netlify/functions/ebay-delete-policy | /api/ebay/policies/:id | ported | redis |
| netlify/functions/ebay-ensure-policies.ts | /.netlify/functions/ebay-ensure-policies | /api/ebay/policies/ensure | not-started | redis |
| netlify/functions/ebay-get-policy-defaults.ts | /.netlify/functions/ebay-get-policy-defaults | /api/ebay/policies/defaults | ported | redis |
| netlify/functions/ebay-get-policy.ts | /.netlify/functions/ebay-get-policy | /api/ebay/policies/:id | ported | |
| netlify/functions/ebay-list-policies.ts | /.netlify/functions/ebay-list-policies | /api/ebay/policies | ported | |
| netlify/functions/ebay-policy-create-fulfillment.ts | /.netlify/functions/ebay-policy-create-fulfillment | /api/ebay/policies/fulfillment | not-started | redis |
| netlify/functions/ebay-provision-policies.ts | /.netlify/functions/ebay-provision-policies | /api/ebay/policies/provision | not-started | redis |
| netlify/functions/ebay-set-policy-defaults.ts | /.netlify/functions/ebay-set-policy-defaults | /api/ebay/policies/defaults | not-started | redis |
| netlify/functions/ebay-update-policy.ts | /.netlify/functions/ebay-update-policy | /api/ebay/policies/:id | not-started | redis |

## eBay — Promotions / Marketing

| Function file | Old URL | New target URL | Status | Notes |
|---|---|---|---|---|
| netlify/functions/ebay-check-optin.ts | /.netlify/functions/ebay-check-optin | /api/ebay/optin | ported | |
| netlify/functions/ebay-debug-account.ts | /.netlify/functions/ebay-debug-account | /api/ebay/debug/account | not-started | redis |
| netlify/functions/ebay-get-marketing-defaults.ts | /.netlify/functions/ebay-get-marketing-defaults | /api/ebay/marketing/defaults | ported | redis |
| netlify/functions/ebay-list-campaigns.ts | /.netlify/functions/ebay-list-campaigns | /api/ebay/campaigns | ported | redis |
| netlify/functions/ebay-mad.ts | /.netlify/functions/ebay-mad | /api/ebay/mad | not-started | redis |
| netlify/functions/ebay-optin.ts | /.netlify/functions/ebay-optin | /api/ebay/optin | not-started | |
| netlify/functions/ebay-remove-promo.ts | /.netlify/functions/ebay-remove-promo | /api/ebay/promotions/:id | not-started | redis |
| netlify/functions/ebay-set-marketing-default.ts | /.netlify/functions/ebay-set-marketing-default | /api/ebay/marketing/defaults | ported | redis |
| netlify/functions/ebay-update-active-promo.ts | /.netlify/functions/ebay-update-active-promo | /api/ebay/promotions/active | not-started | redis |
| netlify/functions/ebay-update-draft-promo.ts | /.netlify/functions/ebay-update-draft-promo | /api/ebay/promotions/draft | not-started | redis |
| netlify/functions/promote-drafts.ts | /.netlify/functions/promote-drafts | /api/promotions/drafts | not-started | |
| netlify/functions/promotion-process.ts | /.netlify/functions/promotion-process | /api/promotions/process | not-started | redis |
| netlify/functions/promotion-status.ts | /.netlify/functions/promotion-status | /api/promotions/status | not-started | |
| netlify/functions/promotion-worker.ts | /.netlify/functions/promotion-worker | /api/promotions/worker | not-started | bg |
| netlify/functions/queue-promotion.ts | /.netlify/functions/queue-promotion | /api/promotions/queue | not-started | |

## Images / Media

| Function file | Old URL | New target URL | Status | Notes |
|---|---|---|---|---|
| netlify/functions/image-proxy.ts | /.netlify/functions/image-proxy | /api/images/proxy | ported | binary |
| netlify/functions/img.ts | /.netlify/functions/img | /api/img | ported | binary |
| netlify/functions/verify-image.ts | /.netlify/functions/verify-image | /api/images/verify | ported | |
| netlify/functions/view-images.ts | /.netlify/functions/view-images | /api/images | ported | |

## Ingestion

| Function file | Old URL | New target URL | Status | Notes |
|---|---|---|---|---|
| netlify/functions/ingest-dropbox-list.ts | /.netlify/functions/ingest-dropbox-list | /api/ingest/dropbox | ported | redis |
| netlify/functions/ingest-local-complete.ts | /.netlify/functions/ingest-local-complete | /api/ingest/local/complete | ported | redis |
| netlify/functions/ingest-local-init.ts | /.netlify/functions/ingest-local-init | /api/ingest/local/init | ported | |
| netlify/functions/ingest-local-upload.ts | /.netlify/functions/ingest-local-upload | /api/ingest/local/upload | ported | upload |

## Pricing

| Function file | Old URL | New target URL | Status | Notes |
|---|---|---|---|---|
| netlify/functions/reprice.ts | /.netlify/functions/reprice | /api/pricing/reprice | ported | |
| netlify/functions/debug-price.ts | /.netlify/functions/debug-price | /api/debug/price | not-started | |
| netlify/functions/price-reduction-list.ts | /.netlify/functions/price-reduction-list | /api/pricing/reductions | ported | auth |
| netlify/functions/price-reduction-update.ts | /.netlify/functions/price-reduction-update | /api/pricing/reductions | ported | auth |
| netlify/functions/price-tick.ts | /.netlify/functions/price-tick | /api/pricing/tick | ported | |

## SmartDrafts

| Function file | Old URL | New target URL | Status | Notes |
|---|---|---|---|---|
| netlify/functions/smartdrafts-analyze.ts | /.netlify/functions/smartdrafts-analyze | /api/smartdrafts/analyze | ported | |
| netlify/functions/smartdrafts-create-drafts.ts | /.netlify/functions/smartdrafts-create-drafts | /api/smartdrafts/create-drafts | ported | auth |
| netlify/functions/smartdrafts-create-drafts-bg.ts | /.netlify/functions/smartdrafts-create-drafts-bg | /api/smartdrafts/create-drafts/start | ported | auth, redis, bg |
| netlify/functions/smartdrafts-create-drafts-background.ts | /.netlify/functions/smartdrafts-create-drafts-background | /api/smartdrafts/create-drafts/worker | not-started | redis, bg |
| netlify/functions/smartdrafts-create-drafts-status.ts | /.netlify/functions/smartdrafts-create-drafts-status | /api/smartdrafts/create-drafts/status | ported | auth, redis |
| netlify/functions/smartdrafts-get-draft.ts | /.netlify/functions/smartdrafts-get-draft | /api/smartdrafts/drafts?offerId= | ported | redis |
| netlify/functions/smartdrafts-pairing-v2-start.ts | /.netlify/functions/smartdrafts-pairing-v2-start | /api/smartdrafts/pairing/v2/start | ported | auth, redis |
| netlify/functions/smartdrafts-pairing-v2-start-from-scan.ts | /.netlify/functions/smartdrafts-pairing-v2-start-from-scan | /api/smartdrafts/pairing/v2/start-from-scan | ported | auth, redis |
| netlify/functions/smartdrafts-pairing-v2-start-local.ts | /.netlify/functions/smartdrafts-pairing-v2-start-local | /api/smartdrafts/pairing/v2/start-local | ported | auth |
| netlify/functions/smartdrafts-pairing-v2-status.ts | /.netlify/functions/smartdrafts-pairing-v2-status | /api/smartdrafts/pairing/v2/status | ported | auth, redis |
| netlify/functions/smartdrafts-quick-list-pipeline.ts | /.netlify/functions/smartdrafts-quick-list-pipeline | /api/smartdrafts/quick-list | ported | auth |
| netlify/functions/smartdrafts-quick-list-processor.ts | /.netlify/functions/smartdrafts-quick-list-processor | /api/smartdrafts/quick-list/process | not-started | bg |
| netlify/functions/smartdrafts-reset.ts | /.netlify/functions/smartdrafts-reset | /api/smartdrafts/reset | ported | auth, redis |
| netlify/functions/smartdrafts-save-drafts.ts | /.netlify/functions/smartdrafts-save-drafts | /api/smartdrafts/drafts | ported | auth, redis |
| netlify/functions/smartdrafts-scan.ts | /.netlify/functions/smartdrafts-scan | /api/smartdrafts/scan | ported | auth |
| netlify/functions/smartdrafts-scan-bg.ts | /.netlify/functions/smartdrafts-scan-bg | /api/smartdrafts/scan/start | ported | auth, redis, bg |
| netlify/functions/smartdrafts-scan-background.ts | /.netlify/functions/smartdrafts-scan-background | /api/smartdrafts/scan/worker | not-started | redis, bg |
| netlify/functions/smartdrafts-scan-status.ts | /.netlify/functions/smartdrafts-scan-status | /api/smartdrafts/scan/status | ported | auth, redis |
| netlify/functions/smartdrafts-update-draft.ts | /.netlify/functions/smartdrafts-update-draft | /api/smartdrafts/drafts/:id | ported | redis |
| netlify/functions/pairing-v2-processor-background.ts | /.netlify/functions/pairing-v2-processor-background | /api/smartdrafts/pairing/v2/process | not-started | redis, bg |

## Status / Config / Misc

| Function file | Old URL | New target URL | Status | Notes |
|---|---|---|---|---|
| netlify/functions/cdn-auth0-spa.ts | /.netlify/functions/cdn-auth0-spa | /api/cdn/auth0-spa | ported | |
| netlify/functions/get-public-config.ts | /.netlify/functions/get-public-config | /api/config | ported | |
| netlify/functions/process.ts | /.netlify/functions/process | /api/process | not-started | redis |
| netlify/functions/status.ts | /.netlify/functions/status | /api/status | ported | redis, auth |

## User Settings

| Function file | Old URL | New target URL | Status | Notes |
|---|---|---|---|---|
| netlify/functions/user-settings-get.ts | /.netlify/functions/user-settings-get | /api/settings | ported | redis, auth |
| netlify/functions/user-settings-save.ts | /.netlify/functions/user-settings-save | /api/settings | ported | redis, auth |

---

## Summary (auto-update me manually)

| Status | Count |
|---|---|
| ported | 20 |
| stubbed | 0 |
| not-started | 125 |
| **Total** | **145** |

<!-- 145 functions total -->
