import { buildItemSpecifics } from "./taxonomy-autofill.js";
import type { CategoryDef } from "./taxonomy-schema.js";
import { pickCategoryForGroup } from "./taxonomy-select.js";
import { computeEbayItemPriceCents } from "./pricing-compute.js";
import { getDefaultPricingSettings, type PricingSettings } from "./pricing-config.js";
import { tokensStore } from "./_blobs.js";

const MAX_TITLE_LENGTH = 80;
const DEFAULT_MARKETPLACE = process.env.DEFAULT_MARKETPLACE_ID || "EBAY_US";
const DEFAULT_CATEGORY = process.env.DEFAULT_CATEGORY_ID || "180959";
const DEFAULT_CONDITION = "NEW";

function sanitizeSku(value: string): string {
  // Remove all non-alphanumeric characters for eBay SKU compliance
  return value.replace(/[^a-z0-9]+/gi, "").slice(0, 50) || "sku";
}

function getInitials(text: string): string {
  if (!text) return "";
  // Split on spaces, underscores, and common separators
  const words = text.split(/[\s_\-&]+/).filter(w => w.trim());
  // Take first letter of each word, uppercase
  return words.map(w => w.charAt(0).toUpperCase()).join("");
}

function generateSku(group: Record<string, any>): string {
  const brandInitials = getInitials(group?.brand || "");
  const productInitials = getInitials(group?.product || "");
  
  // Add timestamp + random for uniqueness (alphanumeric only)
  const unique = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  
  // Format: BrandInitialsProductInitialsUniqueID (no special chars, alphanumeric only)
  const sku = brandInitials + productInitials + unique;
  
  return sanitizeSku(sku) || "sku" + unique;
}

function buildTitle(group: Record<string, any>): string {
  // Prefer GPT-generated title if available (for books and products with custom titles)
  if (group?.title && typeof group.title === "string" && group.title.trim()) {
    return group.title.trim().slice(0, MAX_TITLE_LENGTH);
  }
  
  // Fallback: build from brand, product, variant, size
  const parts = [group?.brand, group?.product, group?.variant, group?.size]
    .filter((part) => typeof part === "string" && part.trim())
    .map((part) => part.trim());
  const title = parts.join(" ").replace(/\s+/g, " ").trim();
  return title.slice(0, MAX_TITLE_LENGTH);
}

function normalizeImageUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    // Normalize common Dropbox share/viewer links to direct-content host
    const host = u.hostname.toLowerCase();
    if (host.endsWith("dropbox.com")) {
      u.hostname = "dl.dropboxusercontent.com";
      // Prefer raw=1 over dl=1 to avoid HTML landing pages
      u.searchParams.delete("dl");
      if (!u.searchParams.has("raw")) u.searchParams.set("raw", "1");
      return u.toString();
    }
    return u.toString();
  } catch {
    return null;
  }
}

function ensureImages(group: Record<string, any>): string[] {
  const img = Array.isArray(group?.images) ? group.images : [];
  const urls = img
    .filter((url) => typeof url === "string" && url.trim())
    .map((url) => url.trim())
    .map((url) => normalizeImageUrl(url))
    .filter((u): u is string => typeof u === "string" && !!u);
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
  // Use ChatGPT-generated description if available
  if (group?.description && typeof group.description === "string" && group.description.trim()) {
    console.log('[buildDescription] Using group.description:', group.description.slice(0, 100));
    return group.description.trim().slice(0, 7000);
  }

  // Fallback: build description from title + variant/size/claims
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

  console.log('[buildDescription] Built fallback description:', lines.join("\n").slice(0, 100));
  return lines.join("\n").slice(0, 7000);
}

