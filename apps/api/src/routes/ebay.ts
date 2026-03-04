/**
 * ebay.ts — Express routes for eBay offer/listing operations.
 *
 * Mounts under /api/ebay  (registered in routes/index.ts)
 *
 * Mirrors the JSON contracts of these Netlify functions:
 *   GET    /api/ebay/offers/:offerId   ← /.netlify/functions/ebay-get-offer
 *   GET    /api/ebay/offers            ← /.netlify/functions/ebay-list-offers
 *   DELETE /api/ebay/offers/:offerId   ← /.netlify/functions/ebay-delete-offer
 *   POST   /api/ebay/offers/:offerId/publish
 *                                      ← /.netlify/functions/ebay-publish-offer
 *   POST   /api/ebay/listings/end      ← /.netlify/functions/ebay-end-listing
 */

import { Router } from 'express';
import { requireUserAuth } from '../../../../src/lib/auth-user.js';
import {
  getOffer,
  listOffers,
  deleteOffer,
  publishOffer,
  EbayApiError,
  EbayPublishError,
} from '../../../../src/services/ebay-offers.service.js';
import { endListing } from '../../../../src/services/ebay-listings.service.js';
import { getInventoryItem } from '../../../../src/services/ebay-inventory.service.js';
import { getCategorySuggestions } from '../../../../src/services/ebay-taxonomy.service.js';
import { getActiveItem } from '../../../../src/services/ebay-active-item.service.js';
import {
  listLocations,
  getUserLocation,
  setUserLocation,
  EbayApiError as EbayLocApiError,
} from '../../../../packages/core/src/services/ebay/locations.js';
import { listActiveListings } from '../../../../packages/core/src/services/ebay/active-trading.js';
import {
  updateActiveListing,
  UpdateListingError,
} from '../../../../packages/core/src/services/ebay/update-listing.js';
import {
  getOfferThumbnail,
  OfferThumbAuthError,
  OfferThumbUpstreamError,
} from '../../../../packages/core/src/services/ebay/offer-thumb.service.js';
import { EbayNotConnectedError } from '../../../../src/lib/ebay-client.js';
import { missingField } from '../http/validate.js';
import { badRequest, serverError } from '../http/respond.js';
import {
  listPolicies,
  getPolicy,
  createPolicy,
  deletePolicy,
  getPolicyDefaults,
  setPolicyDefault,
  PolicyApiError,
  PolicyValidationError,
  PolicyNotConnectedError,
} from '../../../../packages/core/src/services/ebay/policies.service.js';
import { listCampaigns, CampaignsNotConnectedError, CampaignsApiError } from '../../../../packages/core/src/services/ebay/campaigns.service.js';
import { getMarketingDefaults, setMarketingDefault } from '../../../../packages/core/src/services/ebay/marketing.service.js';
import { checkOptin, OptinNotConnectedError, OptinApiError } from '../../../../packages/core/src/services/ebay/optin.service.js';
import ebayOauthRouter from './ebay-oauth.js';
import { wrapHandler } from '../lib/netlify-adapter.js';

