import { amazonConfig, assertAmazonConfig } from '../config.js';
import { signAwsRequest } from './aws-sign-v4.js';

export interface AmazonSearchInput {
  title: string;
  brand?: string;
  upc?: string;
  // Optional: allow passing explicit keywords override
  keywordsOverride?: string;
}

export interface AmazonProductResult {
  asin: string;
  title: string;
  price: number | null;
  currency: string | null;
  url: string | null;
  categories: string[]; // from browse nodes / product group
}

export async function searchAmazonProduct(input: AmazonSearchInput): Promise<AmazonProductResult | null> {
  assertAmazonConfig();

  const { title, brand, upc, keywordsOverride } = input;

  // 1. Build a reasonable Keywords string
  // Prefer UPC if present, otherwise brand + title.
  const keywordsParts: string[] = [];
  if (keywordsOverride) {
    keywordsParts.push(keywordsOverride);
  } else {
    if (upc) keywordsParts.push(upc);
    if (brand) keywordsParts.push(brand);
    if (title) keywordsParts.push(title);
  }

  const Keywords = keywordsParts.join(' ').trim();

  console.log('[amazon-product-api] searchAmazonProduct (direct HTTP)', {
    Keywords,
    brand,
    hasUpc: !!upc
  });

  // 2. Build PA-API v5 SearchItems request body
  const bodyObj = {
    Keywords,
    SearchIndex: 'All',
    Resources: [
      'ItemInfo.Title',
      'ItemInfo.ByLineInfo',
      'Offers.Listings.Price',
      'BrowseNodeInfo.BrowseNodes',
      'BrowseNodeInfo.BrowseNodes.Ancestor'
    ],
    PartnerTag: amazonConfig.partnerTag,
    PartnerType: 'Associates',
    Marketplace: 'www.amazon.com'
  };

  const bodyJson = JSON.stringify(bodyObj);

  // 3. Sign the request using AWS Signature Version 4
  const signed = signAwsRequest(
    {
      accessKeyId: amazonConfig.accessKey,
      secretAccessKey: amazonConfig.secretKey,
      region: amazonConfig.region,
      service: 'ProductAdvertisingAPI',
      host: 'webservices.amazon.com'
    },
    {
      method: 'POST',
      path: '/paapi5/searchitems',
      body: bodyJson
    }
  );

  // 4. Make the HTTP request
  let resp;
  try {
    resp = await fetch(signed.url, {
      method: 'POST',
      headers: signed.headers,
      body: signed.body
    });
  } catch (err) {
    console.error('[amazon-product-api] HTTP fetch failed', err);
    return null;
  }

  const text = await resp.text();
  console.log('[amazon-product-api] searchitems status', resp.status, 'len', text.length);

  if (!resp.ok) {
    console.error('[amazon-product-api] Non-200 response', { status: resp.status, body: text.slice(0, 500) });
    return null;
  }

  // 5. Parse response
  let json: any;
  try {
    json = JSON.parse(text);
  } catch (err) {
    console.error('[amazon-product-api] Failed to parse JSON', err);
    return null;
  }

  const items = json?.SearchResult?.Items || [];
  if (!items.length) {
    console.warn('[amazon-product-api] No items returned for keywords', Keywords);
    return null;
  }

  const item = items[0]; // we will refine ranking later if needed

  const asin = item.ASIN || '';
  const titleText =
    item.ItemInfo?.Title?.DisplayValue ||
    item.ItemInfo?.Title?.Display ||
    title;

  const listing = item.Offers?.Listings?.[0];
  const priceInfo = listing?.Price || listing?.SavingBasis;

  const amount = typeof priceInfo?.Amount === 'number' ? priceInfo.Amount : null;
  const currency = priceInfo?.Currency || null;
  const detailUrl = item.DetailPageURL || null;

  // 6. Extract categories from BrowseNodeInfo
  const categories: string[] = [];
  const browseNodes = item.BrowseNodeInfo?.BrowseNodes || [];
  for (const node of browseNodes) {
    if (node.DisplayName) categories.push(node.DisplayName);
    // Also collect ancestors
    let ancestor = node.Ancestor;
    while (ancestor) {
      if (ancestor.DisplayName) categories.push(ancestor.DisplayName);
      ancestor = ancestor.Ancestor;
    }
  }

  return {
    asin,
    title: titleText || title,
    price: amount,
    currency,
    url: detailUrl,
    categories: Array.from(new Set(categories))
  };
}
