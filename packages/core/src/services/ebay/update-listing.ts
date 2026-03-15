/**
 * packages/core/src/services/ebay/update-listing.ts
 *
 * Update an active eBay listing.
 *
 * Supports two paths:
 *   - Inventory API path (isInventoryListing=true, sku provided)
 *   - Trading API / ReviseItem path (legacy, non-inventory listings)
 */

import { getEbayClient, EbayNotConnectedError } from '../../../../../src/lib/ebay-client.js';

export { EbayNotConnectedError };

export class UpdateListingError extends Error {
  readonly statusCode: number;
  readonly detail?: string;
  constructor(message: string, statusCode: number, detail?: string) {
    super(message);
    this.name = 'UpdateListingError';
    this.statusCode = statusCode;
    this.detail = detail;
  }
}

export type UpdateListingInput = {
  itemId: string;
  /** SKU — required for inventory-API path */
  sku?: string;
  isInventoryListing?: boolean;
  title?: string;
  description?: string;
  price?: number;
  quantity?: number;
  condition?: string;
  aspects?: Record<string, string | string[]>;
  images?: string[];
  bestOffer?: {
    enabled: boolean;
    autoDeclinePercent?: number;
    autoAcceptPercent?: number;
  };
  /** Override the fulfillment (shipping) policy for this offer. */
  fulfillmentPolicyId?: string | null;
};

