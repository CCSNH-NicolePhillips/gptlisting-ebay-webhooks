import type { Handler } from "@netlify/functions";
import { accessTokenFromRefresh, tokenHosts } from "../../src/lib/_common.js";
import { tokensStore } from "../../src/lib/_blobs.js";
import { userScopedKey } from "../../src/lib/_auth.js";
import { getOrigin, isAuthorized, isOriginAllowed, jsonResponse } from "../../src/lib/http.js";
import { maybeRequireUserAuth } from "../../src/lib/auth-user.js";
import type { UserAuth } from "../../src/lib/auth-user.js";
import { mapGroupToDraftWithTaxonomy } from "../../src/lib/taxonomy-map.js";

type HeadersMap = Record<string, string | undefined>;

const METHODS = "POST, OPTIONS";

type DraftItem = {
  sku: string;
  title: string;
  price: number;
  quantity: number;
  imageUrls: string[];
  aspects?: Record<string, string[]>;
  inventoryCondition?: string;
  offerCondition?: number;
  categoryId?: string;
  description?: string;
  fulfillmentPolicyId?: string | null;
  paymentPolicyId?: string | null;
  returnPolicyId?: string | null;
  merchantLocationKey?: string | null;
  marketplaceId?: string;
  // Optional shipping weight (from wizard UI)
  weightLbs?: number;
  weightOz?: number;
};

type DraftMeta = {
  selectedCategory?: { id: string; slug: string; title: string } | null;
  missingRequired?: string[];
  marketplaceId?: string;
  categoryId?: string;
  price?: number;
};

type DraftPreview = {
  sku: string;
  title: string;
  price: number;
  quantity: number;
  categoryId?: string;
  marketplaceId?: string;
  imageUrls: string[];
  aspects: Record<string, string[]>;
};

type PolicyCache = {
  fulfillment: Map<string, string>;
  payment: Map<string, string>;
  return: Map<string, string>;
};

type EnvPolicies = {
  fulfillment?: string | null;
  payment?: string | null;
  return?: string | null;
};

type ProcessContext = {
  apiHost: string;
  baseHeaders: Record<string, string>;
  appBase: string | null;
  defaultCategoryId: string;
  defaultMarketplaceId: string;
  promotedCampaignId?: string | null;
  envPolicies: EnvPolicies;
  envLocationKey?: string | null;
  locationCache: Set<string>;
  policyCache: PolicyCache;
};

