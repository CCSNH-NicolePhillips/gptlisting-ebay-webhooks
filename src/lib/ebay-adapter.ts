import { tokensStore } from "./_blobs.js";
import { userScopedKey } from "./_auth.js";
import { accessTokenFromRefresh, tokenHosts } from "./_common.js";

const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || "EBAY_US";

export type EbayTokenCache = Map<string, string>;

type AccessContext = {
  userId: string;
  token: string;
  apiHost: string;
};

export type OfferFetchResult = {
  offer: any;
  price: number | null;
  currency: string;
};

export type PriceUpdateResult = {
  priceBefore: number | null;
  priceAfter: number;
  offer: any;
};

function baseHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Accept-Language": "en-US",
    "Content-Language": "en-US",
    "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE_ID,
  };
}

function sanitizePrice(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 100) / 100;
}

async function ensureAccess(userId: string, cache?: EbayTokenCache): Promise<AccessContext> {
  const trimmed = userId.trim();
  if (!trimmed) throw new Error("Missing userId for eBay access");
  const cached = cache?.get(trimmed);
  const { apiHost } = tokenHosts(process.env.EBAY_ENV);
  if (cached) {
    return { userId: trimmed, token: cached, apiHost };
  }
  const store = tokensStore();
  const saved = (await store.get(userScopedKey(trimmed, "ebay.json"), {
    type: "json",
  })) as any;
  const refresh = typeof saved?.refresh_token === "string" ? saved.refresh_token : null;
  if (!refresh) {
    throw new Error(`No eBay refresh token found for user ${trimmed}`);
  }
  const { access_token } = await accessTokenFromRefresh(refresh);
  if (!access_token) {
    throw new Error("Failed to exchange refresh token for access token");
  }
  cache?.set(trimmed, access_token);
  return { userId: trimmed, token: access_token, apiHost };
}

async function fetchOfferWithContext(
  context: AccessContext,
  offerId: string
): Promise<OfferFetchResult> {
  const id = offerId.trim();
  if (!id) throw new Error("Missing offerId");
  const url = `${context.apiHost}/sell/inventory/v1/offer/${encodeURIComponent(id)}`;
  const res = await fetch(url, { headers: baseHeaders(context.token) });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Offer fetch failed ${res.status}: ${text}`);
  }
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("Offer fetch returned invalid JSON");
  }
  const rawPrice = sanitizePrice(json?.pricingSummary?.price?.value);
  const currency =
    typeof json?.pricingSummary?.price?.currency === "string" && json.pricingSummary.price.currency
      ? json.pricingSummary.price.currency
      : "USD";
  return { offer: json, price: rawPrice > 0 ? rawPrice : null, currency };
}

function cloneOffer(offer: any): any {
  return JSON.parse(JSON.stringify(offer ?? {}));
}

function cleanupOfferPayload(payload: any): any {
  if (!payload || typeof payload !== "object") return payload;
  delete payload.errors;
  delete payload.warnings;
  delete payload.marketplaceFees;
  delete payload.marketplaceFeesCalculationStatus;
  delete payload.marketplaceFeesSummary;
  return payload;
}

export async function fetchOffer(
  userId: string,
  offerId: string,
  opts: { tokenCache?: EbayTokenCache } = {}
): Promise<OfferFetchResult> {
  const context = await ensureAccess(userId, opts.tokenCache);
  return fetchOfferWithContext(context, offerId);
}

export async function updateOfferPrice(
  userId: string,
  offerId: string,
  targetPrice: number,
  opts: { tokenCache?: EbayTokenCache; dryRun?: boolean } = {}
): Promise<PriceUpdateResult> {
  const normalizedPrice = sanitizePrice(targetPrice);
  if (!normalizedPrice || normalizedPrice <= 0) {
    throw new Error("Invalid price value");
  }
  const context = await ensureAccess(userId, opts.tokenCache);
  const { offer, price: previousPrice, currency } = await fetchOfferWithContext(context, offerId);
  const payload = cleanupOfferPayload(cloneOffer(offer));
  const appliedCurrency = currency || "USD";
  if (!payload.pricingSummary) payload.pricingSummary = {};
  payload.pricingSummary.price = {
    currency: appliedCurrency,
    value: normalizedPrice.toFixed(2),
  };

  if (opts.dryRun) {
    return {
      priceBefore: previousPrice,
      priceAfter: normalizedPrice,
      offer: payload,
    };
  }

  const url = `${context.apiHost}/sell/inventory/v1/offer/${encodeURIComponent(offerId.trim())}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { ...baseHeaders(context.token), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Offer update failed ${res.status}: ${text}`);
  }
  let updated: any = payload;
  try {
    const parsed = JSON.parse(text);
    if (parsed) updated = parsed;
  } catch {
    // keep payload when response is not JSON
  }
  return {
    priceBefore: previousPrice,
    priceAfter: normalizedPrice,
    offer: updated,
  };
}
