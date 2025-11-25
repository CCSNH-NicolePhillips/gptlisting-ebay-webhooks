import { amazonConfig, assertAmazonConfig } from '../config.js';
import ProductAdvertisingAPIv1 from 'paapi5-nodejs-sdk';

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

  console.log('[amazon-product-api] searchAmazonProduct', {
    Keywords,
    brand,
    hasUpc: !!upc
  });

  const defaultClient = ProductAdvertisingAPIv1.ApiClient.instance;
  defaultClient.accessKey = amazonConfig.accessKey;
  defaultClient.secretKey = amazonConfig.secretKey;
  defaultClient.host = 'webservices.amazon.com';
  defaultClient.region = amazonConfig.region;

  const api = new ProductAdvertisingAPIv1.DefaultApi();

  // 2. Call PA-API SearchItems
  const searchItemsRequest = new ProductAdvertisingAPIv1.SearchItemsRequest();
  searchItemsRequest.PartnerTag = amazonConfig.partnerTag;
  searchItemsRequest.PartnerType = 'Associates';
  searchItemsRequest.Keywords = Keywords;
  searchItemsRequest.SearchIndex = 'All';
  searchItemsRequest.ItemCount = 1;
  searchItemsRequest.Resources = [
    'ItemInfo.Title',
    'ItemInfo.ByLineInfo',
    'Offers.Listings.Price',
    'BrowseNodeInfo.BrowseNodes',
    'BrowseNodeInfo.BrowseNodes.Ancestor'
  ];

  let response;
  try {
    response = await api.searchItems(searchItemsRequest);
  } catch (err) {
    console.error('[amazon-product-api] SearchItems failed', err);
    return null;
  }

  const items = response?.SearchResult?.Items || [];
  if (!items.length) {
    console.warn('[amazon-product-api] No items found for Keywords', Keywords);
    return null;
  }

  const item = items[0]; // we will refine ranking later if needed

  const asin = item.ASIN || '';
  const titleText = item.ItemInfo?.Title?.DisplayValue || title;

  const listing = item.Offers?.Listings?.[0];
  const priceInfo = listing?.Price || listing?.SavingBasis;

  const amount = priceInfo?.Amount != null ? priceInfo.Amount : null;
  const currency = priceInfo?.Currency || null;
  const detailUrl = item.DetailPageURL || null;

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
    title: titleText,
    price: amount,
    currency,
    url: detailUrl,
    categories: Array.from(new Set(categories))
  };
}