export const handler: Handler = async (event) => {
  const headers = event.headers as HeadersMap;
  const originHdr = getOrigin(headers);
  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(200, {}, originHdr, METHODS);
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" }, originHdr, METHODS);
  }

  const fetchSite = (headers["sec-fetch-site"] || headers["Sec-Fetch-Site"] || "")
    .toString()
    .toLowerCase();
  const originAllowed = isOriginAllowed(originHdr);
  if (!originAllowed && fetchSite !== "same-origin") {
    return jsonResponse(403, { error: "Forbidden" }, originHdr, METHODS);
  }

  let userAuth: UserAuth | null = null;
  if (!isAuthorized(headers)) {
    try {
      userAuth = await maybeRequireUserAuth(headers.authorization || headers.Authorization);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err ?? "");
      console.warn("[ebay-create-draft] user auth failed", reason);
      return jsonResponse(401, { error: "Unauthorized" }, originHdr, METHODS);
    }
    if (!userAuth) {
      return jsonResponse(401, { error: "Unauthorized" }, originHdr, METHODS);
    }
  }

  let payload: any = {};
  if (event.body) {
    try {
      payload = JSON.parse(event.body);
    } catch {
      return jsonResponse(400, { error: "Invalid JSON" }, originHdr, METHODS);
    }
  }

  const initialItems: any[] = Array.isArray(payload?.items)
    ? payload.items
    : payload &&
        typeof payload === "object" &&
        !Array.isArray(payload) &&
        Object.keys(payload).length &&
        (payload as any).groups == null
      ? [payload]
      : [];

  const rawItems: any[] = [];
  const rawMeta: Array<DraftMeta | null> = [];

  initialItems.forEach((item) => {
    rawItems.push(item);
    rawMeta.push(extractMeta(item));
  });

  const invalid: Array<{ index: number; error: string; sku?: string; meta?: DraftMeta | null }> = [];

  if (Array.isArray(payload?.groups)) {
    const groupIndexBase = rawItems.length;
    for (let i = 0; i < payload.groups.length; i++) {
      const group = payload.groups[i];
      try {
        const mapped = await mapGroupToDraftWithTaxonomy(group);
        rawItems.push(mapped);
        rawMeta.push(extractMeta(mapped));
      } catch (err: any) {
        const message = err instanceof Error ? err.message : String(err);
        invalid.push({
          index: groupIndexBase + i,
          error: message,
          sku: groupSkuHint(group) || undefined,
          meta: extractMeta(group),
        });
      }
    }
  }

  if (!rawItems.length) {
    return jsonResponse(400, { error: "No items provided", invalid }, originHdr, METHODS);
  }

  const normalized: DraftItem[] = [];
  const normalizedMeta: Array<DraftMeta | null> = [];

  rawItems.forEach((item, idx) => {
    try {
      const mapped = normalizeItem(item);
      if (mapped) {
        normalized.push(mapped);
        normalizedMeta.push(rawMeta[idx] ?? extractMeta(item));
      } else {
        invalid.push({
          index: idx,
          error: "Item missing required fields",
          sku: captureSku(item) || undefined,
          meta: rawMeta[idx] ?? extractMeta(item),
        });
      }
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err);
      const fallbackSku = captureSku(item);
      invalid.push({
        index: idx,
        error: message,
        sku: fallbackSku || undefined,
        meta: rawMeta[idx] ?? extractMeta(item),
      });
    }
  });

  if (!normalized.length) {
    const invalidSummaries = invalid.map((entry) => ({
      index: entry.index,
      error: entry.error,
      sku: entry.sku,
      meta: cleanMeta(entry.meta ?? null),
    }));
    return jsonResponse(400, { error: "No valid items", invalid: invalidSummaries }, originHdr, METHODS);
  }

  const invalidSummaries = invalid.map((entry) => ({
    index: entry.index,
    error: entry.error,
    sku: entry.sku,
    meta: cleanMeta(entry.meta ?? null),
  }));

  const appBase = deriveBaseUrlFromEvent(event);

  let refreshToken = (process.env.EBAY_REFRESH_TOKEN || "").trim();
  let refreshSource: "env" | "user" | "global" | null = refreshToken ? "env" : null;

  if (!refreshToken && userAuth?.userId) {
    try {
      const store = tokensStore();
      const saved = (await store.get(userScopedKey(userAuth.userId, "ebay.json"), { type: "json" })) as any;
      const candidate = typeof saved?.refresh_token === "string" ? saved.refresh_token.trim() : "";
      if (candidate) {
        refreshToken = candidate;
        refreshSource = "user";
      }
    } catch (err) {
      console.warn("[ebay-create-draft] failed to load user-scoped refresh token", err);
    }
  }

  if (!refreshToken) {
    try {
      const store = tokensStore();
      const saved = (await store.get("ebay.json", { type: "json" })) as any;
      const candidate = typeof saved?.refresh_token === "string" ? saved.refresh_token.trim() : "";
      if (candidate) {
        refreshToken = candidate;
        refreshSource = "global";
      }
    } catch (err) {
      console.warn("[ebay-create-draft] failed to load global refresh token", err);
    }
  }

  if (!refreshToken) {
    return jsonResponse(
      500,
      {
        error: "EBAY_REFRESH_TOKEN env var is required",
        detail: "Add EBAY_REFRESH_TOKEN in environment or connect eBay for this account.",
      },
      originHdr,
      METHODS,
    );
  }

  if (refreshSource) {
    console.log(
      JSON.stringify({ evt: "ebay.refreshToken.source", source: refreshSource, userId: userAuth?.userId || null }),
    );
  }

  let token: { access_token: string };
  try {
    token = await accessTokenFromRefresh(refreshToken);
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse(500, { error: "Failed to refresh eBay token", detail: message }, originHdr, METHODS);
  }

  const ENV = (process.env.EBAY_ENV || "PROD").toUpperCase();
  const { apiHost } = tokenHosts(ENV);
  const defaultMarketplaceId = process.env.DEFAULT_MARKETPLACE_ID || process.env.EBAY_MARKETPLACE_ID || "EBAY_US";
  const defaultCategoryId = process.env.DEFAULT_CATEGORY_ID || "31413";
  const promotedCampaignId = process.env.PROMOTED_CAMPAIGN_ID || null;

  const baseHeaders: Record<string, string> = {
    Authorization: `Bearer ${token.access_token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "Accept-Language": "en-US",
    "Content-Language": "en-US",
  };

  const context: ProcessContext = {
    apiHost,
    baseHeaders,
    appBase,
    defaultCategoryId,
    defaultMarketplaceId,
    promotedCampaignId,
    envPolicies: {
      fulfillment: process.env.EBAY_FULFILLMENT_POLICY_ID || null,
      payment: process.env.EBAY_PAYMENT_POLICY_ID || null,
      return: process.env.EBAY_RETURN_POLICY_ID || null,
    },
    envLocationKey: process.env.EBAY_MERCHANT_LOCATION_KEY || null,
    locationCache: new Set<string>(),
    policyCache: {
      fulfillment: new Map<string, string>(),
      payment: new Map<string, string>(),
      return: new Map<string, string>(),
    },
  };

  const successes: Array<{
    sku: string;
    offerId: string;
    status: string;
    offer: unknown;
    meta?: DraftMeta | null;
    draft?: DraftPreview;
  }> = [];
  const failures: Array<{
    sku: string;
    error: string;
    detail?: unknown;
    meta?: DraftMeta | null;
    draft?: DraftPreview;
  }> = invalidSummaries.map(
    (entry) => ({
      sku: entry.sku || `idx:${entry.index}`,
      error: entry.error,
      meta: entry.meta || null,
    })
  );

  for (let i = 0; i < normalized.length; i++) {
    const item = normalized[i];
    const meta = cleanMeta(normalizedMeta[i] ?? null);
    try {
      const result = await processItem(item, context);
      successes.push({ ...result, meta, draft: buildDraftPreview(item) });
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ sku: item.sku, error: message, detail: err?.detail, meta, draft: buildDraftPreview(item) });
    }
  }

  console.log(
    JSON.stringify({
      evt: "ebay.createDraft",
      dryRun: false,
      created: successes.length,
      failures: failures.length,
      invalid: invalidSummaries.length,
      userId: userAuth?.userId || null,
    }),
  );

  const ok = successes.length > 0;

  return jsonResponse(
    200,
    {
      ok,
      dryRun: false,
      created: successes.length,
      results: successes,
      failures,
      invalid: invalidSummaries,
    },
    originHdr,
    METHODS
  );
};

function normalizeItem(raw: any): DraftItem {
  if (!raw || typeof raw !== "object") throw new Error("Invalid item payload");
  const inventory = raw.inventory || {};
  const product = inventory.product || {};
  const offer = raw.offer || {};

  const sku = sanitizeSku(offer.sku || raw.sku);
  if (!sku) throw new Error("Missing sku");

  const title = String(product.title || offer.title || raw.title || "").trim();
  if (!title) throw new Error("Missing title");

  const price = Number(offer.price ?? raw.price ?? 0);
  if (!Number.isFinite(price) || price <= 0) throw new Error("Missing price");

  let imagesSource = Array.isArray(product.imageUrls)
    ? product.imageUrls
    : Array.isArray(raw.imageUrls)
      ? raw.imageUrls
      : [];
  if (!imagesSource.length) {
    if (Array.isArray((raw as any).images)) {
      imagesSource = (raw as any).images;
    } else if (typeof (raw as any).images === "string") {
      imagesSource = ((raw as any).images as string)
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean);
    }
  }
  const imageUrls = imagesSource
    .filter((url: unknown) => typeof url === "string" && url.trim())
    .map((url: unknown) => String(url as string).trim())
    .slice(0, 12);
  if (!imageUrls.length) throw new Error("Missing images");

  const qtyRaw = Number(offer.quantity ?? raw.quantity ?? raw.qty ?? 1);
  const quantity = Number.isFinite(qtyRaw) && qtyRaw > 0 ? Math.trunc(qtyRaw) : 1;

  const aspects = normalizeAspects(product.aspects || raw.aspects);
  const conditionRaw = inventory.condition ?? offer.condition ?? raw.condition ?? "NEW";
  const { inventoryCondition, offerCondition } = normalizeCondition(conditionRaw);

  const categoryId = offer.categoryId || raw.categoryId || undefined;
  const marketplaceId = offer.marketplaceId || raw.marketplaceId || undefined;
  const description = product.description || offer.description || raw.description || title;
  const merchantLocationKey =
    offer.merchantLocationKey || offer.locationKey || raw.merchantLocationKey || raw.locationKey || null;

  // Optional weight from payload (separate lbs/oz from wizard)
  const weightLbsRaw = Number((raw as any).weightLbs ?? (offer as any)?.weightLbs ?? 0);
  const weightOzRaw = Number((raw as any).weightOz ?? (offer as any)?.weightOz ?? 0);
  const weightLbs = Number.isFinite(weightLbsRaw) && weightLbsRaw > 0 ? Math.round(weightLbsRaw * 100) / 100 : undefined;
  const weightOz = Number.isFinite(weightOzRaw) && weightOzRaw > 0 ? Math.round(weightOzRaw * 10) / 10 : undefined;

  return {
    sku,
    title,
    price: Math.round(price * 100) / 100,
    quantity,
    imageUrls,
    aspects,
    inventoryCondition,
    offerCondition,
    categoryId,
    description,
    fulfillmentPolicyId: offer.fulfillmentPolicyId || raw.fulfillmentPolicyId || null,
    paymentPolicyId: offer.paymentPolicyId || raw.paymentPolicyId || null,
    returnPolicyId: offer.returnPolicyId || raw.returnPolicyId || null,
    merchantLocationKey: merchantLocationKey ? String(merchantLocationKey) : null,
    marketplaceId,
    ...(weightLbs != null || weightOz != null ? { weightLbs, weightOz } : {}),
  };
}

function extractMeta(raw: unknown): DraftMeta | null {
  if (!raw || typeof raw !== "object") return null;
  const meta = (raw as any)._meta;
  if (!meta || typeof meta !== "object") return null;

  const candidate: DraftMeta = {};

  if (meta.selectedCategory && typeof meta.selectedCategory === "object") {
    const source = meta.selectedCategory as Record<string, unknown>;
    const idValue = source.id ?? source.categoryId;
    if (idValue) {
      const id = String(idValue);
      const slug = source.slug ? String(source.slug) : id;
      const title = source.title ? String(source.title) : slug;
      candidate.selectedCategory = { id, slug, title };
    }
  }

  if (Array.isArray(meta.missingRequired)) {
    candidate.missingRequired = meta.missingRequired.map((entry: unknown) => String(entry)).filter(Boolean);
  }

  if (meta.marketplaceId) candidate.marketplaceId = String(meta.marketplaceId);
  if (meta.categoryId) candidate.categoryId = String(meta.categoryId);
  if (typeof meta.price === "number" && Number.isFinite(meta.price)) candidate.price = meta.price;

  return cleanMeta(candidate);
}

function cleanMeta(meta: DraftMeta | null): DraftMeta | null {
  if (!meta) return null;
  const out: DraftMeta = {};
  if (meta.selectedCategory && meta.selectedCategory.id) {
    const id = meta.selectedCategory.id;
    const slug = meta.selectedCategory.slug || id;
    const title = meta.selectedCategory.title || slug;
    out.selectedCategory = { id, slug, title };
  }
  if (Array.isArray(meta.missingRequired) && meta.missingRequired.length) {
    const dedup = Array.from(new Set(meta.missingRequired.map((entry) => String(entry).trim()).filter(Boolean)));
    if (dedup.length) out.missingRequired = dedup;
  }
  if (meta.marketplaceId) out.marketplaceId = meta.marketplaceId;
  if (meta.categoryId) out.categoryId = meta.categoryId;
  if (typeof meta.price === "number" && Number.isFinite(meta.price)) out.price = meta.price;
  return Object.keys(out).length ? out : null;
}

function missingFromAspects(aspects?: Record<string, string[] | undefined> | undefined): string[] {
  if (!aspects) return [];
  return Object.entries(aspects)
    .filter(([, values]) => Array.isArray(values) && values.length === 0)
    .map(([name]) => name);
}

function mergeMeta(meta: DraftMeta | null | undefined, item: DraftItem): DraftMeta | null {
  const cleaned = cleanMeta(meta ?? null);
  const merged: DraftMeta = cleaned ? { ...cleaned } : {};
  const missing = missingFromAspects(item.aspects);
  if (missing.length) {
    const set = new Set((merged.missingRequired || []).map((entry) => entry));
    missing.forEach((entry) => set.add(entry));
    merged.missingRequired = Array.from(set);
  }
  if (!merged.marketplaceId && item.marketplaceId) merged.marketplaceId = item.marketplaceId;
  if (!merged.categoryId && item.categoryId) merged.categoryId = item.categoryId;
  if (!merged.selectedCategory && item.categoryId) {
    merged.selectedCategory = { id: item.categoryId, slug: item.categoryId, title: item.categoryId };
  }
  if (typeof item.price === "number" && Number.isFinite(item.price)) merged.price = item.price;
  return cleanMeta(merged);
}

function buildDraftPreview(item: DraftItem): DraftPreview {
  return {
    sku: item.sku,
    title: item.title,
    price: item.price,
    quantity: item.quantity,
    categoryId: item.categoryId,
    marketplaceId: item.marketplaceId,
    imageUrls: item.imageUrls,
    aspects: item.aspects || {},
  };
}

function sanitizeSku(value: unknown): string | null {
  if (!value) return null;
  const cleaned = String(value)
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 50);
  return cleaned || null;
}

function captureSku(raw: unknown): string | null {
  try {
    if (!raw || typeof raw !== "object") return null;
    const data = raw as Record<string, unknown>;
    const offer = typeof data.offer === "object" && data.offer ? (data.offer as Record<string, unknown>) : undefined;
    const candidate = offer?.sku ?? data.sku;
    return sanitizeSku(candidate);
  } catch {
    return null;
  }
}

function groupSkuHint(raw: any): string | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw.sku || raw.groupId || raw.id;
  if (candidate && typeof candidate === "string") {
    return candidate.slice(0, 50);
  }
  return null;
}

function normalizeCondition(value: unknown): { inventoryCondition?: string; offerCondition?: number } {
  if (typeof value === "number" && Number.isFinite(value)) {
    return {
      inventoryCondition: mapCondToInventory(Number(value)) ?? undefined,
      offerCondition: Number(value),
    };
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return {};
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return {
        inventoryCondition: mapCondToInventory(numeric) ?? undefined,
        offerCondition: numeric,
      };
    }
    const upper = trimmed.toUpperCase();
    return {
      inventoryCondition: upper || undefined,
      offerCondition: conditionStringToCode(upper),
    };
  }
  return {};
}

function mapCondToInventory(code?: number): string | undefined {
  switch (code) {
    case 1000:
      return "NEW";
    case 1500:
      return "NEW_OTHER";
    case 1750:
      return "NEW_WITH_DEFECTS";
    case 2000:
      return "CERTIFIED_REFURBISHED";
    case 2500:
      return "SELLER_REFURBISHED";
    case 2750:
      return "LIKE_NEW";
    case 3000:
      return "USED";
    case 4000:
      return "VERY_GOOD";
    case 5000:
      return "GOOD";
    case 6000:
      return "ACCEPTABLE";
    case 7000:
      return "FOR_PARTS_OR_NOT_WORKING";
    default:
      return undefined;
  }
}

function conditionStringToCode(value: string): number | undefined {
  switch (value.toUpperCase()) {
    case "NEW":
      return 1000;
    case "NEW_OTHER":
    case "NEW OTHER":
    case "NEW OTHER (SEE DETAILS)":
      return 1500;
    case "NEW_WITH_DEFECTS":
      return 1750;
    case "CERTIFIED_REFURBISHED":
    case "CERTIFIED REFURBISHED":
      return 2000;
    case "SELLER_REFURBISHED":
      return 2500;
    case "LIKE_NEW":
    case "LIKE NEW":
      return 2750;
    case "USED":
      return 3000;
    case "VERY_GOOD":
    case "VERY GOOD":
      return 4000;
    case "GOOD":
      return 5000;
    case "ACCEPTABLE":
      return 6000;
    case "FOR_PARTS_OR_NOT_WORKING":
    case "FOR PARTS OR NOT WORKING":
      return 7000;
    default:
      return undefined;
  }
}

function normalizeAspects(input: unknown): Record<string, string[]> | undefined {
  if (!input || typeof input !== "object") return undefined;
  const out: Record<string, string[]> = {};
  Object.entries(input as Record<string, unknown>).forEach(([key, value]) => {
    if (!key) return;
    const values = Array.isArray(value) ? value : [value];
    const normalized = values
      .map((entry) => (entry == null ? "" : String(entry).trim()))
      .filter(Boolean);
    if (normalized.length || (Array.isArray(value) && value.length === 0)) {
      out[String(key).trim()] = normalized;
    }
  });
  return Object.keys(out).length ? out : undefined;
}

function deriveBaseUrlFromEvent(event: any): string | null {
  try {
    const hdrs = event?.headers || {};
    const proto = (hdrs["x-forwarded-proto"] || hdrs["X-Forwarded-Proto"] || "https") as string;
    const host = (hdrs["x-forwarded-host"] || hdrs["X-Forwarded-Host"] || hdrs.host || hdrs.Host) as string;
    if (host) return `${proto}://${host}`;
  } catch {
    // ignore derivation errors
  }
  return null;
}

