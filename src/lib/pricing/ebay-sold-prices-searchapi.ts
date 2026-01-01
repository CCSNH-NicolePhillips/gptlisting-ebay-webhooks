/**
 * Fetch eBay sold/completed item pricing data using SearchAPI.io
 * 
 * Replaces deprecated eBay Finding API (findCompletedItems).
 * Uses SearchAPI.io to scrape eBay sold listings for competitive pricing.
 */

// Rate limiting: Conservative 1 call/second for SearchAPI.io
let lastCallTime = 0;
const MIN_CALL_INTERVAL_MS = 1000;

async function rateLimitDelay() {
  const now = Date.now();
  const timeSinceLastCall = now - lastCallTime;
  if (timeSinceLastCall < MIN_CALL_INTERVAL_MS) {
    const delayNeeded = MIN_CALL_INTERVAL_MS - timeSinceLastCall;
    await new Promise(resolve => setTimeout(resolve, delayNeeded));
  }
  lastCallTime = Date.now();
}

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
  samplesCount?: number;
  rateLimited?: boolean;
}

export interface SoldPriceQuery {
  title: string;
  brand?: string;
  upc?: string;
  condition?: 'NEW' | 'USED' | 'OTHER';
  quantity?: number;
  userId?: string; // Ignored - no longer needed
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, index)];
}

/**
 * Fetch sold price statistics from eBay completed listings via SearchAPI.io
 * 
 * Replaces deprecated Finding API with SearchAPI.io scraping.
 */
export async function fetchSoldPriceStats(
  query: SoldPriceQuery
): Promise<SoldPriceStats> {
  const empty: SoldPriceStats = { ok: false, samples: [] };

  // Check if SearchAPI key is available
  const apiKey = process.env.SEARCHAPI_KEY;
  if (!apiKey) {
    console.log('[ebay-sold] No SEARCHAPI_KEY - skipping eBay sold prices');
    return { ...empty, rateLimited: true };
  }

  try {
    // Build search query
    const keywords = [query.brand, query.title].filter(Boolean).join(' ');
    console.log(`[ebay-sold] Searching sold items via SearchAPI.io: "${keywords}"`);

    const params = new URLSearchParams({
      engine: 'ebay',
      ebay_domain: 'ebay.com',
      q: keywords,
      _show_sold: '1', // Critical: show sold/completed items only
      LH_Complete: '1',
      LH_Sold: '1',
    });

    if (query.condition === 'NEW') {
      params.set('LH_ItemCondition', '1000'); // New
    } else if (query.condition === 'USED') {
      params.set('LH_ItemCondition', '3000'); // Used
    }

    const url = `https://www.searchapi.io/api/v1/search?${params.toString()}`;
    
    await rateLimitDelay();

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[ebay-sold] SearchAPI error ${response.status}:`, errorText);
      return { ...empty, rateLimited: response.status === 429 };
    }

    const data: any = await response.json();
    
    if (!data.organic_results || data.organic_results.length === 0) {
      console.log('[ebay-sold] No sold items found');
      return empty;
    }

    console.log(`[ebay-sold] Found ${data.organic_results.length} sold items`);

    // Parse sold items
    const samples: SoldPriceSample[] = [];
    for (const item of data.organic_results) {
      // Extract price from various possible fields
      let priceValue: number | undefined;
      
      if (item.price?.value) {
        priceValue = parseFloat(item.price.value);
      } else if (item.price?.raw) {
        const match = item.price.raw.match(/[\d,]+\.\d+/);
        if (match) priceValue = parseFloat(match[0].replace(/,/g, ''));
      } else if (typeof item.price === 'string') {
        const match = item.price.match(/[\d,]+\.\d+/);
        if (match) priceValue = parseFloat(match[0].replace(/,/g, ''));
      }

      if (priceValue && priceValue > 0) {
        samples.push({
          price: priceValue,
          currency: 'USD',
          url: item.link,
        });
      }
    }

    console.log(`[ebay-sold] Parsed ${samples.length} valid price samples`);

    if (samples.length === 0) {
      return empty;
    }

    // Sort and compute statistics
    const prices = samples.map(s => s.price).sort((a, b) => a - b);
    const median = percentile(prices, 0.5);
    const p35 = percentile(prices, 0.35);
    const p10 = percentile(prices, 0.1);
    const p90 = percentile(prices, 0.9);

    const result: SoldPriceStats = {
      ok: samples.length >= 3, // Need at least 3 samples for reliable stats
      samples,
      median,
      p35,
      p10,
      p90,
      samplesCount: samples.length,
    };

    console.log(`[ebay-sold] Statistics:`, {
      samplesCount: result.samplesCount,
      median: result.median?.toFixed(2),
      p35: result.p35?.toFixed(2),
      p10: result.p10?.toFixed(2),
      p90: result.p90?.toFixed(2),
    });

    return result;

  } catch (error: any) {
    console.error('[ebay-sold] Error fetching sold prices:', error.message);
    return empty;
  }
}
