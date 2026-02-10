import type { TaxonomyMappedDraft } from "./map-group-to-draft.js";

const DEFAULT_MARKETPLACE = process.env.DEFAULT_MARKETPLACE_ID || "EBAY_US";
const locationCache = new Set<string>();

function makeHeaders(token: string, marketplaceId: string, opts: { json?: boolean } = {}) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Accept-Language": "en-US",
    "Content-Language": "en-US",
    "X-EBAY-C-MARKETPLACE-ID": marketplaceId,
  };

  if (opts.json !== false) {
    headers["Content-Type"] = "application/json";
  }

  return headers;
}

function normalizeMarketplaceId(value: unknown): string {
  const str = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_MARKETPLACE;
  return str;
}

function normalizeLocationKey(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Missing merchantLocationKey");
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Missing merchantLocationKey");
  }
  return trimmed.replace(/\s+/g, "-");
}

function sanitizeQuantity(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return 1;
  }
  return Math.trunc(num);
}

function sanitizePrice(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error("Invalid price for offer");
  }
  return Math.round(num * 100) / 100;
}

function sanitizeAspects(aspects: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(aspects || {})) {
    if (!Array.isArray(value)) continue;
    const sanitized = value
      .map((entry) => (typeof entry === "string" ? entry : String(entry ?? "")))
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (sanitized.length) {
      out[key] = sanitized.slice(0, 25);
    }
  }
  return out;
}

function sanitizeImageUrls(value: unknown): string[] {
  const out: string[] = [];
  const arr = Array.isArray(value) ? value : [];
  for (const entry of arr) {
    if (typeof entry !== "string") continue;
    const url = entry.trim();
    if (!url) continue;
    // Require http(s) scheme and a plausible host; ignore placeholders
    try {
      const u = new URL(url);
      if ((u.protocol === "http:" || u.protocol === "https:") && /[.]/.test(u.hostname)) {
        out.push(u.toString());
      }
    } catch {
      // skip invalid
    }
  }
  return out.slice(0, 12);
}