function toDirectDropbox(input: string): string {
  try {
    const url = new URL(input);
    if (url.hostname === "www.dropbox.com" || url.hostname === "dropbox.com") {
      url.hostname = "dl.dropboxusercontent.com";
      const qp = new URLSearchParams(url.search);
      qp.delete("dl");
      const qs = qp.toString();
      url.search = qs ? `?${qs}` : "";
      return url.toString();
    }
    return input;
  } catch {
    return input;
  }
}

async function processItem(item: DraftItem, ctx: ProcessContext) {
  const marketplaceId = item.marketplaceId || ctx.defaultMarketplaceId;
  const headers = makeHeaders(ctx.baseHeaders, marketplaceId);
  const imageUrls = await validateAndMaybeProxy(item.imageUrls, ctx.appBase);

  const inventoryPayload: Record<string, unknown> = {
    sku: item.sku,
    product: {
      title: item.title,
      description: item.description || item.title,
      imageUrls,
    },
    availability: { shipToLocationAvailability: { quantity: item.quantity } },
  };
  // If weight was provided, set package weight in ounces to satisfy shipping requirements
  try {
    const lbs = Number(item.weightLbs ?? 0);
    const oz = Number(item.weightOz ?? 0);
    const totalOz = (Number.isFinite(lbs) && lbs > 0 ? lbs * 16 : 0) + (Number.isFinite(oz) && oz > 0 ? oz : 0);
    if (totalOz > 0) {
      const rounded = Math.round(totalOz * 10) / 10; // 0.1 oz precision
      (inventoryPayload as any).packageWeightAndSize = {
        weight: { value: rounded, unit: 'OUNCE' },
      };
    }
  } catch {
    // ignore weight issues
  }
  if (item.inventoryCondition) inventoryPayload.condition = item.inventoryCondition;
  if (item.aspects) {
    console.log(`[processItem] Adding aspects for SKU ${item.sku}:`, JSON.stringify(item.aspects, null, 2));
    console.log(`[processItem] Has Brand? ${!!item.aspects.Brand}, Brand value:`, item.aspects.Brand);
    (inventoryPayload.product as any).aspects = item.aspects;
  } else {
    console.warn(`[processItem] NO ASPECTS for SKU ${item.sku}!`);
  }

  console.log(`[processItem] Sending inventory PUT for SKU ${item.sku} with payload:`, JSON.stringify(inventoryPayload, null, 2));

  const invUrl = `${ctx.apiHost}/sell/inventory/v1/inventory_item/${encodeURIComponent(item.sku)}`;
  const invRes = await fetch(invUrl, {
    method: "PUT",
    headers,
    body: JSON.stringify(inventoryPayload),
  });
  if (!invRes.ok) {
    const errorDetail = await safeBody(invRes);
    console.error(`[processItem] Inventory PUT failed for SKU ${item.sku}:`, errorDetail);
    throw buildError("inventory put failed", {
      step: "put-inventory-item",
      status: invRes.status,
      detail: await safeBody(invRes),
    });
  }

  const mlkBase = item.merchantLocationKey || ctx.envLocationKey;
  if (!mlkBase) {
    throw buildError("missing-location", {
      step: "get-location",
      detail: "No inventory location specified. Please set a default location in Settings.",
    });
  }
  const merchantLocationKey = mlkBase.trim().replace(/\s+/g, "-");
  if (!ctx.locationCache.has(merchantLocationKey)) {
    const locUrl = `${ctx.apiHost}/sell/inventory/v1/location/${encodeURIComponent(
      merchantLocationKey
    )}`;
    const locRes = await fetch(locUrl, { headers });
    if (locRes.status === 404) {
      throw buildError("missing-location", {
        step: "get-location",
        location: merchantLocationKey,
        detail: await safeBody(locRes),
      });
    }
    if (!locRes.ok) {
      throw buildError("location check failed", {
        step: "get-location",
        status: locRes.status,
        detail: await safeBody(locRes),
      });
    }
    ctx.locationCache.add(merchantLocationKey);
  }

  const fulfillmentPolicyId =
    item.fulfillmentPolicyId ||
    ctx.envPolicies.fulfillment ||
    (await resolvePolicy(
      ctx.policyCache.fulfillment,
      marketplaceId,
      () => pickPolicy(ctx.apiHost, headers, "/sell/account/v1/fulfillment_policy", marketplaceId)
    ));
  const paymentPolicyId =
    item.paymentPolicyId ||
    ctx.envPolicies.payment ||
    (await resolvePolicy(
      ctx.policyCache.payment,
      marketplaceId,
      () => pickPolicy(ctx.apiHost, headers, "/sell/account/v1/payment_policy", marketplaceId)
    ));
  const returnPolicyId =
    item.returnPolicyId ||
    ctx.envPolicies.return ||
    (await resolvePolicy(
      ctx.policyCache.return,
      marketplaceId,
      () => pickPolicy(ctx.apiHost, headers, "/sell/account/v1/return_policy", marketplaceId)
    ));

  if (!fulfillmentPolicyId || !paymentPolicyId || !returnPolicyId) {
    throw buildError("missing-policies", {
      step: "ensure-policies",
      marketplaceId,
    });
  }

  const offerPayload: Record<string, unknown> = {
    sku: item.sku,
    marketplaceId,
    format: "FIXED_PRICE",
    availableQuantity: item.quantity,
    categoryId: item.categoryId || ctx.defaultCategoryId,
    listingDescription: item.description || item.title,
    pricingSummary: { price: { currency: "USD", value: item.price.toFixed(2) } },
    listingPolicies: {
      fulfillmentPolicyId,
      paymentPolicyId,
      returnPolicyId,
    },
    merchantLocationKey,
  };
  if (item.offerCondition) offerPayload.condition = item.offerCondition;
  if (ctx.promotedCampaignId) offerPayload.appliedPromotionIds = [ctx.promotedCampaignId];

  const offerUrl = `${ctx.apiHost}/sell/inventory/v1/offer`;
  const offerRes = await fetch(offerUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(offerPayload),
  });
  const offerBody = await safeBody(offerRes);
  if (!offerRes.ok) {
    throw buildError("offer create failed", {
      step: "post-offer",
      status: offerRes.status,
      detail: offerBody,
    });
  }

  const offerId = (offerBody as any)?.offerId || (offerBody as any)?.offer?.offerId;
  if (!offerId) {
    throw buildError("offer missing id after create", {
      step: "verify-offer",
      detail: offerBody,
    });
  }

  const verifyUrl = `${ctx.apiHost}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`;
  const verifyRes = await fetch(verifyUrl, { headers });
  const verifyBody = await safeBody(verifyRes);
  if (!verifyRes.ok) {
    throw buildError("offer verification failed", {
      step: "verify-offer",
      status: verifyRes.status,
      offerId,
      detail: verifyBody,
    });
  }

  return {
    sku: item.sku,
    offerId,
    status: (verifyBody as any)?.status ?? "UNKNOWN",
    offer: verifyBody,
  };
}

