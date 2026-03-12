/**
 * packages/core/src/services/ebay/active-trading.ts
 *
 * List active eBay listings using the Trading API (GetMyeBaySelling).
 */

import { getEbayClient, EbayNotConnectedError } from '../../../../../src/lib/ebay-client.js';
import { tokensStore } from '../../../../../src/lib/redis-store.js';
import { userScopedKey } from '../../../../../src/lib/_auth.js';
import { accessTokenFromRefresh, tokenHosts } from '../../../../../src/lib/_common.js';
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
  /** True = free-shipping policy; false = paid; undefined = unknown (falls back to price inference in UI) */
  isFreeShipping?: boolean;
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
  const { access_token, apiHost } = client;

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

  // Enrich with promotion data and shipping policy in parallel
  try {
    const [promoMap, shippingMap] = await Promise.all([
      fetchPromotionMap(userId, apiHost).catch(() => new Map()),
      fetchShippingPolicyMap(userId, access_token, apiHost).catch(() => new Map()),
    ]);
    for (const offer of activeOffers) {
      const promo =
        promoMap.get(offer.sku) ||
        (offer.itemId ? promoMap.get(offer.itemId) : undefined) ||
        promoMap.get(offer.offerId);
      if (promo) {
        offer.autoPromote = true;
        offer.autoPromoteAdRate = promo.autoPromoteAdRate;
      } else {
        offer.autoPromote = false;
      }
      // Shipping: prefer real policy lookup; fall back to price inference if not found
      const shipKey = offer.sku || offer.listingId || offer.offerId;
      const shipResult = shippingMap.get(shipKey) ??
        (offer.listingId ? shippingMap.get(offer.listingId) : undefined) ??
        (offer.itemId ? shippingMap.get(offer.itemId) : undefined);
      if (shipResult !== undefined) {
        offer.isFreeShipping = shipResult;
      }
      // else: isFreeShipping stays undefined → UI falls back to price<50 heuristic
    }
  } catch {
    // Non-fatal
  }

  return { count: activeOffers.length, offers: activeOffers };
}

/**
 * Fetch all inventory offers in one paged call and build a map of
 * (sku or listingId) → isFreeShipping based on the offer's fulfillmentPolicyId
 * compared against the user's saved `fulfillmentFree` default.
 *
 * One REST call per 200 offers (paginated). Non-inventory listings not present
 * here will have `isFreeShipping` left undefined and the UI falls back to the
 * price < $50 heuristic.
 */
/**
 * Build the set of eBay fulfillment policy IDs that represent free shipping.
 *
 * Primary: GET /sell/account/v1/fulfillment_policy — inspect each policy's
 * shippingOptions to see if shippingCostType === 'FREE' or all shipping
 * service costs are $0.00. No Redis dependency.
 *
 * Fallback: Redis policy-defaults.json fulfillmentFree field (for edge cases
 * where the Account API is unavailable).
 */
async function buildFreePolicyIdSet(
  userId: string,
  access_token: string,
  apiHost: string,
): Promise<Set<string>> {
  const freeIds = new Set<string>();
  const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';
  const headers = {
    Authorization: `Bearer ${access_token}`,
    Accept: 'application/json',
    'Accept-Language': 'en-US',
    'Content-Language': 'en-US',
    'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID,
  };

  try {
    const res = await fetch(
      `${apiHost}/sell/account/v1/fulfillment_policy?marketplace_id=${MARKETPLACE_ID}`,
      { headers },
    );
    if (res.ok) {
      const body: any = await res.json().catch(() => null);
      for (const policy of (body?.fulfillmentPolicies ?? [])) {
        const id: string | undefined = policy?.fulfillmentPolicyId;
        if (!id) continue;
        const options: any[] = Array.isArray(policy.shippingOptions) ? policy.shippingOptions : [];
        const isFree = options.some((opt: any) => {
          if (opt?.shippingCostType === 'FREE') return true;
          // Also treat as free if every shipping service in this option costs $0
          const services: any[] = Array.isArray(opt?.shippingServices) ? opt.shippingServices : [];
          return services.length > 0 && services.every((svc: any) => {
            const cost = parseFloat(svc?.shippingCost?.value ?? '1');
            return cost === 0;
          });
        });
        if (isFree) freeIds.add(id);
      }
      // If we got a valid response return the result, even if empty
      return freeIds;
    }
  } catch { /* fall through to Redis fallback */ }

  // Fallback: Redis fulfillmentFree setting
  try {
    const store = tokensStore();
    const defaults = ((await store.get(
      userScopedKey(userId, 'policy-defaults.json'),
      { type: 'json' },
    ).catch(() => null)) as any) ?? {};
    if (typeof defaults.fulfillmentFree === 'string') {
      freeIds.add(defaults.fulfillmentFree);
    }
  } catch { /* ignore */ }

  return freeIds;
}

/**
 * Fetch all inventory offers and map (sku | listingId) → isFreeShipping.
 * Runs the policy lookup and Inventory API paging in parallel.
 */