async function ensureInventoryLocation(
  token: string,
  apiHost: string,
  marketplaceId: string,
  merchantLocationKey: string
) {
  if (locationCache.has(merchantLocationKey)) return;
  const url = `${apiHost}/sell/inventory/v1/location/${encodeURIComponent(merchantLocationKey)}`;
  const res = await fetch(url, {
    headers: makeHeaders(token, marketplaceId, { json: false }),
  });

  if (res.status === 404) {
    throw new Error(`Inventory location '${merchantLocationKey}' not found`);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Inventory location check failed ${res.status}: ${detail}`);
  }

  locationCache.add(merchantLocationKey);
}

export async function putInventoryItem(
  token: string,
  apiHost: string,
  sku: string,
  inventory: TaxonomyMappedDraft["inventory"],
  quantity: number,
  marketplaceIdInput?: string
) {
  const marketplaceId = normalizeMarketplaceId(marketplaceIdInput);
  const headers = makeHeaders(token, marketplaceId);
  const sanitizedQuantity = sanitizeQuantity(quantity);
  const payload: Record<string, unknown> = {
    sku,
    availability: {
      shipToLocationAvailability: {
        quantity: sanitizedQuantity,
      },
    },
    product: {
      title: inventory.product.title,
      description: inventory.product.description || inventory.product.title,
      imageUrls: sanitizeImageUrls(inventory.product.imageUrls || []),
      aspects: sanitizeAspects(inventory.product.aspects || {}),
    },
  };
  
  // Only add package weight/size if provided - NO defaults!
  // Missing weight will be flagged as "Needs Attention" in the UI
  if (inventory.packageWeightAndSize?.weight?.value) {
    (payload as any).packageWeightAndSize = {
      weight: {
        value: inventory.packageWeightAndSize.weight.value,
        unit: inventory.packageWeightAndSize.weight.unit || 'OUNCE'
      }
    };
    // Add dimensions if provided
    if (inventory.packageWeightAndSize.dimensions) {
      (payload as any).packageWeightAndSize.dimensions = inventory.packageWeightAndSize.dimensions;
    }
  }

  // Ensure at least one valid image URL remains
  if (!Array.isArray((payload.product as any).imageUrls) || !(payload.product as any).imageUrls.length) {
    throw new Error(
      "No valid image URLs found. Provide publicly accessible https links (e.g., Dropbox direct links with dl=1)."
    );
  }

  // Add condition to inventory item if provided
  // Required for some categories (e.g., Dietary Supplements 180960)
  if (inventory.condition) {
    payload.condition = inventory.condition;
    console.log(`[putInventoryItem] Setting condition on inventory: ${inventory.condition}`);
  }

  // Log the payload being sent to eBay for debugging
  console.log('[putInventoryItem] Sending to eBay:', JSON.stringify({
    sku,
    title: (payload.product as any).title,
    imageUrlsCount: ((payload.product as any).imageUrls || []).length,
    firstImageUrl: ((payload.product as any).imageUrls || [])[0]?.substring(0, 120),
    aspectsCount: Object.keys((payload.product as any).aspects || {}).length,
    aspects: (payload.product as any).aspects,
    hasBrand: !!(payload.product as any).aspects?.Brand,
    brandValue: (payload.product as any).aspects?.Brand,
  }, null, 2));
  
  // DEBUG: Log ALL image URLs being sent to eBay
  console.log('[EBAY-SELL IMAGE URLS]', JSON.stringify({
    sku,
    imageUrls: (payload.product as any).imageUrls,
    hasDropbox: ((payload.product as any).imageUrls || []).some((u: string) => u?.includes('dropbox')),
    hasProxy: ((payload.product as any).imageUrls || []).some((u: string) => u?.includes('image-proxy')),
  }, null, 2));

  const url = `${apiHost}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`;
  const res = await fetch(url, {
    method: "PUT",
    headers,
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error('[putInventoryItem] eBay rejected:', detail);
    throw new Error(`Inventory PUT failed ${res.status}: ${detail}`);
  }
  
  console.log('[putInventoryItem] ✓ Success for SKU:', sku);
}

export type BestOfferTerms = {
  enabled: boolean;
  autoDeclinePercent?: number;  // Auto-decline offers below this percent of listing price
  autoAcceptPercent?: number;   // Auto-accept offers at or above this percent of listing price
};

export type OfferCreationPayload = {
  sku: string;
  marketplaceId: string;
  categoryId: string;
  price: number;
  quantity: number;
  condition?: number;
  fulfillmentPolicyId: string | null;
  paymentPolicyId: string | null;
  returnPolicyId: string | null;
  merchantLocationKey: string | null;
  description: string;
  merchantData?: Record<string, any>;
  bestOffer?: BestOfferTerms;
};

export type OfferCreationResult = {
  offerId: string;
  warnings: unknown[];
  raw: any;
};

export async function createOffer(
  token: string,
  apiHost: string,
  input: OfferCreationPayload
): Promise<OfferCreationResult> {
  const marketplaceId = normalizeMarketplaceId(input.marketplaceId);
  const merchantLocationKey = normalizeLocationKey(input.merchantLocationKey);

  if (!input.fulfillmentPolicyId || !input.paymentPolicyId || !input.returnPolicyId) {
    throw new Error("Missing eBay policy IDs (fulfillment/payment/return)");
  }

  await ensureInventoryLocation(token, apiHost, marketplaceId, merchantLocationKey);

  const price = sanitizePrice(input.price);
  const quantity = sanitizeQuantity(input.quantity);
  const headers = makeHeaders(token, marketplaceId);

  const payload: Record<string, unknown> = {
    sku: input.sku,
    marketplaceId,
    format: "FIXED_PRICE",
    availableQuantity: quantity,
    categoryId: input.categoryId,
    listingDescription: input.description,
    pricingSummary: {
      price: {
        currency: "USD",
        value: price.toFixed(2),
      },
    },
    listingPolicies: {
      fulfillmentPolicyId: input.fulfillmentPolicyId,
      paymentPolicyId: input.paymentPolicyId,
      returnPolicyId: input.returnPolicyId,
    },
    merchantLocationKey,
  };

  // CRITICAL: Always set condition for eBay listings
  // Many categories REQUIRE condition to be set (e.g., Dietary Supplements 180960)
  // Default to NEW (1000) if not provided or invalid
  if (typeof input.condition === "number" && Number.isFinite(input.condition) && input.condition > 0) {
    payload.condition = input.condition;
  } else {
    payload.condition = 1000; // NEW - safest default for most categories
    console.warn(`[createOffer] Condition not provided or invalid, defaulting to NEW (1000) for SKU: ${input.sku}`);
  }
  
  // Add merchant data if provided (stores pricing status and metadata)
  if (input.merchantData) {
    payload.merchantData = input.merchantData;
  }

  // Add Best Offer settings if enabled
  console.log(`[createOffer] Best Offer input for SKU ${input.sku}:`, JSON.stringify(input.bestOffer));
  if (input.bestOffer?.enabled) {
    const listingPolicies = payload.listingPolicies as Record<string, unknown>;
    const bestOfferTerms: Record<string, unknown> = {
      bestOfferEnabled: true,
    };
    
    // Calculate auto-decline price (minimum offer to consider)
    if (input.bestOffer.autoDeclinePercent) {
      const autoDeclinePrice = (price * input.bestOffer.autoDeclinePercent / 100);
      bestOfferTerms.autoDeclinePrice = {
        currency: "USD",
        value: autoDeclinePrice.toFixed(2),
      };
      console.log(`[createOffer] Auto-decline: ${input.bestOffer.autoDeclinePercent}% of $${price} = $${autoDeclinePrice.toFixed(2)}`);
    }
    
    // Calculate auto-accept price (auto-accept offers at or above this)
    if (input.bestOffer.autoAcceptPercent) {
      const autoAcceptPrice = (price * input.bestOffer.autoAcceptPercent / 100);
      bestOfferTerms.autoAcceptPrice = {
        currency: "USD",
        value: autoAcceptPrice.toFixed(2),
      };
      console.log(`[createOffer] Auto-accept: ${input.bestOffer.autoAcceptPercent}% of $${price} = $${autoAcceptPrice.toFixed(2)}`);
    }
    
    listingPolicies.bestOfferTerms = bestOfferTerms;
    console.log(`[createOffer] Best Offer enabled for SKU ${input.sku}:`, JSON.stringify(bestOfferTerms));
  } else {
    console.log(`[createOffer] Best Offer NOT enabled for SKU ${input.sku} (enabled=${input.bestOffer?.enabled})`);
  }

  const url = `${apiHost}/sell/inventory/v1/offer`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const text = await res.text().catch(() => "");
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    throw new Error(`Offer create failed ${res.status}: ${text}`);
  }

  const offerId =
    (json && typeof json.offerId === "string" && json.offerId) ||
    (json && typeof json.offer?.offerId === "string" && json.offer.offerId) ||
    "";

  if (!offerId) {
    throw new Error("eBay offer create succeeded without offerId");
  }

  const warnings = Array.isArray(json?.warnings) ? json.warnings : [];
  return { offerId, warnings, raw: json };
}
