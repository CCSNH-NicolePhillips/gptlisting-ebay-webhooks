import { mapGroupToDraftWithTaxonomy, type TaxonomyMappedDraft } from "./taxonomy-map.js";
import { k } from "./user-keys.js";
import { proxyImageUrls } from "./image-utils.js";

const BASE = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

type MapOptions = string | { jobId?: string; userId?: string } | undefined;

type OverrideRecord = {
  sku?: string;
  inventory?: {
    condition?: string;
    product?: {
      title?: string;
      description?: string;
      imageUrls?: unknown[];
      aspects?: Record<string, unknown>;
    };
  };
  offer?: Partial<{
    marketplaceId: string;
    categoryId: string;
    price: number;
    quantity: number;
    condition: number;
    fulfillmentPolicyId: string | null;
    paymentPolicyId: string | null;
    returnPolicyId: string | null;
    merchantLocationKey: string | null;
    description: string;
  }>;
  _meta?: Partial<TaxonomyMappedDraft["_meta"]> & {
    missingRequired?: unknown;
  };
};

type EffectiveOptions = { jobId?: string; userId?: string };

type OverrideFetchResult = OverrideRecord | null;

function toOptions(input: MapOptions): EffectiveOptions {
  if (!input) return {};
  if (typeof input === "string") return { jobId: input };
  return input;
}

async function call(path: string[]) {
  if (!BASE || !TOKEN) return null;
  const url = `${BASE}/${path.map(encodeURIComponent).join("/")}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Upstash ${res.status}: ${detail}`);
  }

  const data: any = await res.json().catch(() => null);
  return data?.result ?? null;
}

function cloneDraft(draft: TaxonomyMappedDraft): TaxonomyMappedDraft {
  return JSON.parse(JSON.stringify(draft)) as TaxonomyMappedDraft;
}

/**
 * Error thrown when a draft would be published with no images.
 * This is a guardrail to prevent broken listings from being created.
 */
export class EmptyImagesError extends Error {
  constructor(
    public readonly groupId: string,
    public readonly candidateUrls: string[],
    public readonly source: string,
    message: string
  ) {
    super(message);
    this.name = "EmptyImagesError";
  }
}

/**
 * Guardrail: Assert that draft has at least 1 valid image URL before publishing.
 * Throws EmptyImagesError with diagnostic info if validation fails.
 */
function assertDraftHasImages(
  draft: TaxonomyMappedDraft,
  groupId: string,
  group: Record<string, unknown>
): void {
  const imageUrls = draft.inventory?.product?.imageUrls;
  
  // Check if images array exists and has at least 1 valid URL
  const validUrls = Array.isArray(imageUrls)
    ? imageUrls.filter((url) => typeof url === "string" && url.trim().length > 0)
    : [];
  
  if (validUrls.length >= 1) {
    return; // Valid - has at least 1 image
  }

  // Gather diagnostic info
  const candidateUrls: string[] = [];
  
  // Check original group for image sources
  const groupImages = group?.images ?? group?.imageUrls ?? group?.urls ?? [];
  if (Array.isArray(groupImages)) {
    candidateUrls.push(...groupImages.slice(0, 5).map(String));
  }
  
  // Detect source type from URLs
  let source = "unknown";
  const sampleUrl = candidateUrls[0] || "";
  if (sampleUrl.includes("dropbox.com") || sampleUrl.includes("dropboxusercontent.com")) {
    source = "dropbox";
  } else if (sampleUrl.includes(".s3.") || sampleUrl.includes("amazonaws.com")) {
    source = "s3";
  } else if (sampleUrl.includes("image-proxy")) {
    source = "proxy";
  } else if (sampleUrl.startsWith("file://") || sampleUrl.startsWith("/")) {
    source = "local";
  } else if (sampleUrl.startsWith("http")) {
    source = "http";
  }

  const message = [
    `[mapGroupToDraft] GUARDRAIL: Draft has 0 valid images - cannot publish`,
    `  groupId: ${groupId || "(none)"}`,
    `  source: ${source}`,
    `  candidateUrls (first 5): ${candidateUrls.length > 0 ? candidateUrls.join(", ") : "(none)"}`,
    `  draft.imageUrls: ${JSON.stringify(imageUrls)}`,
  ].join("\n");

  console.error(message);
  throw new EmptyImagesError(groupId, candidateUrls, source, message);
}

function sanitizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function sanitizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .map((entry) => (typeof entry === "string" ? entry : String(entry ?? "")))
    .map((entry) => entry.trim())
    .filter(Boolean);
  return out.length ? out : undefined;
}

function mergeAspects(base: Record<string, string[]>, override: Record<string, unknown>): Record<string, string[]> {
  const merged: Record<string, string[]> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const sanitized = sanitizeStringArray(value);
    if (sanitized) {
      merged[key] = sanitized;
    } else if (value === null) {
      delete merged[key];
    }
  }
  return merged;
}

async function fetchOverride(userId: string, jobId: string, groupId: string): Promise<OverrideFetchResult> {
  if (!userId || !jobId || !groupId) return null;
  try {
    const key = k.override(userId, jobId, groupId);
    const raw = await call(["GET", key]);
    if (typeof raw !== "string" || !raw) return null;
    return JSON.parse(raw) as OverrideRecord;
  } catch (err) {
    console.warn("[map-group-to-draft] failed to load override", err);
    return null;
  }
}

function applyOverride(base: TaxonomyMappedDraft, override: OverrideRecord): TaxonomyMappedDraft {
  const draft = cloneDraft(base);

  const nextSku = sanitizeString(override.sku);
  if (nextSku) {
    draft.sku = nextSku;
    draft.offer.sku = nextSku;
  }

  if (override.inventory) {
    if (override.inventory.condition) {
      draft.inventory.condition = override.inventory.condition;
    }
    if (override.inventory.product) {
      const product = override.inventory.product;
      const title = sanitizeString(product.title);
      const description = sanitizeString(product.description);
      const imageUrls = sanitizeStringArray(product.imageUrls);
      const aspects = product.aspects && typeof product.aspects === "object" ? mergeAspects(draft.inventory.product.aspects, product.aspects) : undefined;

      if (title) draft.inventory.product.title = title;
      if (description) draft.inventory.product.description = description;
      if (imageUrls) draft.inventory.product.imageUrls = imageUrls.slice(0, 12);
      if (aspects) draft.inventory.product.aspects = aspects;
    }
  }

  if (override.offer) {
    const offer = override.offer;
    const marketplaceId = sanitizeString(offer.marketplaceId);
    const categoryId = sanitizeString(offer.categoryId);
    const description = sanitizeString(offer.description);

    if (marketplaceId) {
      draft.offer.marketplaceId = marketplaceId;
      draft._meta.marketplaceId = marketplaceId;
    }
    if (categoryId) {
      draft.offer.categoryId = categoryId;
      draft._meta.categoryId = categoryId;
    }
    if (typeof offer.price === "number" && Number.isFinite(offer.price) && offer.price > 0) {
      const normalized = Math.round(offer.price * 100) / 100;
      draft.offer.price = normalized;
      draft._meta.price = normalized;
    }
    if (typeof offer.quantity === "number" && Number.isFinite(offer.quantity) && offer.quantity > 0) {
      draft.offer.quantity = Math.trunc(offer.quantity);
    }
    if (typeof offer.condition === "number" && Number.isFinite(offer.condition) && offer.condition > 0) {
      draft.offer.condition = offer.condition;
    }
    if (Object.prototype.hasOwnProperty.call(offer, "fulfillmentPolicyId")) {
      draft.offer.fulfillmentPolicyId = offer.fulfillmentPolicyId ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(offer, "paymentPolicyId")) {
      draft.offer.paymentPolicyId = offer.paymentPolicyId ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(offer, "returnPolicyId")) {
      draft.offer.returnPolicyId = offer.returnPolicyId ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(offer, "merchantLocationKey")) {
      draft.offer.merchantLocationKey = offer.merchantLocationKey ?? null;
    }
    if (description) {
      draft.offer.description = description;
    }
  }

  if (override._meta) {
    if (override._meta.selectedCategory) {
      draft._meta.selectedCategory = override._meta.selectedCategory as TaxonomyMappedDraft["_meta"]["selectedCategory"];
    }
    if (override._meta.missingRequired) {
      const missing = Array.isArray(override._meta.missingRequired)
        ? override._meta.missingRequired.map((entry) => String(entry)).filter(Boolean)
        : [];
      draft._meta.missingRequired = missing;
    }
  }

  return draft;
}

