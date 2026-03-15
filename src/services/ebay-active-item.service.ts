/**
 * ebay-active-item.service.ts — Platform-agnostic service for fetching active eBay listing details.
 *
 * Mirrors the business logic previously inlined in:
 *   netlify/functions/ebay-get-active-item.ts
 *
 * Uses the eBay Trading API (XML) for rich item details, then cross-references
 * the Inventory API if the item has a SKU.
 *
 * No HTTP framework dependencies.
 */

import { getEbayClient, EbayNotConnectedError } from '../lib/ebay-client.js';

export { EbayNotConnectedError };

const TRADING_API_URL = 'https://api.ebay.com/ws/api.dll';
const TRADING_COMPATIBILITY_LEVEL = '1193';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActiveItem {
  itemId: string;
  sku: string;
  isInventoryListing: boolean;
  title: string;
  description: string;
  price: string;
  currency: string;
  quantity: number;
  condition: string;
  conditionName: string;
  images: string[];
  aspects: Record<string, string[]>;
  autoPromote: boolean;
  autoPromoteAdRate?: unknown;
  fulfillmentPolicyId?: string | null;
}

export interface GetActiveItemResult {
  ok: true;
  item: ActiveItem;
}

// ---------------------------------------------------------------------------
// XML helpers (exported for unit-testing)
// ---------------------------------------------------------------------------

