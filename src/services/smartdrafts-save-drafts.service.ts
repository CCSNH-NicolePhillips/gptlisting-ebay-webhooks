/**
 * smartdrafts-save-drafts.service.ts — Platform-agnostic service for converting
 * ChatGPT-generated drafts into eBay draft format.
 *
 * Mirrors the business logic previously inlined in:
 *   netlify/functions/smartdrafts-save-drafts.ts
 *
 * Pure transformation — no external API calls, no authentication required.
 */

const DEFAULT_MARKETPLACE = process.env.DEFAULT_MARKETPLACE_ID || 'EBAY_US';
const DEFAULT_CATEGORY = process.env.DEFAULT_CATEGORY_ID || '11116';
const DEFAULT_QUANTITY = 1;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatGptDraft {
  productId: string;
  brand: string;
  product: string;
  title: string;
  description: string;
  bullets: string[];
  aspects: Record<string, string[]>;
  category: { id: string; title: string };
  images: string[];
  price: number;
  condition: string;
  weight?: { value: number; unit: string } | null;
  promotion?: { enabled: boolean; rate: number | null };
}

export interface SaveDraftsInput {
  jobId: string;
  drafts: ChatGptDraft[];
}

export interface EbayDraftGroup {
  sku: string;
  inventory: Record<string, unknown>;
  offer: Record<string, unknown>;
  _meta: Record<string, unknown>;
  promotion: { enabled: boolean; rate: number | null };
}

export interface SaveDraftsResult {
  ok: true;
  groups: EbayDraftGroup[];
  count: number;
  jobId: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function conditionStringToCode(value: string): number {
  const upper = value.toUpperCase().trim();
  if (upper === 'NEW') return 1000;
  if (upper === 'LIKE_NEW') return 1500;
  if (upper === 'USED_EXCELLENT' || upper === 'EXCELLENT') return 2000;
  if (upper === 'USED_GOOD' || upper === 'GOOD') return 2500;
  if (upper === 'USED_ACCEPTABLE' || upper === 'ACCEPTABLE') return 3000;
  return 1000;
}

function generateSku(draft: ChatGptDraft, index: number): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 7);
  const prefix = (draft.brand?.substring(0, 3) || 'ITM')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase();
  return `${prefix}${timestamp}${random}${index}`.substring(0, 50);
}

function formatDescription(draft: ChatGptDraft): string {
  let desc = draft.description;
  if (draft.bullets?.length > 0) {
    desc += '\n\nFeatures:\n';
    draft.bullets.forEach(b => { desc += `• ${b}\n`; });
  }
  return desc.trim();
}

function convertToEbayDraft(draft: ChatGptDraft, index: number): EbayDraftGroup {
  const sku = generateSku(draft, index);
  const categoryId = draft.category?.id || DEFAULT_CATEGORY;
  const marketplaceId = DEFAULT_MARKETPLACE;
  const conditionStr = draft.condition || 'NEW';
  const conditionCode = conditionStringToCode(conditionStr);
  const description = formatDescription(draft);

  const inventory: Record<string, unknown> = {
    condition: conditionStr,
    product: {
      title: draft.title,
      description,
      imageUrls: draft.images,
      aspects: draft.aspects,
    },
  };

  if (draft.weight?.value && draft.weight.value > 0) {
    inventory.packageWeightAndSize = {
      weight: { value: draft.weight.value, unit: draft.weight.unit || 'OUNCE' },
    };
  }

  return {
    sku,
    inventory,
    offer: {
      sku,
      marketplaceId,
      categoryId,
      price: draft.price,
      quantity: DEFAULT_QUANTITY,
      condition: conditionCode,
      fulfillmentPolicyId: process.env.EBAY_FULFILLMENT_POLICY_ID ?? null,
      paymentPolicyId: process.env.EBAY_PAYMENT_POLICY_ID ?? null,
      returnPolicyId: process.env.EBAY_RETURN_POLICY_ID ?? null,
      merchantLocationKey: process.env.EBAY_MERCHANT_LOCATION_KEY ?? null,
      description,
    },
    _meta: {
      selectedCategory: draft.category?.id
        ? {
            id: draft.category.id,
            slug: draft.category.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
            title: draft.category.title,
          }
        : null,
      missingRequired: [],
      marketplaceId,
      categoryId,
      price: draft.price,
      source: 'smartdrafts-chatgpt',
      productId: draft.productId,
    },
    promotion: draft.promotion ?? { enabled: false, rate: null },
  };
}

// ---------------------------------------------------------------------------
// saveDrafts
// ---------------------------------------------------------------------------

/**
 * Convert ChatGPT-generated drafts to eBay draft format.
 *
 * Pure transformation — no side effects.
 */
export function saveDrafts(input: SaveDraftsInput): SaveDraftsResult {
  const groups = input.drafts.map((draft, index) => convertToEbayDraft(draft, index));
  return {
    ok: true,
    groups,
    count: groups.length,
    jobId: input.jobId,
  };
}