export async function mapGroupToDraft(group: Record<string, any>, opts?: MapOptions): Promise<TaxonomyMappedDraft> {
  const options = toOptions(opts);
  
  console.log('[mapGroupToDraft] Input group:', JSON.stringify({
    brand: group.brand,
    product: group.product,
    groupId: group.groupId,
    aspects: group.aspects,
    images: group.images,
    heroDisplayUrl: group.heroDisplayUrl,
    backDisplayUrl: group.backDisplayUrl,
    allKeys: Object.keys(group)
  }, null, 2));
  
  const base = await mapGroupToDraftWithTaxonomy(group, options.userId);
  
  console.log('[mapGroupToDraft] Base from taxonomy:', JSON.stringify({
    sku: base.sku,
    aspectsCount: Object.keys(base.inventory?.product?.aspects || {}).length,
    aspects: base.inventory?.product?.aspects,
    hasBrand: !!base.inventory?.product?.aspects?.Brand,
    imageUrls: base.inventory?.product?.imageUrls,
  }, null, 2));
  
  const groupIdRaw = group?.groupId ?? group?.id ?? null;
  const groupId = typeof groupIdRaw === "string" ? groupIdRaw.trim() : "";

  let draft: TaxonomyMappedDraft;
  if (!options.userId || !options.jobId || !groupId) {
    console.log('[mapGroupToDraft] No override - returning base');
    draft = base;
  } else {
    const override = await fetchOverride(options.userId, options.jobId, groupId);
    if (!override) {
      console.log('[mapGroupToDraft] No override found - returning base');
      draft = base;
    } else {
      console.log('[mapGroupToDraft] Applying override:', JSON.stringify(override, null, 2));
      draft = applyOverride(base, override);
      
      console.log('[mapGroupToDraft] Final result after override:', JSON.stringify({
        sku: draft.sku,
        aspectsCount: Object.keys(draft.inventory?.product?.aspects || {}).length,
        aspects: draft.inventory?.product?.aspects,
        hasBrand: !!draft.inventory?.product?.aspects?.Brand
      }, null, 2));
    }
  }

  // Proxy all images through image-proxy to handle EXIF rotation and normalization
  const imageUrls = draft.inventory?.product?.imageUrls;
  if (imageUrls && Array.isArray(imageUrls) && imageUrls.length > 0) {
    const appUrl = process.env.APP_URL || process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL || "https://draftpilot-ai.netlify.app";
    const proxiedUrls = proxyImageUrls(imageUrls, appUrl);
    console.log('[mapGroupToDraft] Proxied images:', { original: imageUrls.length, proxied: proxiedUrls.length, appUrl, sample: proxiedUrls[0]?.substring(0, 100) });
    draft.inventory.product.imageUrls = proxiedUrls;
  }

  // GUARDRAIL: Fail fast if draft would publish with 0 images
  assertDraftHasImages(draft, groupId, group);
  
  return draft;
}

export type { TaxonomyMappedDraft } from "./taxonomy-map.js";
