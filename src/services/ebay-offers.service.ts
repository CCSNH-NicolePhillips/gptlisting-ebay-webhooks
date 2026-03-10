/**
 * ebay-offers.service.ts — Platform-agnostic service for eBay Inventory offer operations.
 *
 * Mirrors the business logic previously inlined in:
 *   netlify/functions/ebay-get-offer.ts
 *   netlify/functions/ebay-list-offers.ts
 *   netlify/functions/ebay-delete-offer.ts
 *   netlify/functions/ebay-publish-offer.ts
 *
 * No HTTP framework dependencies — callers (Express routes, Netlify functions)
 * translate the returned objects into HTTP responses.
 */

import { getEbayClient } from '../lib/ebay-client.js';
import { tokensStore } from '../lib/redis-store.js';
import { userScopedKey } from '../lib/_auth.js';
import {
  getPromotionIntent,
  deletePromotionIntent,
  queuePromotionJob,
  batchGetPromotionIntents,
} from '../lib/promotion-queue.js';
import { bindListing } from '../lib/price-store.js';

// ---------------------------------------------------------------------------
// getOffer
// ---------------------------------------------------------------------------

export interface GetOfferResult {
  offer: unknown;
}

/**
 * Fetch a single eBay offer by ID.
 * @throws {EbayNotConnectedError} if user has no eBay credentials.
 * @throws on non-2xx eBay API responses (includes the upstream status + body).
 */
export async function getOffer(
  userId: string,
  offerId: string,
): Promise<GetOfferResult> {
  const { apiHost, headers } = await getEbayClient(userId);

  const url = `${apiHost}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`;
  const res = await fetch(url, { headers });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }

  if (!res.ok) {
    const err = new EbayApiError(res.status, body);
    throw err;
  }

  return { offer: body };
}

// ---------------------------------------------------------------------------
// listOffers
// ---------------------------------------------------------------------------

export interface ListOffersParams {
  sku?: string;
  status?: string;   // comma-separated statuses e.g. "PUBLISHED,UNPUBLISHED"
  limit?: number;
  offset?: number;
}

export interface ListOffersResult {
  ok: true;
  total: number;
  offers: unknown[];
  /** Diagnostics — forwarded from eBay or our own retry chain */
  attempts?: unknown[];
  note?: string;
  partial?: boolean;
  elapsed?: number;
}

/**
 * Regex allowing only safe eBay SKU characters.
 * Mirrors the Netlify function's `SKU_OK` guard.
 */
const SKU_SAFE = /^[a-zA-Z0-9_\-:.]+$/;
const skuOk = (s: string) => s.length > 0 && SKU_SAFE.test(s);

/**
 * List eBay offers with optional status/SKU filtering and automatic
 * fallback strategies (mirrors the Netlify function's retry logic).
 */
