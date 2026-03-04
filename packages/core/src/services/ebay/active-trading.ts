/**
 * packages/core/src/services/ebay/active-trading.ts
 *
 * List active eBay listings using the Trading API (GetMyeBaySelling).
 */

import { getEbayClient, EbayNotConnectedError } from '../../../../../src/lib/ebay-client.js';
import {
  extractItemIdsFromContainer,
  checkXmlForErrors,
  shouldExcludeActiveItem,
  shouldApplyUnsoldFilter,
  buildUnsoldListRequest,
} from '../../../../../src/lib/active-trading-xml.js';

export { EbayNotConnectedError };

export type ActiveOffer = {
  itemId?: string;
  offerId: string;
  sku: string;
  title?: string;
  price?: { value: string; currency: string };
  availableQuantity?: number;
  listingId?: string;
  listingStatus?: string;
  marketplaceId?: string;
  condition?: number;
  lastModifiedDate?: string;
  autoPromote?: boolean;
  autoPromoteAdRate?: number;
  imageUrl?: string;
  startTime?: string;
  quantitySold?: number;
  watchCount?: number;
  hitCount?: number;
  bestOfferEnabled?: boolean;
  bestOfferCount?: number;
};

const TRADING_API_URL = 'https://api.ebay.com/ws/api.dll';
const TRADING_HEADERS = {
  'X-EBAY-API-COMPATIBILITY-LEVEL': '1193',
  'X-EBAY-API-CALL-NAME': 'GetMyeBaySelling',
  'X-EBAY-API-SITEID': '0',
  'Content-Type': 'text/xml; charset=utf-8',
};

function extractTextBetween(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1] : '';
}

function parseActiveItemFromXml(itemXml: string): ActiveOffer | null {
  const itemId = extractTextBetween(itemXml, 'ItemID');
  if (!itemId) return null;

  const title = extractTextBetween(itemXml, 'Title');
  const sku = extractTextBetween(itemXml, 'SKU') || extractTextBetween(itemXml, 'ItemID');
  // eBay Trading API returns price as <CurrentPrice currencyID="USD">9.99</CurrentPrice>
  // (inside <SellingStatus> or at top level — matches either)
  const priceMatch = itemXml.match(/<CurrentPrice[^>]*currencyID="([^"]+)"[^>]*>([^<]+)<\/CurrentPrice>/);
  const startPriceStr = priceMatch ? priceMatch[2].trim() : '';
  const priceCurrency = priceMatch ? priceMatch[1] : 'USD';
  const quantity = extractTextBetween(itemXml, 'QuantityAvailable');
  const imageUrl = extractTextBetween(itemXml, 'GalleryURL');
  const startTime = extractTextBetween(itemXml, 'StartTime');
  const quantitySold = extractTextBetween(itemXml, 'QuantitySold');
  const watchCount = extractTextBetween(itemXml, 'WatchCount');
  const hitCount = extractTextBetween(itemXml, 'HitCount');

  const bestOfferXml = itemXml.match(/<BestOfferEnabled>([^<]+)<\/BestOfferEnabled>/);
  const bestOfferEnabled = bestOfferXml
    ? bestOfferXml[1].toLowerCase() === 'true'
    : undefined;

  return {
    itemId,
    offerId: itemId,
    sku,
    title: title || undefined,
    price: startPriceStr
      ? { value: startPriceStr, currency: priceCurrency }
      : undefined,
    availableQuantity: quantity ? parseInt(quantity, 10) : undefined,
    listingId: itemId,
    listingStatus: 'ACTIVE',
    autoPromote: false,
    imageUrl: imageUrl || undefined,
    startTime: startTime || undefined,
    quantitySold: quantitySold ? parseInt(quantitySold, 10) : undefined,
    watchCount: watchCount ? parseInt(watchCount, 10) : undefined,
    hitCount: hitCount ? parseInt(hitCount, 10) : undefined,
    bestOfferEnabled,
  };
}

async function getUnsoldItemIds(accessToken: string): Promise<Set<string>> {
  const unsoldIds = new Set<string>();
  const durationInDays = parseInt(process.env.UNSOLD_LIST_DURATION_DAYS || '60', 10);
  let pageNumber = 1;
  const entriesPerPage = 200;

  while (true) {
    const xmlRequest = buildUnsoldListRequest(accessToken, pageNumber, entriesPerPage, durationInDays);
    const res = await fetch(TRADING_API_URL, {
      method: 'POST',
      headers: { ...TRADING_HEADERS, 'X-EBAY-API-CALL-NAME': 'GetMyeBaySelling' },
      body: xmlRequest,
    });
    if (!res.ok) break; // best-effort — don't fail active listing if unsold fails
    const xmlText = await res.text();
    const ids = extractItemIdsFromContainer(xmlText, 'UnsoldList');
    for (const id of ids) unsoldIds.add(id);
    if (!xmlText.includes('<HasMoreItems>true</HasMoreItems>')) break;
    pageNumber++;
  }
  return unsoldIds;
}

/**
 * Fetch all active listings for the authenticated user via Trading API.
 */
export async function listActiveListings(userId: string): Promise<{
  count: number;
  offers: ActiveOffer[];
}> {
  const client = await getEbayClient(userId);
  const { access_token } = client;

  const unsoldItemIds = await getUnsoldItemIds(access_token).catch(() => new Set<string>());

  const activeOffers: ActiveOffer[] = [];
  const activeItemIds = new Set<string>();
  let pageNumber = 1;
  const entriesPerPage = 200;

  while (true) {
    const xmlRequest = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${access_token}</eBayAuthToken>
  </RequesterCredentials>
  <ActiveList>
    <Include>true</Include>
    <Pagination>
      <EntriesPerPage>${entriesPerPage}</EntriesPerPage>
      <PageNumber>${pageNumber}</PageNumber>
    </Pagination>
    <IncludeNotes>false</IncludeNotes>
  </ActiveList>
  <DetailLevel>ReturnAll</DetailLevel>
</GetMyeBaySellingRequest>`;

    const res = await fetch(TRADING_API_URL, {
      method: 'POST',
      headers: TRADING_HEADERS,
      body: xmlRequest,
    });

    const xmlText = await res.text();
    if (!res.ok || xmlText.includes('<Ack>Failure</Ack>')) {
      throw Object.assign(new Error('Trading API failed'), { statusCode: 502 });
    }
    checkXmlForErrors(xmlText);

    // Collect active item IDs for unsold filter analysis
    const pageIds = extractItemIdsFromContainer(xmlText, 'ActiveList');
    for (const id of pageIds) activeItemIds.add(id);

    const applyUnsoldFilter = shouldApplyUnsoldFilter(activeItemIds, unsoldItemIds);
    const nowMs = Date.now();

    // Split on <Item> tags and parse each record
    const itemSegments = xmlText.split(/<Item>/).slice(1); // first segment is before first <Item>
    for (const segment of itemSegments) {
      const itemXml = '<Item>' + segment.split('</Item>')[0] + '</Item>';
      const exclusionReason = shouldExcludeActiveItem(itemXml, unsoldItemIds, nowMs, applyUnsoldFilter);
      if (exclusionReason) continue;
      const offer = parseActiveItemFromXml(itemXml);
      if (offer) activeOffers.push(offer);
    }

    if (!xmlText.includes('<HasMoreItems>true</HasMoreItems>')) break;
    pageNumber++;
  }

  return { count: activeOffers.length, offers: activeOffers };
}
