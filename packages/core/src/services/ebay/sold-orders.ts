/**
 * packages/core/src/services/ebay/sold-orders.ts
 *
 * Fetch completed (sold) orders using the eBay Fulfillment API.
 *
 * API reference:
 *   GET /sell/fulfillment/v1/order
 *   filter=orderfulfillmentstatus:{FULFILLED}
 */

import { getEbayClient, EbayNotConnectedError } from '../../../../../src/lib/ebay-client.js';

export { EbayNotConnectedError };

export interface SoldLineItem {
  lineItemId: string;
  sku?: string;
  title?: string;
  quantity: number;
  salePrice?: { value: string; currency: string };
}

export interface SoldOrder {
  orderId: string;
  creationDate: string;
  lastModifiedDate?: string;
  orderFulfillmentStatus?: string;
  buyerUsername?: string;
  buyerEmail?: string;
  lineItems: SoldLineItem[];
  pricingSummary?: {
    total?: { value: string; currency: string };
    deliveryCost?: { value: string; currency: string };
    tax?: { value: string; currency: string };
  };
  fulfillmentStartInstructions?: {
    shippingStep?: { shipTo?: { fullName?: string } };
  }[];
}

/**
 * Fetch sold (fulfilled) orders for the authenticated user.
 *
 * @param userId - Authenticated user ID.
 * @param limit  - Maximum orders to return (default 50, eBay max 200).
 * @param offset - Pagination offset.
 * @param dateRange - Optional ISO date range filter { from, to }
 */
export async function listSoldOrders(
  userId: string,
  { limit = 50, offset = 0, dateFrom, dateTo }: { limit?: number; offset?: number; dateFrom?: string; dateTo?: string } = {}
): Promise<{ total: number; orders: SoldOrder[] }> {
  const client = await getEbayClient(userId);
  const { apiHost, headers } = client;

  // Build filter string manually — do NOT use URLSearchParams for the filter value.
  // eBay's filter syntax uses { } and [ ] and : as structural characters; encoding them
  // with %7B / %5B / %3A causes a 400 because eBay's parser doesn't recognise the syntax.
  // We also omit the orderfulfillmentstatus filter so we return all sold orders regardless
  // of whether they have been shipped yet (NOT_STARTED / IN_PROGRESS / FULFILLED).
  const filters: string[] = [];
  if (dateFrom || dateTo) {
    filters.push(`creationdate:[${dateFrom ?? ''}..${dateTo ?? ''}]`);
  }

  const filterPart = filters.length > 0 ? `&filter=${filters.join(',')}` : '';
  const url = `${apiHost}/sell/fulfillment/v1/order?limit=${Math.min(limit, 200)}&offset=${offset}${filterPart}`;

  const res = await fetch(url, { headers });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`eBay Fulfillment API error ${res.status}: ${body.slice(0, 300)}`);
    (err as any).statusCode = res.status;
    throw err;
  }

  const data: any = await res.json();

  const orders: SoldOrder[] = (data.orders || []).map((o: any): SoldOrder => {
    const lineItems: SoldLineItem[] = (o.lineItems || []).map((li: any): SoldLineItem => ({
      lineItemId: li.lineItemId || '',
      sku: li.sku,
      title: li.title,
      quantity: li.quantity ?? 1,
      salePrice: li.lineItemCost
        ? { value: li.lineItemCost.value, currency: li.lineItemCost.currency }
        : li.appliedPromotions?.[0]?.discountAmount
        ? undefined
        : undefined,
    }));

    // Prefer lineItemCost if present on each item
    for (const li of o.lineItems || []) {
      const matched = lineItems.find(l => l.lineItemId === li.lineItemId);
      if (matched && li.lineItemCost) {
        matched.salePrice = { value: li.lineItemCost.value, currency: li.lineItemCost.currency };
      }
    }

    return {
      orderId: o.orderId || '',
      creationDate: o.creationDate || '',
      lastModifiedDate: o.lastModifiedDate,
      orderFulfillmentStatus: o.orderFulfillmentStatus,
      buyerUsername: o.buyer?.username,
      buyerEmail: o.buyer?.taxAddress?.email,
      lineItems,
      pricingSummary: o.pricingSummary
        ? {
            total: o.pricingSummary.total,
            deliveryCost: o.pricingSummary.deliveryCost,
            tax: o.pricingSummary.tax,
          }
        : undefined,
      fulfillmentStartInstructions: o.fulfillmentStartInstructions,
    };
  });

  return {
    total: data.total ?? orders.length,
    orders,
  };
}
