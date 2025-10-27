import { mapGroupToDraftWithTaxonomy, type TaxonomyMappedDraft } from "./taxonomy-map.js";
import { k } from "./user-keys.js";

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
  const base = await mapGroupToDraftWithTaxonomy(group);
  const groupIdRaw = group?.groupId ?? group?.id ?? null;
  const groupId = typeof groupIdRaw === "string" ? groupIdRaw.trim() : "";

  if (!options.userId || !options.jobId || !groupId) {
    return base;
  }

  const override = await fetchOverride(options.userId, options.jobId, groupId);
  if (!override) {
    return base;
  }

  return applyOverride(base, override);
}

export type { TaxonomyMappedDraft } from "./taxonomy-map.js";
