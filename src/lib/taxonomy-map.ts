import { buildItemSpecifics } from "./taxonomy-autofill.js";
import type { CategoryDef } from "./taxonomy-schema.js";
import { pickCategoryForGroup } from "./taxonomy-select.js";

const MAX_TITLE_LENGTH = 80;
const DEFAULT_MARKETPLACE = process.env.DEFAULT_MARKETPLACE_ID || "EBAY_US";
const DEFAULT_CATEGORY = process.env.DEFAULT_CATEGORY_ID || "180959";
const DEFAULT_CONDITION = "NEW";

function sanitizeSku(value: string): string {
  return value.replace(/[^a-z0-9]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "sku";
}

function generateSku(group: Record<string, any>): string {
  const base = [group?.brand, group?.product]
    .filter((part) => typeof part === "string" && part.trim())
    .join("-");
  const fallback = group?.groupId || group?.id || Date.now().toString(36);
  return sanitizeSku([base, fallback].filter(Boolean).join("-"));
}

function buildTitle(group: Record<string, any>): string {
  const parts = [group?.brand, group?.product, group?.variant, group?.size]
    .filter((part) => typeof part === "string" && part.trim())
    .map((part) => part.trim());
  const title = parts.join(" ").replace(/\s+/g, " ").trim();
  return title.slice(0, MAX_TITLE_LENGTH);
}

function ensureImages(group: Record<string, any>): string[] {
  const img = Array.isArray(group?.images) ? group.images : [];
  const urls = img
    .filter((url) => typeof url === "string" && url.trim())
    .map((url) => url.trim());
  if (!urls.length) throw new Error("Group missing image URLs");
  return urls.slice(0, 12);
}

function extractPrice(group: Record<string, any>): number {
  const price = Number(group?.pricing?.ebay ?? group?.price ?? 0);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("Group missing eBay price");
  }
  return Math.round(price * 100) / 100;
}

function deriveQuantity(group: Record<string, any>, category: CategoryDef | null): number {
  const raw = Number(group?.quantity ?? group?.qty ?? category?.defaults?.quantity ?? 1);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 1;
}

function conditionStringToCode(value: string): number | undefined {
  switch (value.toUpperCase()) {
    case "NEW":
      return 1000;
    case "LIKE_NEW":
    case "NEW_OTHER":
    case "NEW OTHER":
      return 1500;
    case "USED":
      return 3000;
    case "MANUFACTURER_REFURBISHED":
      return 2000;
    case "SELLER_REFURBISHED":
      return 2500;
    case "FOR_PARTS_OR_NOT_WORKING":
      return 7000;
    default:
      return undefined;
  }
}

function buildDescription(title: string, group: Record<string, any>): string {
  const lines: string[] = [title];
  if (group?.variant) lines.push(`Variant: ${group.variant}`);
  if (group?.size) lines.push(`Size: ${group.size}`);

  if (Array.isArray(group?.claims) && group.claims.length) {
    lines.push("", "Key Features:");
    group.claims.slice(0, 8).forEach((claim: unknown) => {
      if (typeof claim === "string" && claim.trim()) {
        lines.push(`• ${claim.trim()}`);
      }
    });
  }

  return lines.join("\n").slice(0, 7000);
}

export async function mapGroupToDraftWithTaxonomy(group: Record<string, any>) {
  if (!group) throw new Error("Invalid group payload");

  const price = extractPrice(group);
  const title = buildTitle(group);
  if (!title) throw new Error("Unable to derive title");

  const images = ensureImages(group);
  const sku = generateSku(group);

  const matched = await pickCategoryForGroup(group);
  const categoryId = matched?.id || DEFAULT_CATEGORY;
  const marketplaceId = matched?.marketplaceId || DEFAULT_MARKETPLACE;
  const condition = (matched?.defaults?.condition || group?.condition || DEFAULT_CONDITION).toString();
  const offerCondition = conditionStringToCode(condition) ?? 1000;
  const quantity = deriveQuantity(group, matched);
  const aspects = matched ? buildItemSpecifics(matched, group) : {};
  const description = buildDescription(title, group);

  const fulfillmentPolicyId = matched?.defaults?.fulfillmentPolicyId || process.env.EBAY_FULFILLMENT_POLICY_ID || null;
  const paymentPolicyId = matched?.defaults?.paymentPolicyId || process.env.EBAY_PAYMENT_POLICY_ID || null;
  const returnPolicyId = matched?.defaults?.returnPolicyId || process.env.EBAY_RETURN_POLICY_ID || null;
  const merchantLocationKey = process.env.EBAY_MERCHANT_LOCATION_KEY || null;

  return {
    inventory: {
      condition,
      product: {
        title,
        description,
        imageUrls: images,
        aspects,
      },
    },
    offer: {
      sku,
      marketplaceId,
      categoryId,
      price,
      quantity,
      condition: offerCondition,
      fulfillmentPolicyId,
      paymentPolicyId,
      returnPolicyId,
      merchantLocationKey,
      description,
    },
  };
}
