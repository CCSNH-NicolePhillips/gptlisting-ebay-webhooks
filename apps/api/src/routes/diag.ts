/**
 * diag.ts — Express routes for diagnostics / health-check endpoints.
 *
 * Mounts under /api/diag  (registered in routes/index.ts)
 *
 * Mirrors Netlify functions:
 *   GET /api/diag/env              ← diag-env.ts
 *   GET /api/diag/clip             ← diag-clip.ts
 *   GET /api/diag/offer            ← diag-offer.ts
 *   GET /api/diag/offers           ← diag-offers.ts
 *   GET /api/diag/payments-program ← diag-payments-program.ts
 *   GET /api/diag/privileges       ← diag-privileges.ts
 *   GET /api/diag/whoami           ← diag-whoami.ts
 *   GET /api/debug/price           ← debug-price.ts  (mounted in index at /debug)
 */

import { Router } from 'express';
import { requireUserAuth } from '../../../../src/lib/auth-user.js';
import { getUserAccessToken, apiHost, headers as ebayHeaders } from '../../../../src/lib/_ebay.js';
import { resolveEbayEnv } from '../../../../src/lib/_common.js';
import { lookupPrice } from '../../../../src/lib/price-lookup.js';
import { getCachedPrice, deleteCachedPrice, makePriceSig } from '../../../../src/lib/price-cache.js';
import { serverError } from '../http/respond.js';

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/diag/env
// No auth required — returns non-sensitive environment info.
// ---------------------------------------------------------------------------
router.get('/env', (_req, res) => {
  try {
    const EBAY_ENV = resolveEbayEnv(process.env.EBAY_ENV);
    const DEFAULT_MARKETPLACE_ID =
      process.env.DEFAULT_MARKETPLACE_ID || process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';
    const MERCHANT_LOCATION_KEY = process.env.EBAY_MERCHANT_LOCATION_KEY || null;
    const SITE_URL = process.env.URL || process.env.DEPLOY_URL || null;
    res.json({ EBAY_ENV, DEFAULT_MARKETPLACE_ID, MERCHANT_LOCATION_KEY, SITE_URL });
  } catch (err) {
    serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/diag/clip?img=<url>
// No auth required — tests CLIP embedding provider connectivity.
// ---------------------------------------------------------------------------
router.get('/clip', async (req, res) => {
  let info: Record<string, unknown> = {};
  try {
    // Lazy import to avoid hard dep when CLIP is disabled
    const { clipProviderInfo, clipTextEmbedding, clipImageEmbedding, cosine } = await import(
      '../../../../src/lib/clip-client-split.js'
    );
    info = clipProviderInfo() as Record<string, unknown>;
    const img = (req.query.img as string) || 'https://picsum.photos/512';
    const [t, i] = await Promise.all([
      clipTextEmbedding('BrainMD L-Theanine Gummies bottle photo'),
      clipImageEmbedding(img),
    ]);
    res.json({
      ok: !!(t && t.length > 0) && !!(i && i.length > 0),
      ...info,
      textDim: t?.length || 0,
      imgDim: i?.length || 0,
      cosine: t && i ? cosine(t, i) : 0,
    });
  } catch (err: any) {
    res.json({
      ok: false,
      ...info,
      error: err?.message ? String(err.message) : String(err ?? 'clip diag failed'),
    });
  }
});

// ---------------------------------------------------------------------------
// Helper: get eBay token or return 4xx
// ---------------------------------------------------------------------------
async function resolveEbayToken(
  userId: string,
  scopes?: string[],
): Promise<{ token: string; host: string; hdrs: Record<string, string>; marketplaceId: string }> {
  const token = await getUserAccessToken(userId, scopes);
  const host = apiHost();
  const hdrs = ebayHeaders(token);
  const marketplaceId =
    process.env.EBAY_MARKETPLACE_ID || process.env.DEFAULT_MARKETPLACE_ID || 'EBAY_US';
  return { token, host, hdrs, marketplaceId };
}

// ---------------------------------------------------------------------------
// GET /api/diag/offer?offerId=<id>
// User auth required.
// ---------------------------------------------------------------------------
router.get('/offer', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization || '');
    const offerId = ((req.query.offerId as string) || '').trim();
    if (!offerId) return void res.status(400).json({ error: 'Missing offerId' });

    const { host, hdrs } = await resolveEbayToken(userId);
    const url = `${host}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`;
    const r = await fetch(url, { headers: hdrs });
    const txt = await r.text();
    let json: any;
    try {
      json = JSON.parse(txt);
    } catch {
      json = { raw: txt };
    }
    res.status(r.ok ? 200 : r.status).json({
      env: resolveEbayEnv(process.env.EBAY_ENV),
      apiHost: host,
      ok: r.ok,
      status: r.status,
      offer: json,
    });
  } catch (err: any) {
    if (err?.code === 'ebay-not-connected') return void res.status(400).json({ ok: false, error: 'Connect eBay first' });
    if (err?.message?.match(/unauthorized/i)) return void res.status(401).json({ ok: false, error: 'Unauthorized' });
    serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/diag/offers
// User auth required — lists first 20 offers.
// ---------------------------------------------------------------------------
router.get('/offers', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization || '');
    const { host, hdrs } = await resolveEbayToken(userId);
    const url = `${host}/sell/inventory/v1/offer?limit=20`;
    const r = await fetch(url, { headers: hdrs });
    const txt = await r.text();
    let json: any;
    try {
      json = JSON.parse(txt);
    } catch {
      json = { raw: txt };
    }
    const offers = Array.isArray(json?.offers) ? json.offers : [];
    const mapped = offers.map((o: any) => ({
      offerId: o?.offerId,
      sku: o?.sku,
      status: o?.status,
      marketplaceId: o?.marketplaceId,
      modified: o?.lastModifiedDate || o?.lastModifiedTime,
    }));
    res.json({ env: resolveEbayEnv(process.env.EBAY_ENV), offers: mapped });
  } catch (err: any) {
    if (err?.code === 'ebay-not-connected') return void res.status(400).json({ ok: false, error: 'Connect eBay first' });
    if (err?.message?.match(/unauthorized/i)) return void res.status(401).json({ ok: false, error: 'Unauthorized' });
    serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/diag/payments-program
// User auth required — checks eBay Managed Payments enrolment.
// ---------------------------------------------------------------------------
router.get('/payments-program', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization || '');
    const { host, hdrs, marketplaceId } = await resolveEbayToken(userId);
    const attempts: any[] = [];

    async function tryUrl(path: string) {
      const r = await fetch(`${host}${path}`, { headers: hdrs });
      const txt = await r.text();
      let json: any;
      try {
        json = JSON.parse(txt);
      } catch {
        json = { raw: txt };
      }
      attempts.push({ path, status: r.status, ok: r.ok, body: json });
      return { ok: r.ok, status: r.status, body: json };
    }

    const options = [
      `/sell/account/v1/payments_program?marketplace_id=${encodeURIComponent(marketplaceId)}&program_type=EBAY_PAYMENTS`,
      `/sell/account/v1/payments_program/EBAY_PAYMENTS?marketplace_id=${encodeURIComponent(marketplaceId)}`,
    ];
    let best: any = null;
    for (const p of options) {
      const r2 = await tryUrl(p);
      if (r2.ok) {
        best = r2;
        break;
      }
    }
    res.json({
      env: resolveEbayEnv(process.env.EBAY_ENV),
      apiHost: host,
      marketplaceId,
      result: best,
      attempts,
    });
  } catch (err: any) {
    if (err?.code === 'ebay-not-connected') return void res.status(400).json({ ok: false, error: 'Connect eBay first' });
    serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/diag/privileges
// User auth required — checks seller account privileges.
// ---------------------------------------------------------------------------
router.get('/privileges', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization || '');
    const { host, hdrs } = await resolveEbayToken(userId);
    const url = `${host}/sell/account/v1/privilege`;
    const r = await fetch(url, { headers: hdrs });
    const txt = await r.text();
    let json: any;
    try {
      json = JSON.parse(txt);
    } catch {
      json = { raw: txt };
    }
    res.json({
      env: resolveEbayEnv(process.env.EBAY_ENV),
      apiHost: host,
      ok: r.ok,
      status: r.status,
      body: json,
    });
  } catch (err: any) {
    if (err?.code === 'ebay-not-connected') return void res.status(400).json({ ok: false, error: 'Connect eBay first' });
    serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/diag/whoami
// User auth required — uses fulfillment policy list as a connectivity sanity check.
// ---------------------------------------------------------------------------
router.get('/whoami', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization || '');
    const scopes = [
      'https://api.ebay.com/oauth/api_scope',
      'https://api.ebay.com/oauth/api_scope/sell.account',
    ];
    const { host, hdrs, marketplaceId } = await resolveEbayToken(userId, scopes);
    const url = `${host}/sell/account/v1/fulfillment_policy?marketplace_id=${encodeURIComponent(marketplaceId)}`;
    const r = await fetch(url, { headers: hdrs });
    const txt = await r.text();
    let json: any;
    try {
      json = JSON.parse(txt);
    } catch {
      json = { raw: txt };
    }
    const count = Array.isArray(json?.fulfillmentPolicies)
      ? json.fulfillmentPolicies.length
      : Number(json?.total) || 0;
    const samplePolicy = Array.isArray(json?.fulfillmentPolicies)
      ? json.fulfillmentPolicies[0]
      : null;
    const www = r.headers.get('www-authenticate') || '';
    res.json({
      env: resolveEbayEnv(process.env.EBAY_ENV),
      apiHost: host,
      marketplaceId,
      ok: r.ok,
      status: r.status,
      count,
      samplePolicy,
      wwwAuthenticate: www,
    });
  } catch (err: any) {
    if (err?.code === 'ebay-not-connected') return void res.status(400).json({ ok: false, error: 'Connect eBay first' });
    serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/diag/debug-price?brand=&title=&skipCache=&clearCache=
// No auth required — tests pricing lookup pipeline.
// ---------------------------------------------------------------------------
router.get('/debug-price', async (req, res) => {
  try {
    const brand = (req.query.brand as string) || '';
    const title = (req.query.title as string) || '';
    const skipCache = req.query.skipCache === 'true';
    const clearCache = req.query.clearCache === 'true';
    const netWeightValue = req.query.netWeightValue ? parseFloat(req.query.netWeightValue as string) : undefined;
    const netWeightUnit = req.query.netWeightUnit as string | undefined;

    if (!brand || !title) {
      return void res.status(400).json({
        error: 'Missing required params: brand and title',
        example: '?brand=Cymbiotika&title=Liposomal%20Magnesium%20Complex&skipCache=true',
      });
    }

    const sig = makePriceSig(brand, title);

    if (clearCache) {
      const deleted = await deleteCachedPrice(sig);
      console.log(`[debug-price] Cache clear for "${sig}": ${deleted}`);
    }

    const netWeight =
      netWeightValue && netWeightUnit
        ? { value: netWeightValue, unit: netWeightUnit }
        : undefined;

    const result = await lookupPrice({ brand, title, skipCache, netWeight: netWeight as any });

    res.json({
      input: { brand, title, skipCache, netWeight },
      cacheSig: sig,
      result: {
        ok: result.ok,
        chosen: result.chosen,
        recommendedListingPrice: result.recommendedListingPrice,
        candidates: result.candidates,
        reason: result.reason,
        needsManualReview: result.needsManualReview,
        manualReviewReason: result.manualReviewReason,
      },
    });
  } catch (err: any) {
    serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/diag/price-cache?brand=&title=
// No auth required — returns cached price data for a brand+title without
// triggering a fresh lookup. Used by the flagged-listings debug export.
// ---------------------------------------------------------------------------
router.get('/price-cache', async (req, res) => {
  try {
    const brand = ((req.query.brand as string) || '').trim();
    const title = ((req.query.title as string) || '').trim();
    if (!brand || !title) {
      return void res.status(400).json({ ok: false, error: 'brand and title params required' });
    }
    const sig = makePriceSig(brand, title);
    const cached = await getCachedPrice(sig);
    return res.json({
      ok: true,
      sig,
      found: !!cached,
      cached,
      debugUrl: `/api/diag/debug-price?brand=${encodeURIComponent(brand)}&title=${encodeURIComponent(title)}`,
    });
  } catch (err: any) {
    serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/diag/price-cache?brand=&title=
// Deletes a stale cached price entry so the next pricing run fetches fresh data.
// ---------------------------------------------------------------------------
router.delete('/price-cache', async (req, res) => {
  try {
    const brand = ((req.query.brand as string) || '').trim();
    const title = ((req.query.title as string) || '').trim();
    if (!brand || !title) {
      return void res.status(400).json({ ok: false, error: 'brand and title params required' });
    }
    const sig = makePriceSig(brand, title);
    const deleted = await deleteCachedPrice(sig);
    console.log(`[diag] price-cache DELETE: sig="${sig}" deleted=${deleted}`);
    return res.json({ ok: true, sig, deleted });
  } catch (err: any) {
    serverError(res, err);
  }
});

export default router;
