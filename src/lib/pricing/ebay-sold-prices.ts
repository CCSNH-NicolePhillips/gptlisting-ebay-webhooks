import { appAccessToken, tokenHosts } from "../_common.js";

export interface SoldPriceSample {
  price: number;
  currency: string;
  url?: string;
  endedAt?: string;
}

export interface SoldPriceStats {
  ok: boolean;
  samples: SoldPriceSample[];
  median?: number;
  p35?: number;
  p10?: number;
  p90?: number;
  rateLimited?: boolean; // True if API rate limit was hit
}

export interface SoldPriceQuery {
  title: string;
  brand?: string;
  upc?: string;
  condition?: 'NEW' | 'USED' | 'OTHER';
  quantity?: number;
}

/**
 * Calculate percentile from sorted array
 */
function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0];
  
  const index = (p / 100) * (sortedValues.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index % 1;
  
  if (lower === upper) {
    return sortedValues[lower];
  }
  
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

/**
 * Calculate statistics from price samples
 */
function computeStats(prices: number[]): {
  median: number;
  p35: number;
  p10: number;
  p90: number;
} {
  if (prices.length === 0) {
    return { median: 0, p35: 0, p10: 0, p90: 0 };
  }
  
  const sorted = [...prices].sort((a, b) => a - b);
  
  return {
    median: percentile(sorted, 50),
    p35: percentile(sorted, 35),
    p10: percentile(sorted, 10),
    p90: percentile(sorted, 90),
  };
}

/**
 * Map query condition to eBay API condition IDs
 */
function getConditionFilter(condition?: string): string[] {
  if (!condition) return [];
  
  switch (condition.toUpperCase()) {
    case 'NEW':
      return ['1000', '1500', '1750']; // New, New with tags, New with defects
    case 'USED':
      return ['3000', '4000', '5000', '6000']; // Used, Very Good, Good, Acceptable
    default:
      return [];
  }
}

/**
 * Check if item quantity roughly matches query
 */
function isQuantityMatch(itemQuantity: number | undefined, queryQuantity: number | undefined): boolean {
  if (!queryQuantity || !itemQuantity) return true; // No filter if either is missing
  
  // Allow 20% variance in quantity
  const lower = queryQuantity * 0.8;
  const upper = queryQuantity * 1.2;
  
  return itemQuantity >= lower && itemQuantity <= upper;
}

/**
 * Fetch sold price statistics from eBay completed listings using Finding API
 */
export async function fetchSoldPriceStats(
  query: SoldPriceQuery
): Promise<SoldPriceStats> {
  const empty: SoldPriceStats = {
    ok: false,
    samples: [],
  };

  try {
    // Finding API requires app ID (not OAuth token)
    const appId = process.env.EBAY_APP_ID || process.env.EBAY_CLIENT_ID;
    if (!appId) {
      console.error('[ebay-sold] Missing EBAY_APP_ID or EBAY_CLIENT_ID');
      return empty;
    }

    const isSandbox = process.env.EBAY_ENV === 'sandbox';
    const baseUrl = isSandbox 
      ? 'https://svcs.sandbox.ebay.com/services/search/FindingService/v1'
      : 'https://svcs.ebay.com/services/search/FindingService/v1';

    // Build keywords
    const keywords = [query.brand, query.title].filter(Boolean).join(' ');
    console.log(`[ebay-sold] Searching completed items for: "${keywords}"`);

    const searchUrl = new URL(baseUrl);
    searchUrl.searchParams.set('OPERATION-NAME', 'findCompletedItems');
    searchUrl.searchParams.set('SERVICE-VERSION', '1.0.0');
    searchUrl.searchParams.set('SECURITY-APPNAME', appId);
    searchUrl.searchParams.set('RESPONSE-DATA-FORMAT', 'JSON');
    searchUrl.searchParams.set('REST-PAYLOAD', '');
    searchUrl.searchParams.set('keywords', keywords);
    searchUrl.searchParams.set('paginationInput.entriesPerPage', '100');
    searchUrl.searchParams.set('sortOrder', 'EndTimeSoonest');

    // Add item filters
    let filterIndex = 0;

    // Filter: Sold items only
    searchUrl.searchParams.set(`itemFilter(${filterIndex}).name`, 'SoldItemsOnly');
    searchUrl.searchParams.set(`itemFilter(${filterIndex}).value`, 'true');
    filterIndex++;

    // Filter: Buy It Now listings
    searchUrl.searchParams.set(`itemFilter(${filterIndex}).name`, 'ListingType');
    searchUrl.searchParams.set(`itemFilter(${filterIndex}).value`, 'FixedPrice');
    filterIndex++;

    // Filter: US location
    searchUrl.searchParams.set(`itemFilter(${filterIndex}).name`, 'LocatedIn');
    searchUrl.searchParams.set(`itemFilter(${filterIndex}).value`, 'US');
    filterIndex++;

    // Filter: Condition if specified
    if (query.condition) {
      const conditionIds = getConditionFilter(query.condition);
      if (conditionIds.length > 0) {
        searchUrl.searchParams.set(`itemFilter(${filterIndex}).name`, 'Condition');
        conditionIds.forEach((condId, idx) => {
          searchUrl.searchParams.set(`itemFilter(${filterIndex}).value(${idx})`, condId);
        });
        console.log(`[ebay-sold] Filtering by condition: ${query.condition} (IDs: ${conditionIds.join(', ')})`);
        filterIndex++;
      }
    }

    console.log(`[ebay-sold] API URL: ${searchUrl.toString().substring(0, 200)}...`);

    const response = await fetch(searchUrl.toString(), {
      headers: {
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      
      // Check for rate limit error
      if (response.status === 500 && errorText.includes('exceeded the number of times')) {
        console.warn(`[ebay-sold] Rate limit exceeded - daily quota reached`);
        return { ...empty, rateLimited: true };
      }
      
      console.error(`[ebay-sold] API error: ${response.status} ${response.statusText}`, {
        preview: errorText.slice(0, 500),
      });
      return empty;
    }

    const data = await response.json();
    
    // Finding API response structure
    const searchResult = data?.findCompletedItemsResponse?.[0]?.searchResult?.[0];
    const items = searchResult?.item || [];
    const count = parseInt(searchResult?.['@count'] || '0', 10);

    console.log(`[ebay-sold] Found ${count} completed items from API`);

    if (count === 0 || items.length === 0) {
      console.warn(`[ebay-sold] No sold items found for query:`, {
        title: query.title,
        brand: query.brand,
        condition: query.condition,
      });
      return empty;
    }

    // Extract and filter samples
    const samples: SoldPriceSample[] = [];

    for (const item of items) {
      // Finding API structure: item.sellingStatus[0].currentPrice[0]
      const sellingStatus = item.sellingStatus?.[0];
      const currentPrice = sellingStatus?.currentPrice?.[0];
      
      if (!currentPrice?.__value__) continue;

      const price = parseFloat(currentPrice.__value__);
      if (!price || price <= 0) continue;

      // Check quantity match if specified
      const itemQuantity = parseInt(item.quantity?.[0] || '1', 10);
      if (!isQuantityMatch(itemQuantity, query.quantity)) {
        continue;
      }

      samples.push({
        price: Math.round(price * 100) / 100,
        currency: currentPrice['@currencyId'] || 'USD',
        url: item.viewItemURL?.[0],
        endedAt: item.listingInfo?.[0]?.endTime?.[0],
      });
    }

    console.log(`[ebay-sold] Filtered to ${samples.length} valid samples (after quantity filter)`);

    // Compute statistics if we have enough samples
    if (samples.length === 0) {
      console.warn(`[ebay-sold] No sold items matched filters for query:`, {
        title: query.title,
        brand: query.brand,
        condition: query.condition,
      });
      return empty;
    }

    const prices = samples.map(s => s.price);
    const stats = computeStats(prices);

    const result: SoldPriceStats = {
      ok: samples.length >= 3, // Need at least 3 samples for reliable stats
      samples,
      ...stats,
    };

    console.log(`[ebay-sold] Statistics computed:`, {
      title: query.title,
      brand: query.brand,
      condition: query.condition,
      samplesCount: samples.length,
      median: stats.median?.toFixed(2),
      p35: stats.p35?.toFixed(2),
      p10: stats.p10?.toFixed(2),
      p90: stats.p90?.toFixed(2),
      ok: result.ok,
    });

    return result;

  } catch (error) {
    console.error('[ebay-sold] Error fetching sold prices:', error);
    return empty;
  }
}