// ---- handler imports (wrapHandler pattern) ----
import { handler as createLocationHandler } from '../handlers/ebay-create-location.js';
import { handler as deleteLocationHandler } from '../handlers/ebay-delete-location.js';
import { handler as enableLocationHandler } from '../handlers/ebay-enable-location.js';
import { handler as ensureLocationHandler } from '../handlers/ebay-ensure-location.js';
import { handler as initLocationHandler } from '../handlers/ebay-init-location-post.js';
import { handler as createDraftHandler } from '../handlers/ebay-create-draft.js';
import { handler as fixDraftAspectsHandler } from '../handlers/ebay-fix-draft-aspects.js';
import { handler as fixInvalidSkusHandler } from '../handlers/ebay-fix-invalid-skus.js';
import { handler as cleanDraftsHandler } from '../handlers/ebay-clean-drafts.js';
import { handler as cleanBrokenDraftsHandler } from '../handlers/ebay-clean-broken-drafts.js';
import { handler as updatePolicyHandler } from '../handlers/ebay-update-policy.js';
import { handler as ensurePoliciesHandler } from '../handlers/ebay-ensure-policies.js';
import { handler as provisionPoliciesHandler } from '../handlers/ebay-provision-policies.js';
import { handler as setPolicyDefaultsHandler } from '../handlers/ebay-set-policy-defaults.js';
import { handler as policyFulfillmentHandler } from '../handlers/ebay-policy-create-fulfillment.js';
import { handler as categoryBrowseHandler } from '../handlers/ebay-category-browse.js';
import { handler as categoryRequirementsHandler } from '../handlers/ebay-category-requirements.js';
import { handler as categoryTreeHandler } from '../handlers/ebay-category-tree.js';
import { handler as exportCategoriesHandler } from '../handlers/ebay-export-categories.js';
import { handler as fetchAllCategoriesHandler } from '../handlers/ebay-fetch-all-categories.js';
import { handler as fetchCategoriesBulkHandler } from '../handlers/ebay-fetch-categories-bulk.js';
import { handler as fetchCategoryAspectsHandler } from '../handlers/ebay-fetch-category-aspects.js';
import { handler as fetchCategoriesStatusHandler } from '../handlers/ebay-fetch-categories-status.js';
import { handler as cancelCategoryJobsHandler } from '../handlers/ebay-cancel-category-jobs.js';
import { handler as fetchCategoriesBackgroundHandler } from '../handlers/ebay-fetch-categories-background.js';
import { handler as taxonomyTreeIdHandler } from '../handlers/ebay-taxonomy-tree-id.js';
import { handler as taxonomyAspectsHandler } from '../handlers/ebay-taxonomy-aspects.js';
import { handler as madHandler } from '../handlers/ebay-mad.js';
import { handler as removePromoHandler } from '../handlers/ebay-remove-promo.js';
import { handler as updateActivePromoHandler } from '../handlers/ebay-update-active-promo.js';
import { handler as updateDraftPromoHandler } from '../handlers/ebay-update-draft-promo.js';
import { handler as promoteDraftsHandler } from '../handlers/promote-drafts.js';
import { handler as debugAccountHandler } from '../handlers/ebay-debug-account.js';
import { handler as optinPostHandler } from '../handlers/ebay-optin.js';

const router = Router();

// Mount eBay OAuth sub-router at /oauth
router.use('/oauth', ebayOauthRouter);

// ---------------------------------------------------------------------------
// Error handler helper
// ---------------------------------------------------------------------------

function handleEbayError(res: any, err: unknown): void {
  if (err instanceof EbayNotConnectedError) {
    return void res.status(400).json({ error: err.message });
  }
  if (err instanceof EbayPublishError) {
    return void res.status(err.statusCode).json({
      ok: false,
      error: 'publish failed',
      publish: { status: err.statusCode, detail: err.body },
    });
  }
  if (err instanceof EbayApiError) {
    return void res.status(err.statusCode).json({
      error: `eBay API error ${err.statusCode}`,
      detail: err.body,
    });
  }
  if (err instanceof Error && err.message.toLowerCase().includes('auth')) {
    return void res.status(401).json({ error: 'Unauthorized' });
  }
  return serverError(res, err);
}

