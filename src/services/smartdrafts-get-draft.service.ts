/**
 * smartdrafts-get-draft.service.ts — Platform-agnostic service for fetching eBay offer details
 * in draft-edit format.
 *
 * Mirrors the business logic previously inlined in:
 *   netlify/functions/smartdrafts-get-draft.ts
 *
 * Fetches: offer + inventory item + category aspects metadata, then composes a
 * draft-like object for the front-end editor.
 *
 * No HTTP framework dependencies.
 */

import { getEbayClient, EbayNotConnectedError } from '../lib/ebay-client.js';
import { getDraftLogsByOfferId } from '../lib/draft-logs.js';

export { EbayNotConnectedError };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BestOfferSettings {
  enabled: boolean;
  autoDeclinePercent?: number;
  autoAcceptPercent?: number;
}

export interface GetDraftResult {
  ok: true;
  draft: {
    sku: string;
    title: string;
    description: string;
    price: string | number;
    quantity: number;
    condition: string;
    aspects: Record<string, string[]>;
    images: string[];
    categoryId: string;
    offerId: string;
    categoryAspects: unknown[];
    weight: unknown | null;
    bestOffer: BestOfferSettings;
    fulfillmentPolicyId: string | null;
    merchantData?: {
      pricingStatus?: string;
      needsPriceReview?: boolean;
      attentionReasons?: Array<{ code: string; message: string; severity?: string }>;
    };
  };
}

// ---------------------------------------------------------------------------
// getDraft
// ---------------------------------------------------------------------------

/**
 * Fetch an eBay offer and associated inventory + category aspects for editing.
 *
 * @param userId  The authenticated user ID.
 * @param offerId The eBay offer ID to fetch.
 * @throws {EbayNotConnectedError} if user has no eBay credentials.
 * @throws if eBay API returns a non-2xx status.
 */
export async function getDraft(userId: string, offerId: string): Promise<GetDraftResult> {
  const { apiHost, headers: ebayHeaders } = await getEbayClient(userId);

  // Fetch offer
  const offerRes = await fetch(`${apiHost}/sell/inventory/v1/offer/${offerId}`, {
    headers: ebayHeaders,
  });

  if (!offerRes.ok) {
    const errorText = await offerRes.text();
    const err = new Error(`Failed to fetch offer from eBay: ${offerRes.status}`);
    (err as any).statusCode = offerRes.status;
    (err as any).detail = errorText.substring(0, 500);
    throw err;
  }

  const offer = await offerRes.json() as Record<string, any>;

  // Fetch inventory item for product details
  const sku: string = offer.sku ?? '';
  let inventory: Record<string, any> = {};
  if (sku) {
    const invRes = await fetch(
      `${apiHost}/sell/inventory/v1/inventory_item/${sku}`,
      { headers: ebayHeaders },
    );
    if (invRes.ok) {
      inventory = await invRes.json() as Record<string, any>;
    }
  }

  // Fetch category aspects metadata (optional)
  let categoryAspects: unknown[] = [];
  if (offer.categoryId) {
    try {
      const catRes = await fetch(
        `${apiHost}/commerce/taxonomy/v1/category_tree/0/get_item_aspects_for_category?category_id=${offer.categoryId}`,
        { headers: ebayHeaders },
      );
      if (catRes.ok) {
        const catJson = await catRes.json() as { aspects?: unknown[] };
        categoryAspects = catJson?.aspects ?? [];
      }
    } catch {
      // Non-fatal — category aspects are informational
    }
  }

  // Extract Best Offer settings
  const bestOfferTerms = offer.listingPolicies?.bestOfferTerms;
  const offerPrice = parseFloat(String(offer.pricingSummary?.price?.value ?? 0));
  let bestOffer: BestOfferSettings;
  if (bestOfferTerms?.bestOfferEnabled) {
    bestOffer = {
      enabled: true,
      autoDeclinePercent:
        bestOfferTerms.autoDeclinePrice?.value && offerPrice > 0
          ? Math.round((parseFloat(bestOfferTerms.autoDeclinePrice.value) / offerPrice) * 100)
          : 60,
      autoAcceptPercent:
        bestOfferTerms.autoAcceptPrice?.value && offerPrice > 0
          ? Math.round((parseFloat(bestOfferTerms.autoAcceptPrice.value) / offerPrice) * 100)
          : 90,
    };
  } else {
    bestOffer = { enabled: false };
  }

  // Enrich merchantData from Redis so the edit page can show the NEEDS_REVIEW confirm row.
  // Fall back to whatever eBay returned in the raw offer (e.g. after a manual MANUAL_CONFIRMED write).
  let merchantData: GetDraftResult['draft']['merchantData'] =
    offer.merchantData ? { ...(offer.merchantData as object) } : undefined;

  try {
    const resolvedOfferId: string = (offer.offerId ?? offerId) as string;
    const logs = await getDraftLogsByOfferId(userId, resolvedOfferId);
    if (logs?.pricingStatus && logs.pricingStatus !== 'OK' && logs.pricingStatus !== 'MANUAL_CONFIRMED') {
      merchantData = {
        ...merchantData,
        pricingStatus: logs.pricingStatus,
        needsPriceReview: true,
        ...(logs.attentionReasons?.length ? { attentionReasons: logs.attentionReasons } : {}),
      };
    }
  } catch {
    // Non-fatal — merchantData enrichment is best-effort
  }

  const draft = {
    sku,
    title: (inventory.product?.title ?? offer.title ?? '') as string,
    description: (inventory.product?.description ?? offer.listingDescription ?? '') as string,
    price: offer.pricingSummary?.price?.value ?? 0,
    quantity: (inventory.availability?.shipToLocationAvailability?.quantity ?? offer.availableQuantity ?? 1) as number,
    condition: (inventory.condition ?? offer.condition ?? 'NEW') as string,
    aspects: (inventory.product?.aspects ?? {}) as Record<string, string[]>,
    images: (inventory.product?.imageUrls ?? []) as string[],
    categoryId: (offer.categoryId ?? '') as string,
    offerId: (offer.offerId ?? offerId) as string,
    categoryAspects,
    weight: (inventory.packageWeightAndSize?.weight ?? null) as unknown,
    bestOffer,
    fulfillmentPolicyId: (offer.listingPolicies?.fulfillmentPolicyId ?? null) as string | null,
    ...(merchantData ? { merchantData } : {}),
  };

  return { ok: true, draft };
}
