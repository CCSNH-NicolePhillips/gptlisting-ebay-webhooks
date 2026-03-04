/**
 * ebay-inventory.service.ts — Platform-agnostic service for eBay Inventory item operations.
 *
 * Mirrors the business logic previously inlined in:
 *   netlify/functions/ebay-get-inventory-item.ts
 *
 * No HTTP framework dependencies.
 */

import { getEbayClient, EbayNotConnectedError } from '../lib/ebay-client.js';
import { EbayApiError } from './ebay-offers.service.js';

export { EbayNotConnectedError, EbayApiError };

// ---------------------------------------------------------------------------
// getInventoryItem
// ---------------------------------------------------------------------------

export interface GetInventoryItemResult {
  ok: true;
  item: unknown;
}

/**
 * Fetch a single eBay Inventory item by SKU.
 *
 * @throws {EbayNotConnectedError} if user has no eBay credentials.
 * @throws {EbayApiError} on non-2xx eBay API responses.
 */
export async function getInventoryItem(
  userId: string,
  sku: string,
): Promise<GetInventoryItemResult> {
  const { apiHost, headers } = await getEbayClient(userId);

  const url = `${apiHost}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`;
  const res = await fetch(url, { headers });
  const text = await res.text();

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }

  if (!res.ok) {
    throw new EbayApiError(res.status, body);
  }

  return { ok: true, item: body };
}