export async function listOffers(
  userId: string,
  params: ListOffersParams = {},
): Promise<ListOffersResult> {
  const startTime = Date.now();
  const { apiHost, headers } = await getEbayClient(userId);

  const limit = Math.min(Math.max(params.limit ?? 20, 1), 200);
  const offset = Math.max(params.offset ?? 0, 0);
  const rawSku = params.sku ?? '';
  const sku = skuOk(rawSku) ? rawSku : '';
  const status = params.status ?? '';

  const attempts: unknown[] = [];

  // Helper: single eBay API call
  async function listOnce(
    withStatus = false,
    withMarketplace = true,
    overrideStatus?: string,
  ) {
    const p = new URLSearchParams();
    if (sku) p.set('sku', sku);
    if (withStatus && (overrideStatus || status)) {
      p.set('offer_status', overrideStatus ?? status ?? '');
    }
    if (withMarketplace) p.set('marketplace_id', 'EBAY_US');
    p.set('limit', String(limit));
    p.set('offset', String(offset));
    const url = `${apiHost}/sell/inventory/v1/offer?${p.toString()}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const r = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timer);
      const txt = await r.text();
      let body: any;
      try {
        body = JSON.parse(txt);
      } catch {
        body = { raw: txt };
      }
      return { ok: r.ok, status: r.status, url, body };
    } catch (err: any) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        return { ok: false, status: 504, url, body: { error: 'eBay API timeout' } };
      }
      throw err;
    }
  }

  /** Enumerate inventory items and fetch per-SKU (safe fallback). */
  async function safeAggregateByInventory(): Promise<{
    offers: any[];
    attempts: any[];
  }> {
    const agg: any[] = [];
    const agg_attempts: any[] = [];
    const allowStatuses = status
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    const fallbackStart = Date.now();
    const isRailway = process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID;
    const HARD_LIMIT_MS = isRailway ? 25_000 : 7_000;
    const pageLimit = Math.min(Math.max(limit, 20), 200);

    for (let page = 0; page < 10 && agg.length < limit; page++) {
      if (Date.now() - fallbackStart > HARD_LIMIT_MS) break;
      const invParams = new URLSearchParams({
        limit: String(pageLimit),
        offset: String(page * pageLimit),
      });
      const invUrl = `${apiHost}/sell/inventory/v1/inventory_item?${invParams}`;
      const invRes = await fetch(invUrl, { headers });
      const invTxt = await invRes.text();
      let invJson: any;
      try {
        invJson = JSON.parse(invTxt);
      } catch {
        invJson = { raw: invTxt };
      }
      agg_attempts.push({ url: invUrl, status: invRes.status, body: invJson });
      if (!invRes.ok) break;
      const items: any[] = Array.isArray(invJson?.inventoryItems)
        ? invJson.inventoryItems
        : [];
      if (!items.length) break;

      for (const it of items) {
        const s = String(it?.sku ?? '');
        if (!skuOk(s)) continue;
        const p = new URLSearchParams({ sku: s, limit: '50' });
        const offerUrl = `${apiHost}/sell/inventory/v1/offer?${p}`;
        const r = await fetch(offerUrl, { headers });
        const t = await r.text();
        let j: any;
        try {
          j = JSON.parse(t);
        } catch {
          j = { raw: t };
        }
        agg_attempts.push({ url: offerUrl, status: r.status, body: j });
        if (!r.ok) continue;
        const arr: any[] = Array.isArray(j?.offers) ? j.offers : [];
        for (const o of arr) {
          const st = String(o?.status ?? '').toUpperCase();
          if (!allowStatuses.length || allowStatuses.includes(st)) {
            agg.push(o);
          }
        }
        if (agg.length >= limit) break;
      }
    }
    return { offers: agg.slice(0, limit), attempts: agg_attempts };
  }

  const getOffers = (body: any): any[] =>
    Array.isArray(body?.offers) ? body.offers : [];

  // ── Normalised status list ──────────────────────────────────────────────
  const normalizedStatuses = status
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // ── Fast path: single call + client-side filter ─────────────────────────
  if (normalizedStatuses.length > 0) {
    const r = await listOnce(false, true);
    attempts.push(r);

    // 25707 = invalid SKU; 25702 = no offers for seller; any other eBay 400 → safe aggregation
    if (!r.ok) {
      if (r.status === 400) {
        const safe = await safeAggregateByInventory();
        const partial = Date.now() - startTime > 6_500;
        return {
          ok: true,
          partial,
          total: safe.offers.length,
          offers: safe.offers,
          attempts: [...attempts, ...safe.attempts],
          note: safe.offers.length ? 'safe-aggregate' : 'safe-aggregate-empty',
        };
      }
    }

    if (r.ok) {
      const allOffers = getOffers(r.body);
      const allowStatuses = normalizedStatuses.map((s) => s.toUpperCase());
      const filtered = allOffers.filter((o: any) =>
        allowStatuses.includes(String(o?.status ?? '').toUpperCase()),
      );

      if (filtered.length > 0) {
        await Promise.all([
          enrichWithInventoryData(filtered, apiHost, headers),
          enrichWithPromotionIntent(filtered),
        ]);
        return {
          ok: true,
          total: filtered.length,
          offers: filtered.slice(0, limit),
          attempts,
          elapsed: Date.now() - startTime,
        };
      }
    }
  }

  // ── Fallback: per-status aggregation ────────────────────────────────────
  if (normalizedStatuses.length > 1) {
    const agg: any[] = [];
    for (const st of normalizedStatuses) {
      const r = await listOnce(true, true, st);
      attempts.push(r);
      if (r.ok) agg.push(...getOffers(r.body));
    }
    if (agg.length > 0) {
      const seen = new Set<string>();
      const unique = agg.filter((o: any) => {
        const id = String(o?.offerId ?? '');
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      return {
        ok: true,
        total: unique.length,
        offers: unique,
        attempts,
        elapsed: Date.now() - startTime,
      };
    }
  }

  // ── Simple single-status or no-status call ───────────────────────────────
  let res = await listOnce(Boolean(status), true);
  attempts.push(res);

  if (!res.ok && status) {
    res = await listOnce(false, true);
    attempts.push(res);
  }
  if (!res.ok) {
    res = await listOnce(Boolean(status), false);
    attempts.push(res);
  }

  if (!res.ok) {
    if (res.status === 400) {
      // Any eBay 400 (no offers, invalid SKU, etc.) → safe aggregate or empty
      const safe = await safeAggregateByInventory();
      return {
        ok: true,
        total: safe.offers.length,
        offers: safe.offers,
        attempts: [...attempts, ...safe.attempts],
        note: safe.offers.length ? 'safe-aggregate' : 'safe-aggregate-empty',
      };
    }
    throw new EbayApiError(res.status, res.body);
  }

  let offers = getOffers(res.body);

  // Broaden if empty
  if (offers.length === 0) {
    for (const fn of [
      () => listOnce(false, true),
      () => listOnce(Boolean(status), false),
      () => listOnce(false, false),
    ]) {
      const r = await fn();
      attempts.push(r);
      if (r.ok && getOffers(r.body).length) {
        offers = getOffers(r.body);
        break;
      }
    }
    if (offers.length === 0) {
      const safe = await safeAggregateByInventory();
      return {
        ok: true,
        total: safe.offers.length,
        offers: safe.offers,
        attempts: [...attempts, ...safe.attempts],
      };
    }
  }

  const final = status
    ? offers.filter(
        (o: any) =>
          String(o?.status ?? '').toUpperCase() === status.toUpperCase(),
      )
    : offers;

  await Promise.all([
    final.length > 0 && final.length <= 50
      ? enrichWithInventoryData(final, apiHost, headers)
      : Promise.resolve(),
    enrichWithPromotionIntent(final),
  ]);

  const note =
    rawSku && !sku ? 'sku filter ignored due to invalid characters' : undefined;

  return {
    ok: true,
    total: final.length,
    offers: final,
    attempts,
    note,
    elapsed: Date.now() - startTime,
  };
}

// ---------------------------------------------------------------------------
// deleteOffer
// ---------------------------------------------------------------------------

export interface DeleteOfferResult {
  ok: true;
  deleted: string;
}

/**
 * Delete an eBay offer (removes the listing draft).
 */
export async function deleteOffer(
  userId: string,
  offerId: string,
): Promise<DeleteOfferResult> {
  const { apiHost, headers } = await getEbayClient(userId);
  const url = `${apiHost}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`;
  const res = await fetch(url, { method: 'DELETE', headers });

  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
    throw new EbayApiError(res.status, body);
  }

  return { ok: true, deleted: offerId };
}

// ---------------------------------------------------------------------------
// publishOffer
// ---------------------------------------------------------------------------

export interface PublishOfferResult {
  ok: true;
  result: unknown;
  promotion: unknown;
  autoPrice: unknown;
}

/**
 * Publish an eBay offer (make it live).
 *
 * Includes automatic error recovery:
 *  - 25020: missing package weight → patches to 16 oz default, retries
 *  - 25021: invalid condition     → patches offer condition, retries
 *  - 25015: image URL too long    → converts S3 presigned URLs to short redirects, retries
 *
 * Post-publish side-effects:
 *  - Records the offer in `published.json` Redis key
 *  - Checks for promotion intent in Redis → queues promotion job
 *  - Checks user settings for auto-price reduction → creates price binding
 */
export async function publishOffer(
  userId: string,
  offerId: string,
  conditionRaw?: string | number,
): Promise<PublishOfferResult> {
  const { access_token, apiHost, headers } = await getEbayClient(userId);
  const store = tokensStore();
  const publishUrl = `${apiHost}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`;

  // -- Helper: one publish attempt ----------------------------------------
  async function publishOnce() {
    const r = await fetch(publishUrl, { method: 'POST', headers });
    const txt = await r.text();
    let body: any;
    try {
      body = JSON.parse(txt);
    } catch {
      body = { raw: txt };
    }
    return { ok: r.ok, status: r.status, url: publishUrl, body };
  }

  // -- Pre-publish: apply per-price fulfillment policy if configured --------
  // If the user has both a paid (fulfillment) and free (fulfillmentFree) policy
  // set in their policy defaults, check the offer's price and ensure the correct
  // policy is attached before publishing (handles drafts created before the
  // free shipping policy was configured).
  try {
    const policyKey = userScopedKey(userId, 'policy-defaults.json');
    const policyDefaults = await store.get(policyKey, { type: 'json' }) as any;

    if (policyDefaults?.fulfillment && policyDefaults?.fulfillmentFree) {
      const getOfferUrl = `${apiHost}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`;
      const getRes = await fetch(getOfferUrl, { headers });
      if (getRes.ok) {
        const offer: any = await getRes.json();
        const offerPrice = parseFloat(offer?.pricingSummary?.price?.value ?? '0');
        const correctPolicyId = offerPrice < 50
          ? policyDefaults.fulfillmentFree
          : policyDefaults.fulfillment;
        const currentPolicyId = offer?.listingPolicies?.fulfillmentPolicyId;

        if (currentPolicyId !== correctPolicyId) {
          console.log(`[publishOffer] Correcting fulfillmentPolicyId: ${currentPolicyId} → ${correctPolicyId} (price=$${offerPrice.toFixed(2)})`);
          const updated = {
            ...offer,
            listingPolicies: {
              ...offer.listingPolicies,
              fulfillmentPolicyId: correctPolicyId,
            },
          };
          const putRes = await fetch(getOfferUrl, {
            method: 'PUT',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify(updated),
          });
          if (!putRes.ok) {
            const putTxt = await putRes.text().catch(() => '');
            console.warn(`[publishOffer] Failed to update fulfillmentPolicyId (non-fatal): ${putRes.status} ${putTxt.slice(0, 200)}`);
          }
        } else {
          console.log(`[publishOffer] fulfillmentPolicyId already correct (${currentPolicyId}, price=$${offerPrice.toFixed(2)})`);
        }
      }
    }
  } catch (policyErr: any) {
    // Non-fatal: log and continue without blocking publish
    console.warn(`[publishOffer] per-price policy pre-check failed (non-fatal): ${policyErr?.message}`);
  }

  let pub = await publishOnce();
  const errors: any[] = Array.isArray(pub.body?.errors) ? pub.body.errors : [];

  // -- Auto-fix 25020: missing weight -------------------------------------
  if (!pub.ok && errors.some((e: any) => Number(e?.errorId) === 25020)) {
    const offer = pub.body;
    const sku = offer?.sku ?? offer?.offer?.sku;
    if (sku) {
      const invUrl = `${apiHost}/sell/inventory/v1/inventory_item/${encodeURIComponent(String(sku))}`;
      const invRes = await fetch(invUrl, { headers });
      if (invRes.ok) {
        const inv: any = await invRes.json();
        const patched = {
          ...inv,
          packageWeightAndSize: {
            ...(inv.packageWeightAndSize ?? {}),
            weight: { value: 16, unit: 'OUNCE' },
          },
        };
        await fetch(invUrl, {
          method: 'PUT',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(patched),
        });
        pub = await publishOnce();
      }
    }
  }

  // -- Auto-fix 25021: invalid condition ----------------------------------
  if (!pub.ok && errors.some((e: any) => Number(e?.errorId) === 25021)) {
    const getOfferUrl = `${apiHost}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`;
    const getOfferRes = await fetch(getOfferUrl, { headers });
    if (getOfferRes.ok) {
      const offer: any = await getOfferRes.json();
      const condNum = Number(conditionRaw ?? offer?.condition ?? 1000);
      const updated = {
        sku: offer?.sku,
        marketplaceId: offer?.marketplaceId,
        format: offer?.format || 'FIXED_PRICE',
        availableQuantity: offer?.availableQuantity,
        categoryId: offer?.categoryId,
        listingDescription: offer?.listingDescription,
        pricingSummary: offer?.pricingSummary,
        listingPolicies: offer?.listingPolicies,
        merchantLocationKey: offer?.merchantLocationKey,
        condition: Number.isFinite(condNum) ? condNum : 1000,
      };
      const putRes = await fetch(
        `${apiHost}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`,
        {
          method: 'PUT',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(updated),
        },
      );
      if (putRes.ok) pub = await publishOnce();
    }
  }

  // -- Auto-fix 25015: picture URL too long --------------------------------
  if (!pub.ok && (Array.isArray(pub.body?.errors) ? pub.body.errors : []).some((e: any) => Number(e?.errorId) === 25015)) {
    const getOfferUrl = `${apiHost}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`;
    const getOfferRes = await fetch(getOfferUrl, { headers });
    if (getOfferRes.ok) {
      const off: any = await getOfferRes.json();
      const sku = String(off?.sku || off?.offer?.sku || '');
      if (sku) {
        const invUrl = `${apiHost}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`;
        const invRes = await fetch(invUrl, { headers });
        if (invRes.ok) {
          const inv: any = await invRes.json();
          const origUrls: string[] = inv?.product?.imageUrls ?? [];
          const appBase =
            process.env.URL ||
            process.env.DEPLOY_PRIME_URL ||
            'https://gptlisting.netlify.app';
          const shortUrls = origUrls.map((url: string) => {
            try {
              const u = new URL(url);
              if (
                u.hostname.includes('.s3.') ||
                u.hostname.includes('.amazonaws.com')
              ) {
                const key = decodeURIComponent(u.pathname.replace(/^\//, ''));
                if (key.startsWith('staging/')) {
                  return `${appBase}/api/img?k=${encodeURIComponent(key)}`;
                }
              }
            } catch { /* ignore */ }
            return url;
          });
          const didShorten = shortUrls.some((u, i) => u !== origUrls[i]);
          if (didShorten) {
            const patched = {
              sku,
              product: { ...inv.product, imageUrls: shortUrls },
              availability: inv?.availability,
              condition: inv?.condition,
              packageWeightAndSize: inv?.packageWeightAndSize,
            };
            const putRes = await fetch(invUrl, {
              method: 'PUT',
              headers: { ...headers, 'Content-Type': 'application/json' },
              body: JSON.stringify(patched),
            });
            if (putRes.ok) pub = await publishOnce();
          }
        }
      }
    }
  }

  if (!pub.ok) {
    throw new EbayPublishError(pub.status, pub.body);
  }

  // -- Record published in Redis -------------------------------------------
  try {
    const key = userScopedKey(userId, 'published.json');
    const cur = ((await store.get(key, { type: 'json' })) as any) ?? {};
    const stamp = new Date().toISOString();
    let sku: string | undefined;
    try {
      sku = pub.body?.sku ? String(pub.body.sku) : undefined;
    } catch { /* ignore */ }
    cur[String(offerId)] = { offerId: String(offerId), sku, publishedAt: stamp };
    await store.set(key, JSON.stringify(cur));
  } catch { /* ignore persistence errors */ }

  // -- Auto-promotion ------------------------------------------------------
  let promotionResult: any = null;
  try {
    const settingsKey = userScopedKey(userId, 'settings.json');
    let userSettings: any = {};
    try {
      userSettings = (await store.get(settingsKey, { type: 'json' })) ?? {};
    } catch { /* no settings */ }

    const policyKey = userScopedKey(userId, 'policy-defaults.json');
    let policyDefaults: any = {};
    try {
      policyDefaults = (await store.get(policyKey, { type: 'json' })) ?? {};
    } catch { /* no policy-defaults */ }

    const autoPromote =
      userSettings.autoPromoteEnabled === true ||
      policyDefaults.autoPromote === true;
    const defaultAdRate =
      typeof userSettings.defaultPromotionRate === 'number'
        ? userSettings.defaultPromotionRate
        : typeof policyDefaults.defaultAdRate === 'number'
          ? policyDefaults.defaultAdRate
          : 5;

    const getOfferUrl = `${apiHost}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`;
    const getOfferRes = await fetch(getOfferUrl, { headers });

    if (getOfferRes.ok) {
      const offer: any = await getOfferRes.json();
      const offerSku =
        typeof offer?.sku === 'string' ? offer.sku : undefined;
      const itemPrice = offer?.pricingSummary?.price?.value
        ? parseFloat(offer.pricingSummary.price.value)
        : 0;
      const canPromote = itemPrice >= 3.0;

      let usePromotion = autoPromote && canPromote;
      let adRate = defaultAdRate;

      try {
        const intent = await getPromotionIntent(offerId);
        if (intent && intent.enabled) {
          usePromotion = canPromote;
          adRate = intent.adRate;
          await deletePromotionIntent(offerId);
        } else if (intent && !intent.enabled) {
          usePromotion = false;
          await deletePromotionIntent(offerId);
        }
      } catch { /* fall back to user settings */ }

      if (usePromotion) {
        const listingId = pub.body?.listingId || offer.listing?.listingId;
        if (listingId) {
          try {
            const jobId = await queuePromotionJob(userId, listingId, adRate, {
              sku: offerSku,
            });
            promotionResult = {
              queued: true,
              listingId,
              jobId,
              adRate,
              message: 'Promotion queued for background processing',
            };
          } catch (err: any) {
            promotionResult = {
              queued: false,
              listingId,
              error: err.message,
              reason: 'Failed to queue promotion job',
            };
          }
        } else {
          promotionResult = {
            queued: false,
            error: 'listingId not available',
          };
        }
      }
    }
  } catch { /* don't fail the publish */ }

  // -- Auto-price reduction ------------------------------------------------
  let autoPriceResult: any = null;
  try {
    const settingsKey = userScopedKey(userId, 'settings.json');
    let userSettings: any = {};
    try {
      userSettings = (await store.get(settingsKey, { type: 'json' })) ?? {};
    } catch { /* no settings */ }

    const autoPrice = userSettings.autoPrice;
    if (autoPrice?.enabled === true) {
      const getOfferUrl = `${apiHost}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`;
      const getOfferRes = await fetch(getOfferUrl, { headers });
      if (getOfferRes.ok) {
        const offer: any = await getOfferRes.json();
        const offerSku = offer?.sku || offer?.offer?.sku;
        const listingId = pub.body?.listingId || offer?.listing?.listingId;
        const currentPrice = offer?.pricingSummary?.price?.value
          ? parseFloat(offer.pricingSummary.price.value)
          : null;

        if (currentPrice && currentPrice > 0) {
          let calculatedMinPrice: number;
          if (autoPrice.minPriceType === 'percent') {
            calculatedMinPrice = Math.max(
              0.99,
              currentPrice * ((autoPrice.minPercent || 50) / 100),
            );
          } else {
            calculatedMinPrice = (autoPrice.minPrice || 199) / 100;
          }
          const binding = await bindListing({
            jobId: `publish-${Date.now()}`,
            groupId: offerId,
            userId,
            offerId,
            listingId,
            sku: offerSku,
            currentPrice,
            auto: {
              reduceBy: (autoPrice.reduceBy || 100) / 100,
              everyDays: autoPrice.everyDays || 7,
              minPrice: calculatedMinPrice,
            },
          });
          void binding; // used for side-effect only
          autoPriceResult = {
            enabled: true,
            offerId,
            currentPrice,
            reduceBy: (autoPrice.reduceBy || 100) / 100,
            everyDays: autoPrice.everyDays || 7,
            minPrice: calculatedMinPrice,
            minPriceType: autoPrice.minPriceType || 'fixed',
            message: 'Auto price reduction enabled',
          };
        }
      }
    }
  } catch (err: any) {
    autoPriceResult = { enabled: false, error: err.message };
  }

  return { ok: true, result: pub.body, promotion: promotionResult, autoPrice: autoPriceResult };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function enrichWithInventoryData(
  offers: any[],
  apiHost: string,
  headers: Record<string, string>,
): Promise<void> {
  const skuToIndices = new Map<string, number[]>();
  for (let i = 0; i < offers.length; i++) {
    const sku = offers[i]?.sku;
    if (!sku) continue;
    const arr = skuToIndices.get(sku) ?? [];
    arr.push(i);
    skuToIndices.set(sku, arr);
  }

  const uniqueSkus = Array.from(skuToIndices.keys());
  if (!uniqueSkus.length) return;

  const CHUNK_SIZE = 25;
  const chunks: string[][] = [];
  for (let start = 0; start < uniqueSkus.length; start += CHUNK_SIZE) {
    chunks.push(uniqueSkus.slice(start, start + CHUNK_SIZE));
  }

  await Promise.all(
    chunks.map(async (chunk) => {
      try {
        const bulkUrl = `${apiHost}/sell/inventory/v1/bulk_get_inventory_item`;
        const r = await fetch(bulkUrl, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ requests: chunk.map((sku) => ({ sku })) }),
        });
        if (!r.ok) return;
        const json: any = await r.json();
        for (const resp of Array.isArray(json?.responses) ? json.responses : []) {
          if (resp.statusCode !== 200) continue;
          const inv = resp.inventoryItem;
          const indices = skuToIndices.get(resp.sku);
          if (!inv || !indices) continue;
          const title = inv?.product?.title ?? inv?.title;
          const weight = inv?.packageWeightAndSize?.weight;
          const imgArr: string[] = Array.isArray(inv?.product?.imageUrls)
            ? inv.product.imageUrls
            : [];
          for (const idx of indices) {
            if (title) offers[idx]._enrichedTitle = title;
            if (weight?.value > 0) {
              offers[idx]._hasWeight = true;
              offers[idx]._weight = { value: weight.value, unit: weight.unit || 'OUNCE' };
            } else {
              offers[idx]._hasWeight = false;
            }
            if (imgArr.length > 0) offers[idx]._imageUrl = imgArr[0];
          }
        }
      } catch { /* skip chunk */ }
    }),
  );
}

async function enrichWithPromotionIntent(offers: any[]): Promise<void> {
  try {
    const offerIds = offers.map((o: any) => o?.offerId).filter(Boolean) as string[];
    if (!offerIds.length) return;
    const intentMap = await batchGetPromotionIntents(offerIds);
    offers.forEach((o: any, idx: number) => {
      const intent = intentMap.get(o?.offerId);
      if (!intent?.enabled) return;
      offers[idx].merchantData = offers[idx].merchantData ?? {};
      offers[idx].merchantData.autoPromote = true;
      offers[idx].merchantData.autoPromoteAdRate = intent.adRate;
    });
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class EbayApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly body: unknown,
  ) {
    super(`eBay API error ${statusCode}`);
    this.name = 'EbayApiError';
  }
}

export class EbayPublishError extends EbayApiError {
  constructor(statusCode: number, body: unknown) {
    super(statusCode, body);
    this.name = 'EbayPublishError';
  }
}
