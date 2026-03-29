/**
 * packages/core/src/services/smartdrafts/update-draft.ts
 *
 * Update an eBay draft (offer + inventory item) with edited draft data.
 */

import { getEbayClient, EbayNotConnectedError } from '../../../../../src/lib/ebay-client.js';
import { confirmDraftPriceReview } from '../../../../../src/lib/draft-logs.js';

export { EbayNotConnectedError };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BestOfferSettings = {
  enabled: boolean;
  autoDeclinePercent?: number;
  autoAcceptPercent?: number;
};

export type DraftUpdate = {
  title: string;
  description?: string;
  price: number;
  quantity?: number;
  condition?: string;
  aspects?: Record<string, string | string[]>;
  images?: string[];
  promotion?: { enabled: boolean; rate?: number | null };
  bestOffer?: BestOfferSettings;
  weight?: { value: number; unit?: string };
  /** Override the fulfillment (shipping) policy for this offer. */
  fulfillmentPolicyId?: string | null;
  /**
   * When true, clears the NEEDS_REVIEW pricing gate — the user has manually
   * verified and confirmed the price. Sets pricingStatus to 'MANUAL_CONFIRMED'
   * so the Publish button becomes available again on the drafts list.
   */
  confirmPriceReview?: boolean;
};

export class InvalidDraftError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDraftError';
  }
}