export type UpdateListingResult = {
  ok: true;
  itemId: string;
  method: 'inventory' | 'trading';
  published?: boolean;
  warning?: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const CONDITION_MAP: Record<string, string> = {
  '1000': 'NEW',
  '1500': 'NEW_OTHER',
  '1750': 'NEW_WITH_DEFECTS',
  '2000': 'MANUFACTURER_REFURBISHED',
  '2500': 'SELLER_REFURBISHED',
  '3000': 'USED_EXCELLENT',
  '4000': 'USED_VERY_GOOD',
  '5000': 'USED_GOOD',
  '6000': 'USED_ACCEPTABLE',
  '7000': 'FOR_PARTS_OR_NOT_WORKING',
};

// ---------------------------------------------------------------------------
// Inventory API path
// ---------------------------------------------------------------------------

async function updateViaInventoryApi(
  access_token: string,
  apiHost: string,
  input: UpdateListingInput,
): Promise<UpdateListingResult> {
  const { itemId, sku, title, description, price, quantity, condition, aspects, images, bestOffer } = input;
  const MARKETPLACE_ID = process.env.DEFAULT_MARKETPLACE_ID || process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';

  const ebayHeaders: Record<string, string> = {
    Authorization: `Bearer ${access_token}`,
    'Content-Type': 'application/json',
    'Accept-Language': 'en-US',
    'Content-Language': 'en-US',
  };

  const sku_ = sku!;

  // Update inventory item
  if (title || description || images || aspects || condition) {
    const getItemRes = await fetch(
      `${apiHost}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku_)}`,
      { headers: ebayHeaders },
    );
    if (!getItemRes.ok) {
      const text = await getItemRes.text();
      throw new UpdateListingError('Failed to get inventory item', getItemRes.status, text);
    }
    const existingItem = await getItemRes.json() as Record<string, unknown>;

    const invPayload: Record<string, unknown> = {
      ...existingItem,
      product: {
        ...((existingItem.product as object) ?? {}),
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
        ...(images?.length ? { imageUrls: images } : {}),
        ...(aspects
          ? {
              aspects: Object.fromEntries(
                Object.entries(aspects).map(([k, v]) => [k, Array.isArray(v) ? v : [v]]),
              ),
            }
          : {}),
      },
    };

    // Ensure default weight exists; strip eBay's 1×1×1 placeholder dimensions
    const ws = (invPayload as any).packageWeightAndSize ?? {};
    const wt = ws.weight ?? {};
    const dims = ws.dimensions;
    // eBay returns {length:1, width:1, height:1, unit:"INCH"} as a placeholder when no real
    // dimensions have been set. Re-sending this every PUT would lock the listing to 1×1×1.
    // Strip it so eBay keeps whatever value it already has (or uses its own default).
    const isPlaceholderDims =
      dims && dims.length === 1 && dims.width === 1 && dims.height === 1;
    const { dimensions: _ignoredDims, ...wsWithoutDims } = ws;
    invPayload.packageWeightAndSize = {
      ...(isPlaceholderDims ? wsWithoutDims : ws),
      weight: { value: wt.value && wt.value > 0 ? wt.value : 1, unit: wt.unit ?? 'POUND' },
    };

    if (condition && CONDITION_MAP[condition]) {
      invPayload.condition = CONDITION_MAP[condition];
    }

    const updateItemRes = await fetch(
      `${apiHost}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku_)}`,
      { method: 'PUT', headers: ebayHeaders, body: JSON.stringify(invPayload) },
    );
    if (!updateItemRes.ok) {
      const text = await updateItemRes.text();
      throw new UpdateListingError('Failed to update inventory item', updateItemRes.status, text);
    }
  }

  // Find current offer
  const getOfferRes = await fetch(
    `${apiHost}/sell/inventory/v1/offer?sku=${encodeURIComponent(sku_)}&marketplace_id=${MARKETPLACE_ID}`,
    { headers: ebayHeaders },
  );
  if (!getOfferRes.ok) {
    const text = await getOfferRes.text();
    throw new UpdateListingError('Failed to get offer details', getOfferRes.status, text);
  }
  const offersData = await getOfferRes.json() as { offers?: any[] };
  const offer = offersData.offers?.[0];
  if (!offer?.offerId) {
    return { ok: true, itemId, method: 'inventory', warning: 'No offer found to republish' };
  }

  // Update offer
  const { listing: _, offerId: __, ...offerBase } = offer;
  const offerPayload: Record<string, unknown> = { ...offerBase };

  if (description) offerPayload.listingDescription = description;
  if (price !== undefined) {
    offerPayload.pricingSummary = {
      ...((offerBase.pricingSummary as object) ?? {}),
      price: { value: String(price), currency: 'USD' },
    };
  }
  if (quantity !== undefined) offerPayload.availableQuantity = quantity;

  if (bestOffer !== undefined) {
    const existingPolicies = (offerBase.listingPolicies as object) ?? {};
    if (bestOffer.enabled) {
      const p = price ?? parseFloat((offer.pricingSummary?.price?.value) || '0');
      const terms: Record<string, unknown> = { bestOfferEnabled: true };
      if (bestOffer.autoDeclinePercent) {
        terms.autoDeclinePrice = { currency: 'USD', value: ((p * bestOffer.autoDeclinePercent) / 100).toFixed(2) };
      }
      if (bestOffer.autoAcceptPercent) {
        terms.autoAcceptPrice = { currency: 'USD', value: ((p * bestOffer.autoAcceptPercent) / 100).toFixed(2) };
      }
      offerPayload.listingPolicies = { ...existingPolicies, bestOfferTerms: terms };
    } else {
      offerPayload.listingPolicies = { ...existingPolicies, bestOfferTerms: { bestOfferEnabled: false } };
    }
  }

  // Apply fulfillment policy override (after bestOffer so we merge correctly)
  if (input.fulfillmentPolicyId !== undefined) {
    const currentPolicies = ((offerPayload.listingPolicies ?? offerBase.listingPolicies) ?? {}) as Record<string, unknown>;
    // Drop per-offer shippingCostOverrides from listingPolicies (in case eBay stores them there)
    // so the new fulfillment policy's shipping terms take effect cleanly.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { shippingCostOverrides: _droppedNested, ...policiesWithoutOverrides } = currentPolicies;
    offerPayload.listingPolicies = {
      ...policiesWithoutOverrides,
      fulfillmentPolicyId: input.fulfillmentPolicyId,
    };
    // Also clear top-level shippingCostOverrides on the offer; these override the
    // fulfillment policy's shipping cost and would prevent free-shipping from taking effect.
    delete offerPayload.shippingCostOverrides;
  }

  const updateOfferRes = await fetch(`${apiHost}/sell/inventory/v1/offer/${offer.offerId}`, {
    method: 'PUT',
    headers: ebayHeaders,
    body: JSON.stringify(offerPayload),
  });
  if (!updateOfferRes.ok) {
    const text = await updateOfferRes.text();
    throw new UpdateListingError('Failed to update offer', updateOfferRes.status, text);
  }

  // Republish
  const publishRes = await fetch(`${apiHost}/sell/inventory/v1/offer/${offer.offerId}/publish`, {
    method: 'POST',
    headers: ebayHeaders,
    body: JSON.stringify({}),
  });
  if (!publishRes.ok) {
    const text = await publishRes.text();
    throw new UpdateListingError('Failed to publish changes', publishRes.status, text);
  }

  return { ok: true, itemId, method: 'inventory', published: true };
}

// ---------------------------------------------------------------------------
// Trading API path (legacy)
// ---------------------------------------------------------------------------

async function updateViaTradingApi(
  access_token: string,
  input: UpdateListingInput,
): Promise<UpdateListingResult> {
  const { itemId, title, description, price, quantity, condition, aspects, images } = input;

  let itemSpecificsXml = '';
  if (aspects) {
    const nvl = Object.entries(aspects)
      .filter(([, v]) => {
        const arr = Array.isArray(v) ? v : [v];
        return arr.length > 0;
      })
      .map(([name, v]) => {
        const arr = Array.isArray(v) ? v : [v];
        const vals = arr.map((x) => `<Value>${escapeXml(String(x))}</Value>`).join('');
        return `<NameValueList><Name>${escapeXml(name)}</Name>${vals}</NameValueList>`;
      })
      .join('');
    if (nvl) itemSpecificsXml = `<ItemSpecifics>${nvl}</ItemSpecifics>`;
  }

  let pictureXml = '';
  if (images?.length) {
    const urls = images.map((u) => `<PictureURL>${escapeXml(u)}</PictureURL>`).join('');
    pictureXml = `<PictureDetails>${urls}</PictureDetails>`;
  }

  const xmlRequest = `<?xml version="1.0" encoding="utf-8"?>
<ReviseItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${access_token}</eBayAuthToken></RequesterCredentials>
  <Item>
    <ItemID>${itemId}</ItemID>
    ${title ? `<Title>${escapeXml(title)}</Title>` : ''}
    ${description ? `<Description><![CDATA[${description}]]></Description>` : ''}
    ${price !== undefined ? `<StartPrice>${price}</StartPrice>` : ''}
    ${quantity !== undefined ? `<Quantity>${quantity}</Quantity>` : ''}
    ${condition ? `<ConditionID>${condition}</ConditionID>` : ''}
    ${itemSpecificsXml}
    ${pictureXml}
  </Item>
</ReviseItemRequest>`;

  const res = await fetch('https://api.ebay.com/ws/api.dll', {
    method: 'POST',
    headers: {
      'X-EBAY-API-COMPATIBILITY-LEVEL': '1193',
      'X-EBAY-API-CALL-NAME': 'ReviseItem',
      'X-EBAY-API-SITEID': '0',
      'Content-Type': 'text/xml; charset=utf-8',
    },
    body: xmlRequest,
  });

  const xmlText = await res.text();
  if (xmlText.includes('<Ack>Failure</Ack>') || xmlText.includes('<Ack>PartialFailure</Ack>')) {
    const m = xmlText.match(/<LongMessage>([^<]+)<\/LongMessage>/);
    throw new UpdateListingError(m ? m[1] : 'ReviseItem failed', 400, xmlText.slice(0, 500));
  }

  return { ok: true, itemId, method: 'trading' };
}

// ---------------------------------------------------------------------------
// Public service function
// ---------------------------------------------------------------------------

/**
 * Update an active eBay listing (inventory or Trading API path).
 *
 * @throws {EbayNotConnectedError} — user has no eBay token
 * @throws {UpdateListingError}    — eBay API update failure
 */
export async function updateActiveListing(
  userId: string,
  input: UpdateListingInput,
): Promise<UpdateListingResult> {
  if (!input.itemId) throw new UpdateListingError('Missing itemId', 400);

  const client = await getEbayClient(userId);
  const { access_token, apiHost } = client;

  // Decide path: inventory if SKU provided AND not a placeholder
  const isInventory =
    input.isInventoryListing !== false &&
    !!input.sku &&
    !input.sku.includes('SKU123456789') &&
    input.sku.trim().length > 0;

  if (isInventory) {
    return updateViaInventoryApi(access_token, apiHost, input);
  }

  return updateViaTradingApi(access_token, input);
}