export type TaxonomyMappedDraft = {
  sku: string;
  inventory: {
    condition: string;
    product: {
      title: string;
      description: string;
      imageUrls: string[];
      aspects: Record<string, string[]>;
    };
  };
  offer: {
    sku: string;
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
  };
  _meta: {
    selectedCategory: { id: string; slug: string; title: string } | null;
    missingRequired: string[];
    marketplaceId: string;
    categoryId: string;
    price: number;
  };
  // Promotion intent fields
  autoPromote?: boolean;        // default false
  autoPromoteAdRate?: number;   // default from promotion defaults, e.g. 5
};

export async function mapGroupToDraftWithTaxonomy(group: Record<string, any>, userId?: string): Promise<TaxonomyMappedDraft> {
  if (!group) throw new Error("Invalid group payload");

  const title = buildTitle(group);
  if (!title) throw new Error("Unable to derive title");

  const images = ensureImages(group);
  const sku = generateSku(group);

  // PHASE 3: Load user pricing settings
  let pricingSettings: PricingSettings = getDefaultPricingSettings();
  if (userId) {
    try {
      const store = tokensStore();
      const settingsKey = `users/${userId}/settings.json`;
      const settingsBlob = await store.get(settingsKey);
      if (settingsBlob) {
        const settingsData = JSON.parse(settingsBlob);
        if (settingsData.pricing) {
          pricingSettings = { ...pricingSettings, ...settingsData.pricing };
        }
      }
    } catch (settingsErr) {
      console.warn(`[taxonomy-map] Failed to load user settings, using defaults:`, settingsErr);
    }

    // Phase 3.5: Check default fulfillment policy for free shipping
    try {
      const store = tokensStore(); // Re-get store since it's out of scope from previous try block
      const { hasFreeShipping, extractShippingCost } = await import("./policy-helpers.js");
      const { getUserAccessToken, apiHost, headers: ebayHeaders } = await import("./_ebay.js");
      const { userScopedKey } = await import("./_auth.js");

      // Load policy defaults
      const policyDefaultsKey = userScopedKey(userId, 'policy-defaults.json');
      const policyDefaults = await store.get(policyDefaultsKey, { type: 'json' }) as any;

      if (policyDefaults?.fulfillment) {
        const fulfillmentPolicyId = policyDefaults.fulfillment;
        console.log(`[taxonomy-map] Checking fulfillment policy ${fulfillmentPolicyId} for free shipping...`);

        // Fetch the policy from eBay
        const token = await getUserAccessToken(userId);
        const host = apiHost();
        const h = ebayHeaders(token);
        const policyUrl = `${host}/sell/account/v1/fulfillment_policy/${encodeURIComponent(fulfillmentPolicyId)}`;
        const policyRes = await fetch(policyUrl, { headers: h });

        if (policyRes.ok) {
          const policy = await policyRes.json();

          if (hasFreeShipping(policy)) {
            pricingSettings.templateShippingEstimateCents = 0;
            console.log(`[taxonomy-map] ✓ Free shipping policy detected - setting templateShippingEstimateCents to 0`);
          } else {
            const extractedCost = extractShippingCost(policy);
            if (extractedCost !== null && extractedCost !== pricingSettings.templateShippingEstimateCents) {
              pricingSettings.templateShippingEstimateCents = extractedCost;
              console.log(`[taxonomy-map] ✓ Extracted shipping cost from policy: ${extractedCost} cents`);
            }
          }
        } else {
          console.warn(`[taxonomy-map] Failed to fetch fulfillment policy ${fulfillmentPolicyId}: ${policyRes.status}`);
        }
      }
    } catch (err) {
      console.warn(`[taxonomy-map] Failed to check fulfillment policy for free shipping:`, err);
    }
  }

  // PHASE 3: Extract Amazon pricing data from group
  const priceMeta = group.priceMeta as any;
  let amazonItemPriceCents = 0;
  let amazonShippingCents = 0;
  let amazonShippingAssumedZero = true;
  let price = 0;
  let pricingResult: any = null;
  let priceAlreadyComputed = false;

  // CRITICAL: If group.price exists AND group.priceMeta exists, this is a PUBLISH operation
  // The price was already computed during draft creation - use it as-is to avoid double pricing
  if (typeof group.price === 'number' && group.price > 0 && priceMeta) {
    price = group.price;
    priceAlreadyComputed = true;
    console.log(`[taxonomy-map] Using pre-computed price from draft: $${price.toFixed(2)} (skipping re-calculation)`);
  } else if (typeof group.price === 'number' && group.price > 0) {
    // CRITICAL: If group.price exists but no priceMeta, this is likely a PUBLISH with incomplete data
    // Use the price as-is (it's already been discounted) - DO NOT apply minItemPrice floor
    price = group.price;
    priceAlreadyComputed = true;
    console.log(`[taxonomy-map] Using pre-computed price (no priceMeta): $${price.toFixed(2)} (publish mode detected via price-only)`);
  } else {
    // Try to extract from priceMeta first (set by price-lookup.ts)
    if (priceMeta?.chosenSource && priceMeta?.basePrice) {
      amazonItemPriceCents = Math.round(priceMeta.basePrice * 100);
      
      // Check if shipping data is available in candidates
      const chosenCandidate = priceMeta.candidates?.find((c: any) => c.source === priceMeta.chosenSource);
      if (chosenCandidate && typeof chosenCandidate.shippingCents === 'number') {
        amazonShippingCents = chosenCandidate.shippingCents;
        amazonShippingAssumedZero = false;
      }
    } else {
      // Fallback: extract from legacy group.pricing.ebay only (NOT group.price)
      const legacyPrice = Number(group?.pricing?.ebay ?? 0);
      if (Number.isFinite(legacyPrice) && legacyPrice > 0) {
        amazonItemPriceCents = Math.round(legacyPrice * 100);
      } else {
        throw new Error("Group missing pricing data (no priceMeta, no price, and no legacy pricing.ebay)");
      }
    }

    // PHASE 3: Compute eBay offer price using Phase 2 function
    pricingResult = computeEbayItemPriceCents({
      amazonItemPriceCents,
      amazonShippingCents,
      settings: pricingSettings,
    });

    price = pricingResult.ebayItemPriceCents / 100; // Convert cents to dollars
  }

  // PHASE 3: Log PRICING_EVIDENCE (CRITICAL: Do not log tokens/PII)
  if (priceAlreadyComputed) {
    console.log(`[taxonomy-map] PRICING_EVIDENCE for SKU ${sku}: Using pre-computed price $${price.toFixed(2)} (publish mode, no re-calculation)`);
  } else {
    console.log(`[taxonomy-map] PRICING_EVIDENCE for SKU ${sku}:`, {
      sku,
      amazonItemPriceCents,
      amazonShippingCents,
      amazonShippingAssumedZero,
      discountPercent: pricingSettings.discountPercent,
      shippingStrategy: pricingSettings.shippingStrategy,
      templateShippingEstimateCents: pricingSettings.templateShippingEstimateCents,
      targetDeliveredTotalCents: pricingResult.targetDeliveredTotalCents,
      ebayItemPriceCents: pricingResult.ebayItemPriceCents,
      shippingSubsidyAppliedCents: pricingResult.evidence.shippingSubsidyAppliedCents,
      finalOfferPriceDollars: price,
    });
  }

  const matched = await pickCategoryForGroup(group);
  console.log('[mapGroupToDraftWithTaxonomy] pickCategoryForGroup result:', {
    matched: !!matched,
    categoryId: matched?.id,
    categoryTitle: matched?.title,
    hasItemSpecifics: !!matched?.itemSpecifics,
    itemSpecificsCount: matched?.itemSpecifics?.length || 0
  });
  
  const categoryId = matched?.id || DEFAULT_CATEGORY;
  const marketplaceId = matched?.marketplaceId || DEFAULT_MARKETPLACE;
  const condition = (matched?.defaults?.condition || group?.condition || DEFAULT_CONDITION).toString();
  
  // Get condition code, but validate against allowed conditions
  let offerCondition = conditionStringToCode(condition) ?? 1000;
  
  console.log(`[taxonomy-map] Condition mapping: input="${condition}" → code=${offerCondition} (categoryId=${categoryId})`);
  
  // If category has allowed conditions, ensure the selected condition is valid
  if (matched?.allowedConditions && matched.allowedConditions.length > 0) {
    const allowedIds = matched.allowedConditions.map(c => c.conditionId);
    const conditionStr = String(offerCondition);
    
    if (!allowedIds.includes(conditionStr)) {
      // Condition not allowed, try to find best fallback
      console.warn(`[taxonomy-map] Condition ${offerCondition} not allowed for category ${categoryId}. Allowed: ${allowedIds.join(', ')}`);
      
      // Priority fallback: NEW (1000) > USED (3000) > first allowed
      // Most supplements/new products should default to NEW if user specified it
      if (allowedIds.includes('1000')) {
        offerCondition = 1000;
      } else if (allowedIds.includes('3000')) {
        offerCondition = 3000;
      } else {
        offerCondition = parseInt(allowedIds[0], 10);
      }
      
      console.log(`[taxonomy-map] Using fallback condition: ${offerCondition}`);
    }
  } else {
    // No condition data available - use the condition we already determined from group/GPT
    // Don't override user/GPT selection with arbitrary defaults
    console.warn(`[taxonomy-map] Category ${categoryId} has no allowedConditions data. Using determined condition: ${offerCondition} (${condition})`);
  }
  
  const quantity = deriveQuantity(group, matched);
  console.log('[mapGroupToDraftWithTaxonomy] About to call buildItemSpecifics, matched =', !!matched);
  
  // Always call buildItemSpecifics to merge group aspects, even if category lookup fails
  // Pass a minimal CategoryDef if matched is null so the function can still process group.aspects
  const fallbackCategory: CategoryDef = {
    id: categoryId,
    title: '',
    slug: '',
    marketplaceId: DEFAULT_MARKETPLACE,
    itemSpecifics: [],
    version: 0,
    updatedAt: Date.now()
  };
  const aspects = buildItemSpecifics(matched || fallbackCategory, group);
  
  console.log('[mapGroupToDraftWithTaxonomy] buildItemSpecifics returned:', {
    aspectsCount: Object.keys(aspects).length,
    hasAspects: Object.keys(aspects).length > 0,
    hasBrand: !!aspects.Brand,
    aspectKeys: Object.keys(aspects)
  });
  const description = buildDescription(title, group);

  const fulfillmentPolicyId = matched?.defaults?.fulfillmentPolicyId || process.env.EBAY_FULFILLMENT_POLICY_ID || null;
  const paymentPolicyId = matched?.defaults?.paymentPolicyId || process.env.EBAY_PAYMENT_POLICY_ID || null;
  const returnPolicyId = matched?.defaults?.returnPolicyId || process.env.EBAY_RETURN_POLICY_ID || null;
  const merchantLocationKey = process.env.EBAY_MERCHANT_LOCATION_KEY || null;

  const missingRequired = Object.entries(aspects)
    .filter(([, values]) => Array.isArray(values) && values.length === 0)
    .map(([name]) => name);

  return {
    sku,
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
      // CRITICAL: Pricing is computed only here. Do not compute elsewhere. Guardrail test enforces this.
      price,
      quantity,
      condition: offerCondition,
      fulfillmentPolicyId,
      paymentPolicyId,
      returnPolicyId,
      merchantLocationKey,
      description,
    },
    _meta: {
      selectedCategory: matched ? { id: matched.id, slug: matched.slug, title: matched.title } : null,
      missingRequired,
      marketplaceId,
      categoryId,
      price,
    },
  };
}