async function fetchShippingPolicyMap(
  userId: string,
  access_token: string,
  apiHost: string,
): Promise<Map<string, boolean>> {
  const map = new Map<string, boolean>();
  const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';
  const headers = {
    Authorization: `Bearer ${access_token}`,
    Accept: 'application/json',
    'Accept-Language': 'en-US',
    'Content-Language': 'en-US',
    'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID,
  };

  // Run free-policy lookup and first page of offers in parallel
  const firstPageUrl = `${apiHost}/sell/inventory/v1/offer?marketplace_id=${MARKETPLACE_ID}&limit=200&offset=0`;
  const [freePolicyIds, firstPageRes] = await Promise.all([
    buildFreePolicyIdSet(userId, access_token, apiHost).catch(() => new Set<string>()),
    fetch(firstPageUrl, { headers }).catch(() => null),
  ]);

  if (!freePolicyIds.size) return map; // no free policies → nothing to classify

  async function processOfferPage(res: Response | null): Promise<{ total: number; count: number }> {
    if (!res?.ok) return { total: 0, count: 0 };
    const body: any = await res.json().catch(() => null);
    if (!body) return { total: 0, count: 0 };
    for (const offer of (body.offers ?? [])) {
      const policyId: string | undefined = offer?.listingPolicies?.fulfillmentPolicyId;
      if (!policyId) continue;
      const isFree = freePolicyIds.has(policyId);
      if (offer.sku) map.set(String(offer.sku), isFree);
      const listingId = offer?.listing?.listingId;
      if (listingId) map.set(String(listingId), isFree);
    }
    return { total: body.total ?? 0, count: (body.offers ?? []).length };
  }

  const { total, count } = await processOfferPage(firstPageRes);

  // Fetch remaining pages sequentially if needed (uncommon: >200 offers)
  let offset = count;
  while (offset > 0 && offset < total) {
    const url = `${apiHost}/sell/inventory/v1/offer?marketplace_id=${MARKETPLACE_ID}&limit=200&offset=${offset}`;
    const res = await fetch(url, { headers }).catch(() => null);
    const page = await processOfferPage(res);
    if (!page.count) break;
    offset += page.count;
  }

  return map;
}

/**
 * Fetch all RUNNING Promoted Listings ad campaigns via the Marketing API and
 * return a map of (listingId or SKU) → { autoPromoteAdRate } so active
 * listings can show their real promotion status.
 *
 * Both inventory-path listings (keyed by SKU / inventoryReferenceId) and
 * traditional listings (keyed by listingId) are covered.
 *
 * Uses a separate token request with sell.marketing scope so that the main
 * active-listings token is not affected if the user hasn't granted that scope.
 */
async function fetchPromotionMap(
  userId: string,
  apiHost: string,
): Promise<Map<string, { autoPromote: boolean; autoPromoteAdRate?: number }>> {
  const map = new Map<string, { autoPromote: boolean; autoPromoteAdRate?: number }>();

  // Get a token that includes sell.marketing scope
  let access_token: string;
  try {
    const store = tokensStore();
    const saved = (await store.get(userScopedKey(userId, 'ebay.json'), { type: 'json' })) as any;
    const refresh = saved?.refresh_token as string | undefined;
    if (!refresh) return map;

    const result = await accessTokenFromRefresh(refresh, [
      'https://api.ebay.com/oauth/api_scope',
      'https://api.ebay.com/oauth/api_scope/sell.account',
      'https://api.ebay.com/oauth/api_scope/sell.inventory',
      'https://api.ebay.com/oauth/api_scope/sell.marketing',
    ]);
    access_token = result.access_token;
  } catch {
    return map; // Marketing scope not available — return empty map gracefully
  }

  const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';
  const headers = {
    Authorization: `Bearer ${access_token}`,
    Accept: 'application/json',
    'Accept-Language': 'en-US',
    'Content-Language': 'en-US',
    'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID,
  };

  // Step 1: Get all currently RUNNING campaigns
  let campaignsBody: any;
  try {
    const campaignsRes = await fetch(
      `${apiHost}/sell/marketing/v1/ad_campaign?campaign_status=RUNNING&limit=100`,
      { headers },
    );
    if (!campaignsRes.ok) return map; // Marketing API unavailable or scope missing
    campaignsBody = await campaignsRes.json();
  } catch {
    return map;
  }

  const campaigns: any[] = Array.isArray(campaignsBody?.campaigns) ? campaignsBody.campaigns : [];

  // Step 2: For each campaign, page through its ads and build the promotion map
  for (const campaign of campaigns) {
    if (!campaign.campaignId) continue;
    try {
      const adsRes = await fetch(
        `${apiHost}/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaign.campaignId)}/ad?limit=500`,
        { headers },
      );
      if (!adsRes.ok) continue;
      let adsBody: any;
      try { adsBody = await adsRes.json(); } catch { continue; }

      const ads: any[] = Array.isArray(adsBody?.ads) ? adsBody.ads : [];
      for (const ad of ads) {
        // Non-inventory listings key by listingId; inventory-path listings key by inventoryReferenceId (= SKU)
        const adId = ad.listingId || ad.inventoryReferenceId;
        if (!adId) continue;
        const bidPercentage =
          typeof ad.bidPercentage === 'string'
            ? parseFloat(ad.bidPercentage)
            : (typeof ad.bidPercentage === 'number' ? ad.bidPercentage : 0);
        map.set(adId, { autoPromote: true, autoPromoteAdRate: bidPercentage || 0 });
      }
    } catch {
      // Non-fatal per campaign — continue with next
    }
  }

  return map;
}