export class EbayApiError extends Error {
  readonly statusCode: number;
  readonly body: string;
  constructor(message: string, statusCode: number, body: string) {
    super(message);
    this.name = 'EbayApiError';
    this.statusCode = statusCode;
    this.body = body;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizeAspects(
  aspects: Record<string, string | string[]>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, val] of Object.entries(aspects)) {
    const arr = Array.isArray(val) ? val : [val];
    // eBay Flavor aspect only accepts single value
    if (key.toLowerCase() === 'flavor' && arr.length > 1) {
      out[key] = [arr[0]];
    } else {
      out[key] = arr;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Update an eBay inventory item + offer with new draft data.
 *
 * @throws {EbayNotConnectedError} — user has no eBay token
 * @throws {InvalidDraftError}    — validation failure
 * @throws {EbayApiError}         — eBay API returned non-OK
 */
export async function updateDraft(
  userId: string,
  offerId: string,
  draft: DraftUpdate,
): Promise<{ ok: true }> {
  // ── Validation ──────────────────────────────────────────────────────────
  if (!draft.title || draft.title.length > 80) {
    throw new InvalidDraftError('Title is required and must be ≤ 80 characters');
  }
  if (!draft.price || draft.price <= 0) {
    throw new InvalidDraftError('price must be > 0');
  }

  const imageUrls: string[] = draft.images ?? [];
  const dataUrls = imageUrls.filter((u) => u.startsWith('data:'));
  if (dataUrls.length > 0) {
    throw new InvalidDraftError(
      `${dataUrls.length} image(s) are invalid — base64 data URLs not supported by eBay`,
    );
  }

  // ── eBay auth ────────────────────────────────────────────────────────────
  const client = await getEbayClient(userId);
  const MARKETPLACE_ID = process.env.DEFAULT_MARKETPLACE_ID || process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';
  const ebayHeaders = {
    ...client.headers,
    'Content-Type': 'application/json',
    'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID,
  };

  // ── Fetch current offer ──────────────────────────────────────────────────
  const offerRes = await fetch(`${client.apiHost}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, {
    headers: ebayHeaders,
  });
  if (!offerRes.ok) {
    const text = await offerRes.text().catch(() => '');
    throw new EbayApiError(`Failed to fetch offer ${offerId}`, offerRes.status, text);
  }
  const currentOffer = await offerRes.json() as Record<string, unknown>;
  const sku = currentOffer.sku as string | undefined;

  // ── Update inventory item ────────────────────────────────────────────────
  if (sku) {
    const inventoryPayload: Record<string, unknown> = {
      product: {
        title: draft.title,
        description: draft.description ?? draft.title,
        aspects: draft.aspects ? sanitizeAspects(draft.aspects) : undefined,
        imageUrls:
          imageUrls.length > 0
            ? imageUrls
            : ((currentOffer.listing as any)?.imageUrls ?? []),
      },
      condition: draft.condition ?? 'NEW',
      availability: {
        shipToLocationAvailability: {
          quantity: draft.quantity ?? (currentOffer as any).availability?.shipToLocationAvailability?.quantity ?? (currentOffer as any).availableQuantity ?? 1,
        },
      },
    };

    if (draft.weight?.value && draft.weight.value > 0) {
      inventoryPayload.packageWeightAndSize = {
        weight: { value: draft.weight.value, unit: draft.weight.unit ?? 'OUNCE' },
      };
    }

    const invRes = await fetch(
      `${client.apiHost}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
      { method: 'PUT', headers: ebayHeaders, body: JSON.stringify(inventoryPayload) },
    );
    if (!invRes.ok) {
      const text = await invRes.text().catch(() => '');
      throw new EbayApiError('Failed to update inventory item', invRes.status, text);
    }
  }

  // ── Update offer ─────────────────────────────────────────────────────────
  const offerPayload: Record<string, unknown> = {
    ...currentOffer,
    pricingSummary: {
      price: {
        value: draft.price.toFixed(2),
        currency: (currentOffer.pricingSummary as any)?.price?.currency ?? 'USD',
      },
    },
    merchantData: {
      ...((currentOffer.merchantData as object) ?? {}),
      autoPromote: draft.promotion?.enabled ?? false,
      autoPromoteAdRate:
        draft.promotion?.enabled && draft.promotion?.rate ? draft.promotion.rate : null,
      // Confirm price clears the NEEDS_REVIEW gate — user has manually verified the price
      ...(draft.confirmPriceReview ? { pricingStatus: 'MANUAL_CONFIRMED' } : {}),
    },
  };

  if (draft.bestOffer !== undefined) {
    const existingPolicies = (currentOffer.listingPolicies ?? {}) as Record<string, unknown>;
    if (draft.bestOffer.enabled) {
      const bestOfferTerms: Record<string, unknown> = { bestOfferEnabled: true };
      if (draft.bestOffer.autoDeclinePercent) {
        bestOfferTerms.autoDeclinePrice = {
          currency: 'USD',
          value: ((draft.price * draft.bestOffer.autoDeclinePercent) / 100).toFixed(2),
        };
      }
      if (draft.bestOffer.autoAcceptPercent) {
        bestOfferTerms.autoAcceptPrice = {
          currency: 'USD',
          value: ((draft.price * draft.bestOffer.autoAcceptPercent) / 100).toFixed(2),
        };
      }
      offerPayload.listingPolicies = { ...existingPolicies, bestOfferTerms };
    } else {
      offerPayload.listingPolicies = {
        ...existingPolicies,
        bestOfferTerms: { bestOfferEnabled: false },
      };
    }
  }

  // Apply fulfillment policy override (applied after bestOffer so we merge correctly)
  if (draft.fulfillmentPolicyId !== undefined) {
    const currentPolicies = ((offerPayload.listingPolicies ?? currentOffer.listingPolicies) ?? {}) as Record<string, unknown>;
    offerPayload.listingPolicies = {
      ...currentPolicies,
      fulfillmentPolicyId: draft.fulfillmentPolicyId,
    };
  }

  const updateRes = await fetch(
    `${client.apiHost}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`,
    { method: 'PUT', headers: ebayHeaders, body: JSON.stringify(offerPayload) },
  );
  if (!updateRes.ok) {
    const text = await updateRes.text().catch(() => '');
    throw new EbayApiError('Failed to update offer', updateRes.status, text);
  }

  // Clear the NEEDS_REVIEW gate in Redis so enrichWithDraftLogsMeta no longer
  // re-applies NEEDS_REVIEW on subsequent list/detail loads.
  if (draft.confirmPriceReview) {
    await confirmDraftPriceReview(userId, offerId).catch(() => { /* non-fatal */ });
  }

  return { ok: true };
}