// ---------------------------------------------------------------------------
// GET /api/ebay/offers
// Returns a list of eBay offers for the authenticated user.
//
// Query params:
//   sku       — filter by SKU
//   status    — comma-separated offer statuses (e.g. "PUBLISHED,UNPUBLISHED")
//   limit     — max results (default 20, max 200)
//   offset    — pagination offset (default 0)
// ---------------------------------------------------------------------------
router.get('/offers', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization);
    const result = await listOffers(userId, {
      sku: req.query.sku as string | undefined,
      status: req.query.status as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      offset: req.query.offset ? Number(req.query.offset) : undefined,
    });
    return res.status(200).json(result);
  } catch (err) {
    return handleEbayError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/ebay/offers/:offerId
// Fetch a single eBay offer by ID.
// ---------------------------------------------------------------------------
router.get('/offers/:offerId', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization);
    const { offerId } = req.params;
    if (!offerId) return badRequest(res, 'Missing offerId');
    const result = await getOffer(userId, offerId);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return handleEbayError(res, err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/ebay/offers/:offerId
// Delete an eBay offer (remove draft).
//
// Also accepts offerId in the request body for compatibility with frontends
// that send DELETE with a JSON body.
// ---------------------------------------------------------------------------
router.delete('/offers/:offerId', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization);
    const offerId = req.params.offerId || (req.body as any)?.offerId;
    if (!offerId) return badRequest(res, 'Missing offerId');
    const result = await deleteOffer(userId, offerId);
    return res.status(200).json(result);
  } catch (err) {
    return handleEbayError(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/ebay/offers/:offerId/publish
// Publish an eBay offer (make it live).
//
// Body (optional): { condition }
// ---------------------------------------------------------------------------
router.post('/offers/:offerId/publish', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization);
    const offerId = req.params.offerId || (req.body as any)?.offerId;
    if (!offerId) return badRequest(res, 'Missing offerId');
    const condition = (req.body as any)?.condition;
    const result = await publishOffer(userId, offerId, condition);
    return res.status(200).json(result);
  } catch (err) {
    return handleEbayError(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/ebay/listings/end
// End (remove) a live eBay listing.
//
// Body: {
//   itemId?              — required for Trading API path
//   sku?                 — required to also delete inventory item
//   offerId?             — required for Inventory API path
//   isInventoryListing?  — true = Inventory API, false = Trading API (default false)
//   deleteInventoryItem? — also delete inventory item when ending (default true)
//   reason?              — Trading API ending reason (default "NotAvailable")
// }
// ---------------------------------------------------------------------------
router.post('/listings/end', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization);
    const body = (req.body ?? {}) as Record<string, unknown>;

    const isInventoryListing = body.isInventoryListing === true;

    if (isInventoryListing) {
      const err = missingField(body, ['offerId']);
      if (err) return badRequest(res, err);
    } else {
      const err = missingField(body, ['itemId']);
      if (err) return badRequest(res, err);
    }

    const result = await endListing(userId, {
      itemId: body.itemId as string | undefined,
      sku: body.sku as string | undefined,
      offerId: body.offerId as string | undefined,
      isInventoryListing,
      deleteInventoryItem: body.deleteInventoryItem !== false,
      reason: (body.reason as string | undefined) ?? 'NotAvailable',
    });

    return res.status(200).json(result);
  } catch (err) {
    return handleEbayError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/ebay/inventory/:sku
// Fetch a single eBay Inventory item by SKU.
//
// Mirrors: /.netlify/functions/ebay-get-inventory-item?sku=xxx
// ---------------------------------------------------------------------------
router.get('/inventory/:sku', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization);
    const { sku } = req.params;
    if (!sku) return badRequest(res, 'Missing sku');
    const result = await getInventoryItem(userId, sku);
    return res.status(200).json(result);
  } catch (err) {
    return handleEbayError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/ebay/category-suggestions
// Fetch eBay category suggestions for a search query.
//
// Uses application-level OAuth — no user eBay connection required.
// Mirrors: /.netlify/functions/ebay-category-suggestions?q=xxx
//
// Query params:
//   q — search term (required)
// ---------------------------------------------------------------------------
router.get('/category-suggestions', async (req, res) => {
  try {
    const q = (req.query.q as string | undefined)?.trim() ?? '';
    if (!q) return badRequest(res, 'Missing q');
    const result = await getCategorySuggestions(q);
    return res.status(200).json(result);
  } catch (err) {
    return serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/ebay/active-listings/:itemId
// Fetch a live eBay listing by Trading API item ID.
//
// Mirrors: /.netlify/functions/ebay-get-active-item?itemId=xxx
// ---------------------------------------------------------------------------
router.get('/active-listings/:itemId', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization);
    const { itemId } = req.params;
    if (!itemId) return badRequest(res, 'Missing itemId');
    const result = await getActiveItem(userId, itemId);
    return res.status(200).json(result);
  } catch (err) {
    return handleEbayError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/ebay/locations
// List all eBay merchant inventory locations.
//
// Mirrors: /.netlify/functions/ebay-list-locations
// ---------------------------------------------------------------------------
router.get('/locations', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization);
    const locations = await listLocations(userId);
    return res.status(200).json({ ok: true, locations });
  } catch (err) {
    return handleEbayError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/ebay/locations/user
// Retrieve the user's saved preferred merchant location key.
//
// Mirrors: /.netlify/functions/ebay-get-location-user
// ---------------------------------------------------------------------------
router.get('/locations/user', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization);
    const merchantLocationKey = await getUserLocation(userId);
    return res.status(200).json({ ok: true, merchantLocationKey });
  } catch (err) {
    if (err instanceof EbayLocApiError) {
      return res.status(err.statusCode).json({ error: err.message, detail: err.body });
    }
    return handleEbayError(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/ebay/locations/user
// Save the user's preferred merchant location key.
//
// Mirrors: /.netlify/functions/ebay-set-location-user
//
// Body: { merchantLocationKey: string }
// ---------------------------------------------------------------------------
router.post('/locations/user', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const key = (body.merchantLocationKey as string | undefined)?.trim() ?? '';
    if (!key) return badRequest(res, 'merchantLocationKey required');
    await setUserLocation(userId, key);
    return res.status(200).json({ ok: true });
  } catch (err) {
    if (err instanceof EbayLocApiError) {
      return res.status(err.statusCode).json({ error: err.message, detail: err.body });
    }
    return handleEbayError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/ebay/listings/active
// List active eBay listings via the Trading API (GetMyeBaySelling).
//
// Mirrors: /.netlify/functions/ebay-list-active-trading
// ---------------------------------------------------------------------------
router.get('/listings/active', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization);
    const result = await listActiveListings(userId);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return handleEbayError(res, err);
  }
});

// ---------------------------------------------------------------------------
// PUT /api/ebay/listings/:id
// Update an active eBay listing (Inventory API or Trading API path).
//
// Mirrors: /.netlify/functions/ebay-update-active-item
//
// Body: { itemId, sku?, isInventoryListing?, title?, price?, ... }
// ---------------------------------------------------------------------------
router.put('/listings/:id', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization);
    const itemId = req.params.id || (req.body as any)?.itemId;
    if (!itemId) return badRequest(res, 'itemId required');
    const result = await updateActiveListing(userId, { itemId, ...(req.body as object) } as any);
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof UpdateListingError) {
      return res.status(err.statusCode).json({ ok: false, error: err.message, detail: err.detail });
    }
    return handleEbayError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/ebay/offers/:id/thumb
//
// Fetch a thumbnail image for an eBay offer.
// Returns binary image bytes inline (≤4 MB) or { redirect: url } for larger images.
// Returns 204 when no image exists for the offer.
//
// Mirrors: /.netlify/functions/ebay-offer-thumb
//
// Response 200 (binary): image/jpeg | image/png | image/webp bytes
// Response 200 (JSON):   { redirect: string }
// Response 204:          no image available
// Response 401:          eBay not connected
// ---------------------------------------------------------------------------
router.get('/offers/:id/thumb', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization || '');
    const offerId = req.params.id;
    if (!offerId) return badRequest(res, 'offerId required');

    const result = await getOfferThumbnail(userId, offerId);

    if (result.type === 'empty') {
      return res.status(204).send();
    }
    if (result.type === 'redirect') {
      return res.status(200).json({ redirect: result.url });
    }

    // Binary image
    res
      .set('Content-Type', result.contentType)
      .set('Cache-Control', result.cacheControl)
      .send(result.buffer);
  } catch (err) {
    if (err instanceof OfferThumbAuthError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    if (err instanceof OfferThumbUpstreamError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    return handleEbayError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/ebay/policies
//
// List all three eBay business policy types for the authenticated user.
//
// Mirrors: /.netlify/functions/ebay-list-policies
// Response 200: { fulfillment, payment, returns, eligibility }
// ---------------------------------------------------------------------------
router.get('/policies', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization || '');
    const result = await listPolicies(userId);
    res.json({ ok: true, ...result });
  } catch (err: unknown) {
    if (err instanceof PolicyNotConnectedError) return void res.status(400).json({ ok: false, error: err.message });
    handleEbayError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/ebay/policies/defaults
//
// Return saved per-user policy defaults (payment / fulfillment / return IDs).
// NOTE: This MUST be declared before GET /policies/:id to avoid shadowing.
//
// Mirrors: /.netlify/functions/ebay-get-policy-defaults
// Response 200: { ok: true, defaults: { payment?, fulfillment?, return? } }
// ---------------------------------------------------------------------------
router.get('/policies/defaults', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization || '');
    const result = await getPolicyDefaults(userId);
    res.json(result);
  } catch (err: unknown) {
    handleEbayError(res, err);
  }
});

// POST /api/ebay/policies/defaults  — set one default
router.post('/policies/defaults', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization || '');
    const body = req.body as { type?: string; policyId?: string };
    if (!body.type) return void badRequest(res, 'Missing type');
    if (!body.policyId) return void badRequest(res, 'Missing policyId');
    const result = await setPolicyDefault(userId, body.type, body.policyId);
    res.json(result);
  } catch (err: unknown) {
    if (err instanceof PolicyValidationError) return void res.status(400).json({ ok: false, error: err.message });
    handleEbayError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/ebay/policies/:id
//
// Get a specific eBay policy by type and ID.
//
// Mirrors: /.netlify/functions/ebay-get-policy
// Query: ?type=payment|fulfillment|return
// Response 200: { ok: true, policy: { ... } }
// ---------------------------------------------------------------------------
router.get('/policies/:id', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization || '');
    const id = req.params.id;
    const type = (req.query.type as string) || '';
    if (!type) return void badRequest(res, 'Missing type query param (payment|fulfillment|return)');
    const result = await getPolicy(userId, type, id);
    res.json(result);
  } catch (err: unknown) {
    if (err instanceof PolicyValidationError) return void res.status(400).json({ ok: false, error: err.message });
    if (err instanceof PolicyApiError) return void res.status(err.statusCode).json({ ok: false, error: err.message, detail: err.detail });
    if (err instanceof PolicyNotConnectedError) return void res.status(400).json({ ok: false, error: err.message });
    handleEbayError(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/ebay/policies
//
// Create a new eBay business policy.
//
// Mirrors: /.netlify/functions/ebay-create-policy
// Body: { type: 'payment'|'fulfillment'|'return', name: string, ... }
// Response 200: { ok: true, id: string, policy: { ... }, defaults?: { ... } }
// ---------------------------------------------------------------------------
router.post('/policies', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization || '');
    const body = req.body as Record<string, unknown>;
    if (!body?.type) return void badRequest(res, 'Missing type');
    const result = await createPolicy(userId, body);
    res.json(result);
  } catch (err: unknown) {
    if (err instanceof PolicyValidationError) return void res.status(400).json({ ok: false, error: err.message });
    if (err instanceof PolicyApiError) return void res.status(err.statusCode).json({ ok: false, error: err.message, detail: err.detail });
    if (err instanceof PolicyNotConnectedError) return void res.status(400).json({ ok: false, error: err.message });
    handleEbayError(res, err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/ebay/policies/:id
//
// Delete an eBay business policy.
//
// Mirrors: /.netlify/functions/ebay-delete-policy
// Query: ?type=payment|fulfillment|return
// Response 200: { ok: true, deleted: { type, id } }
// ---------------------------------------------------------------------------
router.delete('/policies/:id', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization || '');
    const id = req.params.id;
    const type = (req.query.type as string) || (req.body as any)?.type || '';
    if (!type) return void badRequest(res, 'Missing type param (payment|fulfillment|return)');
    const result = await deletePolicy(userId, type, id);
    res.json(result);
  } catch (err: unknown) {
    if (err instanceof PolicyValidationError) return void res.status(400).json({ ok: false, error: err.message });
    if (err instanceof PolicyApiError) return void res.status(err.statusCode).json({ ok: false, error: err.message, detail: err.detail });
    if (err instanceof PolicyNotConnectedError) return void res.status(400).json({ ok: false, error: err.message });
    handleEbayError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/ebay/campaigns
//
// List eBay Promoted Listings ad campaigns for the authenticated user.
//
// Mirrors: /.netlify/functions/ebay-list-campaigns
// Response 200: { ok: true, defaultPromoCampaignId, campaigns: [...] }
// ---------------------------------------------------------------------------
router.get('/campaigns', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization || '');
    const result = await listCampaigns(userId);
    res.json(result);
  } catch (err: unknown) {
    if (err instanceof CampaignsNotConnectedError) return void res.status(400).json({ ok: false, error: err.message });
    if (err instanceof CampaignsApiError) return void res.status(err.statusCode).json({ ok: false, error: err.message });
    handleEbayError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/ebay/marketing/defaults
//
// Return the user's saved marketing preferences (default promo campaign).
//
// Mirrors: /.netlify/functions/ebay-get-marketing-defaults
// Response 200: { ok: true, defaults: { defaultPromoCampaignId } }
// ---------------------------------------------------------------------------
router.get('/marketing/defaults', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization || '');
    const result = await getMarketingDefaults(userId);
    res.json(result);
  } catch (err: unknown) {
    handleEbayError(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/ebay/marketing/defaults
//
// Save the user's default promo campaign preference.
//
// Mirrors: /.netlify/functions/ebay-set-marketing-default
// Body: { defaultPromoCampaignId: string | null }
// Response 200: { ok: true, defaultPromoCampaignId }
// ---------------------------------------------------------------------------
router.post('/marketing/defaults', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization || '');
    const body = req.body as { defaultPromoCampaignId?: string | null };
    const id = body?.defaultPromoCampaignId ?? null;
    const result = await setMarketingDefault(userId, typeof id === 'string' ? id : null);
    res.json(result);
  } catch (err: unknown) {
    handleEbayError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/ebay/optin
//
// Check whether the seller is opted into eBay Business Policies.
//
// Mirrors: /.netlify/functions/ebay-check-optin
// Response 200: { ok: true, optedIn: boolean, status?, programs? }
// ---------------------------------------------------------------------------
router.get('/optin', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization || '');
    const result = await checkOptin(userId);
    res.json(result);
  } catch (err: unknown) {
    if (err instanceof OptinNotConnectedError) return void res.status(400).json({ ok: false, error: err.message });
    if (err instanceof OptinApiError) return void res.status(err.statusCode).json({ ok: false, error: err.message, detail: err.detail });
    handleEbayError(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /optin — opt in to eBay Business Policies (SELLING_POLICY_MANAGEMENT)
// Mirrors: /.netlify/functions/ebay-optin (POST)
// Already has GET /optin above (checkOptin service)
// ---------------------------------------------------------------------------
router.post('/optin', wrapHandler(optinPostHandler));

// ---------------------------------------------------------------------------
// Locations — create, delete, enable, ensure, init
// ---------------------------------------------------------------------------
router.post('/locations/ensure', wrapHandler(ensureLocationHandler));
router.post('/locations/init', wrapHandler(initLocationHandler));
router.post('/locations/:key/enable', wrapHandler(enableLocationHandler));
router.post('/locations/:key', wrapHandler(createLocationHandler));
router.delete('/locations/:key', wrapHandler(deleteLocationHandler));

// ---------------------------------------------------------------------------
// Drafts — create, fix-aspects, fix-skus, clean, clean-broken
// ---------------------------------------------------------------------------
router.post('/drafts/create', wrapHandler(createDraftHandler));
router.post('/drafts/fix-aspects', wrapHandler(fixDraftAspectsHandler));
router.post('/drafts/fix-skus', wrapHandler(fixInvalidSkusHandler));
router.post('/drafts/clean', wrapHandler(cleanDraftsHandler));
router.get('/drafts/clean', wrapHandler(cleanDraftsHandler)); // also accepts GET ?sku=
router.post('/drafts/clean-broken', wrapHandler(cleanBrokenDraftsHandler));

// ---------------------------------------------------------------------------
// Policies — update, ensure, provision, set-defaults, fulfillment
// ---------------------------------------------------------------------------
router.put('/policies/update', wrapHandler(updatePolicyHandler));
router.post('/policies/ensure', wrapHandler(ensurePoliciesHandler));
router.post('/policies/provision', wrapHandler(provisionPoliciesHandler));
router.post('/policies/set-defaults', wrapHandler(setPolicyDefaultsHandler));
router.post('/policies/fulfillment', wrapHandler(policyFulfillmentHandler));

// ---------------------------------------------------------------------------
// Category browsing, fetching, background processing
// ---------------------------------------------------------------------------
router.get('/categories/browse', wrapHandler(categoryBrowseHandler));
router.get('/categories/requirements', wrapHandler(categoryRequirementsHandler));
router.get('/categories/tree', wrapHandler(categoryTreeHandler));
router.get('/categories/export', wrapHandler(exportCategoriesHandler));
router.post('/categories/fetch-all', wrapHandler(fetchAllCategoriesHandler));
router.post('/categories/fetch-bulk', wrapHandler(fetchCategoriesBulkHandler));
router.post('/categories/fetch-aspects', wrapHandler(fetchCategoryAspectsHandler));
router.get('/categories/fetch-status', wrapHandler(fetchCategoriesStatusHandler));
router.post('/categories/cancel', wrapHandler(cancelCategoryJobsHandler));
router.post('/categories/background', wrapHandler(fetchCategoriesBackgroundHandler));

// ---------------------------------------------------------------------------
// Taxonomy — tree-id, aspects
// ---------------------------------------------------------------------------
router.get('/taxonomy/tree-id', wrapHandler(taxonomyTreeIdHandler));
router.get('/taxonomy/aspects', wrapHandler(taxonomyAspectsHandler));

// ---------------------------------------------------------------------------
// MAD (Marketplace Account Deletion) webhook — GET challenge, POST notify,
// HEAD/OPTIONS connectivity checks.
// Mirrors: /.netlify/functions/ebay-mad
// ---------------------------------------------------------------------------
router.all('/mad', wrapHandler(madHandler));

// ---------------------------------------------------------------------------
// Promotions
// ---------------------------------------------------------------------------
router.post('/promotions/remove', wrapHandler(removePromoHandler));
router.post('/promotions/active', wrapHandler(updateActivePromoHandler));
router.post('/promotions/draft', wrapHandler(updateDraftPromoHandler));
router.post('/promotions/promote-drafts', wrapHandler(promoteDraftsHandler));

// ---------------------------------------------------------------------------
// Debug
// GET /api/ebay/debug/account — smoke-tests eBay credentials
// ---------------------------------------------------------------------------
router.get('/debug/account', wrapHandler(debugAccountHandler));

export default router;