async function validateAndMaybeProxy(urls: string[], appBase: string | null): Promise<string[]> {
  const out: string[] = [];
  const base = appBase ? appBase.replace(/\/$/, "") : "";
  const isProxy = (u: string) => /\/\.netlify\/functions\/image-proxy/i.test(u);
  const absolutizeProxy = (u: string) => {
    if (u.startsWith("/") && base) return `${base}${u}`;
    return u;
  };
  const addBust = (u: string) => {
    try {
      const url = new URL(u, base || undefined);
      url.searchParams.set("v", Date.now().toString(36));
      return url.toString();
    } catch {
      return `${u}${u.includes("?") ? "&" : "?"}v=${Date.now().toString(36)}`;
    }
  };
  const maybeProxy = (source: string) => {
    if (isProxy(source)) return addBust(absolutizeProxy(source));
    const direct = toDirectDropbox(source);
    if (isProxy(direct)) return addBust(absolutizeProxy(direct));
    try {
      const url = new URL(direct);
      if (/(^|\.)dropbox\.com$/i.test(url.hostname)) {
        const prox = base
          ? `${base}/.netlify/functions/image-proxy?url=${encodeURIComponent(direct)}`
          : `/.netlify/functions/image-proxy?url=${encodeURIComponent(direct)}`;
        return addBust(absolutizeProxy(prox));
      }
    } catch {
      // ignore parse issues
    }
    return addBust(direct);
  };

  for (const src of urls) {
    const normalized = maybeProxy(String(src));
    try {
      const head = await fetch(normalized, { method: "HEAD", redirect: "follow" });
      const ct = (head.headers.get("content-type") || "").toLowerCase();
      if (head.ok && (!ct || ct.startsWith("image/"))) {
        out.push(normalized);
        continue;
      }
    } catch {
      // ignore failures during validation
    }
    out.push(normalized);
  }

  return Array.from(new Set(out)).slice(0, 12);
}

