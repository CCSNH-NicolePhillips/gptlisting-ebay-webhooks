/**
 * ebay-listings.service.ts — Platform-agnostic service for eBay live-listing operations.
 *
 * Mirrors the business logic previously inlined in:
 *   netlify/functions/ebay-end-listing.ts
 */

import { getEbayClient } from '../lib/ebay-client.js';
import { EbayApiError } from './ebay-offers.service.js';

// ---------------------------------------------------------------------------
// endListing
// ---------------------------------------------------------------------------

export interface EndListingParams {
  /**
   * eBay item ID (legacy Trading API identifier, e.g. "123456789012").
   * Required when `isInventoryListing` is false.
   */
  itemId?: string;
  /**
   * Inventory item SKU.
   * Required when `isInventoryListing` is true and `deleteInventoryItem` is true.
   */
  sku?: string;
  /**
   * eBay offer ID (Inventory API identifier).
   * Required when `isInventoryListing` is true.
   */
  offerId?: string;
  /**
   * True to use the Inventory API path (delete offer + optionally inventory item).
   * False to use the Trading API EndFixedPriceItem SOAP call.
   */
  isInventoryListing?: boolean;
  /**
   * When using the Inventory API path, also delete the underlying inventory item.
   * @default true
   */
  deleteInventoryItem?: boolean;
  /**
   * Trading API ending reason.
   * @default "NotAvailable"
   */
  reason?: string;
}

export interface EndListingResult {
  ok: true;
  itemId?: string;
  method: 'inventory-api' | 'trading-api';
  note?: string;
}

const VALID_REASONS = [
  'NotAvailable',
  'Incorrect',
  'LostOrBroken',
  'OtherListingError',
  'SellToHighBidder',
];

/**
 * End (remove) an eBay listing.
 *
 * Handles two paths:
 *  - **Inventory API**: DELETE offer + optional DELETE inventory item
 *  - **Trading API**: `EndFixedPriceItem` SOAP call (handles error 1047 gracefully)
 */
export async function endListing(
  userId: string,
  params: EndListingParams,
): Promise<EndListingResult> {
  const {
    itemId,
    sku,
    offerId,
    isInventoryListing = false,
    deleteInventoryItem = true,
    reason = 'NotAvailable',
  } = params;

  const { access_token, apiHost, headers } = await getEbayClient(userId);

  // ── Inventory API path ──────────────────────────────────────────────────
  if (isInventoryListing && offerId) {
    const deleteOfferUrl = `${apiHost}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`;
    const deleteOfferRes = await fetch(deleteOfferUrl, {
      method: 'DELETE',
      headers,
    });

    if (!deleteOfferRes.ok && deleteOfferRes.status !== 404) {
      const errorText = await deleteOfferRes.text();
      throw new EbayApiError(deleteOfferRes.status, { raw: errorText });
    }

    // Optionally delete the inventory item
    if (deleteInventoryItem && sku) {
      const deleteItemUrl = `${apiHost}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`;
      const deleteItemRes = await fetch(deleteItemUrl, {
        method: 'DELETE',
        headers,
      });
      if (!deleteItemRes.ok && deleteItemRes.status !== 404) {
        // Offer is already deleted — warn but don't fail
        console.warn(
          '[endListing] Offer deleted but inventory item deletion failed:',
          deleteItemRes.status,
        );
      }
    }

    return { ok: true, itemId, method: 'inventory-api' };
  }

  // ── Trading API path ────────────────────────────────────────────────────
  const endingReason = VALID_REASONS.includes(reason) ? reason : 'NotAvailable';

  const xmlRequest = `<?xml version="1.0" encoding="utf-8"?>
<EndFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${access_token}</eBayAuthToken>
  </RequesterCredentials>
  <ItemID>${itemId}</ItemID>
  <EndingReason>${endingReason}</EndingReason>
</EndFixedPriceItemRequest>`;

  const tradingUrl = 'https://api.ebay.com/ws/api.dll';
  const res = await fetch(tradingUrl, {
    method: 'POST',
    headers: {
      'X-EBAY-API-COMPATIBILITY-LEVEL': '1193',
      'X-EBAY-API-CALL-NAME': 'EndFixedPriceItem',
      'X-EBAY-API-SITEID': '0',
      'Content-Type': 'text/xml; charset=utf-8',
    },
    body: xmlRequest,
  });

  const xmlText = await res.text();

  if (!res.ok || xmlText.includes('<Ack>Failure</Ack>')) {
    // Error 1047 = item already ended (treat as success)
    const errorCodeMatch = xmlText.match(/<ErrorCode>([^<]+)<\/ErrorCode>/);
    if (errorCodeMatch?.[1] === '1047') {
      return {
        ok: true,
        itemId,
        method: 'trading-api',
        note: 'Item was already ended',
      };
    }

    const longMsg = xmlText.match(/<LongMessage>([^<]+)<\/LongMessage>/)?.[1];
    const shortMsg = xmlText.match(/<ShortMessage>([^<]+)<\/ShortMessage>/)?.[1];
    const msg = longMsg ?? shortMsg ?? 'Failed to end listing';
    throw new EbayApiError(400, {
      error: msg,
      errorCode: errorCodeMatch?.[1],
      detail: xmlText.substring(0, 500),
    });
  }

  return { ok: true, itemId, method: 'trading-api' };
}