export function extractXmlText(xml: string, tag: string): string | null {
  // Allow for XML attributes on the tag (e.g. <CurrentPrice currencyID="USD">5.99</CurrentPrice>)
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]+)<\\/${tag}>`);
  return xml.match(re)?.[1] ?? null;
}

export function extractXmlCdata(xml: string, tag: string): string | null {
  const cdataRe = new RegExp(`<${tag}><!\\[CDATA\\[(.*?)\\]\\]><\/${tag}>`, 's');
  const plainRe = new RegExp(`<${tag}>(.*?)<\/${tag}>`, 's');
  return xml.match(cdataRe)?.[1] ?? xml.match(plainRe)?.[1] ?? null;
}

export function extractItemAspects(xml: string): Record<string, string[]> {
  const aspects: Record<string, string[]> = {};
  const nvMatches = xml.matchAll(/<NameValueList>(.*?)<\/NameValueList>/gs);
  for (const match of nvMatches) {
    const nameMatch = match[1].match(/<Name>([^<]+)<\/Name>/);
    const valueMatches = match[1].matchAll(/<Value>([^<]+)<\/Value>/g);
    if (nameMatch) {
      const values: string[] = [];
      for (const v of valueMatches) values.push(v[1]);
      if (values.length) aspects[nameMatch[1]] = values;
    }
  }
  return aspects;
}

// ---------------------------------------------------------------------------
// getActiveItem
// ---------------------------------------------------------------------------

/**
 * Fetch a live eBay listing by Trading API item ID.
 *
 * @throws {EbayNotConnectedError} if user has no eBay credentials.
 * @throws on Trading API errors or HTTP failures.
 */
export async function getActiveItem(
  userId: string,
  itemId: string,
): Promise<GetActiveItemResult> {
  const { access_token, apiHost } = await getEbayClient(userId);

  // Build Trading API GetItem XML request
  const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${access_token}</eBayAuthToken>
  </RequesterCredentials>
  <ItemID>${itemId}</ItemID>
  <DetailLevel>ReturnAll</DetailLevel>
  <IncludeItemSpecifics>true</IncludeItemSpecifics>
</GetItemRequest>`;

  const res = await fetch(TRADING_API_URL, {
    method: 'POST',
    headers: {
      'X-EBAY-API-COMPATIBILITY-LEVEL': TRADING_COMPATIBILITY_LEVEL,
      'X-EBAY-API-CALL-NAME': 'GetItem',
      'X-EBAY-API-SITEID': '0',
      'Content-Type': 'text/xml; charset=utf-8',
    },
    body: xmlBody,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Trading API failed: ${res.status} - ${text.slice(0, 300)}`);
  }

  const xmlText = await res.text();

  if (xmlText.includes('<Ack>Failure</Ack>') || xmlText.includes('<Ack>PartialFailure</Ack>')) {
    const err = new Error(`eBay Trading API error: ${xmlText.slice(0, 500)}`);
    (err as any).statusCode = 400;
    throw err;
  }

  // Parse core fields from XML
  const title = (extractXmlText(xmlText, 'Title') ?? '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  const sku = extractXmlText(xmlText, 'SKU') ?? '';
  const isInventoryListing = !!extractXmlText(xmlText, 'SellerInventoryID');
  const price = extractXmlText(xmlText, 'CurrentPrice') ?? '';
  const currency = xmlText.match(/<CurrentPrice currencyID="([^"]+)"/)?.[1] ?? 'USD';
  const quantity = parseInt(extractXmlText(xmlText, 'Quantity') ?? '0', 10);
  const condition = extractXmlText(xmlText, 'ConditionID') ?? '1000';
  const conditionName = extractXmlText(xmlText, 'ConditionDisplayName') ?? 'New';
  // Strip eBay CDN version suffixes (e.g. ";1" in "s-l1600.jpg;1") — Inventory API rejects URLs with semicolons
  const images: string[] = [...xmlText.matchAll(/<PictureURL>([^<]+)<\/PictureURL>/g)]
    .map(m => m[1].split(';')[0].trim())
    .filter(Boolean);
  const aspects = extractItemAspects(xmlText);

  let description = extractXmlCdata(xmlText, 'Description') ?? '';
  let finalIsInventoryListing = isInventoryListing;
  let autoPromote = false;
  let autoPromoteAdRate: unknown;
  let fulfillmentPolicyId: string | null = null;

  // If item has a SKU, cross-reference Inventory API for richer description
  if (sku) {
    const inventoryRes = await fetch(
      `${apiHost}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
      {
        headers: {
          Authorization: `Bearer ${access_token}`,
          Accept: 'application/json',
          'Accept-Language': 'en-US',
          'Content-Language': 'en-US',
        },
      },
    );

    if (inventoryRes.ok) {
      finalIsInventoryListing = true;
      const inventoryData = await inventoryRes.json() as Record<string, any>;
      if (inventoryData.product?.description) {
        description = inventoryData.product.description as string;
      }
    } else {
      finalIsInventoryListing = false;
    }
  }

  // If confirmed as Inventory API listing, fetch offer for promotion and policy data
  if (finalIsInventoryListing && sku) {
    try {
      const MARKETPLACE_ID = process.env.DEFAULT_MARKETPLACE_ID || process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';
      const offerRes = await fetch(
        `${apiHost}/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${MARKETPLACE_ID}`,
        {
          headers: {
            Authorization: `Bearer ${access_token}`,
            Accept: 'application/json',
          },
        },
      );
      if (offerRes.ok) {
        const offersData = await offerRes.json() as { offers?: any[] };
        const offer = offersData.offers?.[0];
        if (offer) {
          if (offer.merchantData) {
            autoPromote = offer.merchantData.autoPromote === true;
            autoPromoteAdRate = offer.merchantData.autoPromoteAdRate;
          }
          fulfillmentPolicyId = offer.listingPolicies?.fulfillmentPolicyId ?? null;
        }
      }
    } catch {
      // Non-fatal — promotion/policy data is optional
    }
  }

  const item: ActiveItem = {
    itemId,
    sku,
    isInventoryListing: finalIsInventoryListing,
    title,
    description,
    price,
    currency,
    quantity,
    condition,
    conditionName,
    images,
    aspects,
    autoPromote,
    autoPromoteAdRate,
    fulfillmentPolicyId,
  };

  return { ok: true, item };
}