async function pickPolicy(
  apiHost: string,
  headers: Record<string, string>,
  path: string,
  marketplaceId: string
): Promise<string | null> {
  const url = `${apiHost}${path}?marketplace_id=${marketplaceId}`;
  const res = await fetch(url, { headers });
  const body = await safeBody(res);
  if (!res.ok) {
    return null;
  }
  const list =
    (body as any).fulfillmentPolicies ||
    (body as any).paymentPolicies ||
    (body as any).returnPolicies ||
    [];
  if (!Array.isArray(list) || !list.length) return null;
  const first = list[0];
  return (
    first?.id ||
    first?.fulfillmentPolicyId ||
    first?.paymentPolicyId ||
    first?.returnPolicyId ||
    null
  );
}

async function resolvePolicy(
  cache: Map<string, string>,
  marketplaceId: string,
  loader: () => Promise<string | null>
): Promise<string | null> {
  if (cache.has(marketplaceId)) {
    return cache.get(marketplaceId) || null;
  }
  const value = await loader();
  if (value) cache.set(marketplaceId, value);
  return value;
}

function makeHeaders(base: Record<string, string>, marketplaceId: string) {
  return { ...base, "X-EBAY-C-MARKETPLACE-ID": marketplaceId };
}

async function safeBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => "");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return text;
  }
}

function buildError(message: string, detail?: unknown) {
  const err = new Error(message);
  (err as any).detail = detail;
  return err;
}
