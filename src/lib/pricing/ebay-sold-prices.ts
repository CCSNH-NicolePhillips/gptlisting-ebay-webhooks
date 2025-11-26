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
 * Fetch sold price statistics from eBay completed listings
 */
export async function fetchSoldPriceStats(
  query: SoldPriceQuery
): Promise<SoldPriceStats> {
  const empty: SoldPriceStats = {
    ok: false,
    samples: [],
  };

  try {
    // Use client_credentials grant for public Browse API (no user auth needed)
    const { access_token } = await appAccessToken([
      'https://api.ebay.com/oauth/api_scope'
    ]);
    
    if (!access_token) {
      console.error('[ebay-sold] Failed to get eBay app token');
      return empty;
    }

    const { apiHost } = tokenHosts(process.env.EBAY_ENV);
    const baseUrl = apiHost;

    let searchUrl: URL;
    let searchType: 'upc' | 'keywords';

    // Build search query
    if (query.upc) {
      // Search by GTIN/UPC
      searchUrl = new URL(`${baseUrl}/buy/browse/v1/item_summary/search`);
      searchUrl.searchParams.set('gtin', query.upc);
      searchType = 'upc';
      console.log(`[ebay-sold] Searching by UPC: ${query.upc}`);
    } else {
      // Search by keywords (brand + title)
      searchUrl = new URL(`${baseUrl}/buy/browse/v1/item_summary/search`);
      const keywords = [query.brand, query.title].filter(Boolean).join(' ');
      searchUrl.searchParams.set('q', keywords);
      searchType = 'keywords';
      console.log(`[ebay-sold] Searching by keywords: "${keywords}"`);
    }

    // Add filters
    searchUrl.searchParams.set('filter', 'buyingOptions:{FIXED_PRICE},itemLocationCountry:US');
    searchUrl.searchParams.set('sort', 'endDate'); // Most recent first
    searchUrl.searchParams.set('limit', '50'); // Get up to 50 results

    // Add condition filter if specified
    const conditionIds = getConditionFilter(query.condition);
    if (conditionIds.length > 0) {
      const currentFilter = searchUrl.searchParams.get('filter') || '';
      const conditionFilter = `conditions:{${conditionIds.join('|')}}`;
      searchUrl.searchParams.set('filter', `${currentFilter},${conditionFilter}`);
      console.log(`[ebay-sold] Filtering by condition: ${query.condition} (IDs: ${conditionIds.join(', ')})`);
    }

    console.log(`[ebay-sold] API URL: ${searchUrl.toString()}`);

    const response = await fetch(searchUrl.toString(), {
      headers: {
        'Authorization': `Bearer ${access_token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      console.error(`[ebay-sold] API error: ${response.status} ${response.statusText}`, {
        preview: errorText.slice(0, 500),
      });
      return empty;
    }

    const data = await response.json();
    const items = data?.itemSummaries || [];

    console.log(`[ebay-sold] Found ${items.length} total items from API`);

    // Extract and filter samples
    const samples: SoldPriceSample[] = [];

    for (const item of items) {
      // Skip if no price data
      if (!item.price?.value) continue;

      // Check quantity match if specified
      if (!isQuantityMatch(item.quantity, query.quantity)) {
        continue;
      }

      // Check if item is sold (has ended)
      const itemEndDate = item.itemEndDate;
      if (!itemEndDate) continue; // Skip active listings

      // Extract price
      const price = parseFloat(item.price.value);
      if (!price || price <= 0) continue;

      samples.push({
        price: Math.round(price * 100) / 100, // Round to 2 decimals
        currency: item.price.currency || 'USD',
        url: item.itemWebUrl,
        endedAt: itemEndDate,
      });
    }

    console.log(`[ebay-sold] Filtered to ${samples.length} valid samples (after quantity filter)`);

    // Compute statistics if we have enough samples
    if (samples.length === 0) {
      console.warn(`[ebay-sold] No sold items found for query:`, {
        searchType,
        title: query.title,
        brand: query.brand,
        upc: query.upc,
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
      searchType,
      title: query.title,
      brand: query.brand,
      upc: query.upc,
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
