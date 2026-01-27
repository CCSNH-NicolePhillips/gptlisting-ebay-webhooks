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
  price: number;           // Item price only
  shipping: number;        // Shipping cost (0 = free shipping)
  deliveredPrice: number;  // price + shipping
  currency: string;
  url?: string;
  endedAt?: string;
}

export interface SoldPriceStats {
  ok: boolean;
  samples: SoldPriceSample[];
  // Item-only stats (for reference)
  median?: number;
  p35?: number;
  p10?: number;
  p90?: number;
  // TRUE DELIVERED stats (item + shipping) - use these for pricing!
  deliveredMedian?: number;
  deliveredP35?: number;
  deliveredP10?: number;
  deliveredP90?: number;
  avgShipping?: number;
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
      engine: 'ebay_search',
      ebay_domain: 'ebay.com',
      q: keywords,
      ebay_tbs: 'LH_Complete:1,LH_Sold:1', // Sold/completed items filter
    });

    if (query.condition === 'NEW') {
      params.append('ebay_tbs', 'LH_ItemCondition:1000');
    } else if (query.condition === 'USED') {
      params.append('ebay_tbs', 'LH_ItemCondition:3000');
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

    // Title matching - verify the result is actually the same product
    // Uses bidirectional matching: checks if query words appear in title OR if title words appear in query
    const isTitleMatch = (resultTitle: string, searchQuery: string): boolean => {
      // Normalize both strings
      const normalize = (s: string): string[] => {
        return s.toLowerCase()
          .replace(/[^a-z0-9\s]/g, ' ')  // Remove punctuation
          .split(/\s+/)                   // Split on whitespace
          .filter(w => w.length > 2)      // Ignore tiny words
          .filter(w => !['the', 'and', 'for', 'with', 'new', 'nib', 'sealed'].includes(w)); // Common words
      };
      
      const queryWords = normalize(searchQuery);
      const titleWords = normalize(resultTitle);
      
      if (queryWords.length === 0) return true;
      
      // Count how many query words appear in the title (forward match)
      const forwardMatchCount = queryWords.filter(qw => 
        titleWords.some(tw => tw.includes(qw) || qw.includes(tw))
      ).length;
      
      const forwardMatchRatio = forwardMatchCount / queryWords.length;
      
      // ALSO check reverse: what % of title words appear in query (handles abbreviated titles)
      const reverseMatchCount = titleWords.filter(tw =>
        queryWords.some(qw => tw.includes(qw) || qw.includes(tw))
      ).length;
      
      const reverseMatchRatio = titleWords.length > 0 ? reverseMatchCount / titleWords.length : 0;
      
      // Pass if EITHER:
      // 1. 60% of query words appear in title (lowered from 70% - sellers use different keywords), OR
      // 2. 80% of title words appear in query AND title has 2+ meaningful words (subset match), OR
      // 3. Brand+product core words match (e.g., "Hallosmine Ultra" matches even if other keywords differ)
      const forwardMatch = forwardMatchRatio >= 0.6;
      const reverseMatch = reverseMatchRatio >= 0.8 && titleWords.length >= 2;
      
      // Core word match: if the most distinctive words match, it's likely the same product
      // Sort by length (longer = more distinctive) and take top 3
      const coreWords = [...queryWords].sort((a, b) => b.length - a.length).slice(0, 3);
      const coreMatchCount = coreWords.filter(cw => 
        titleWords.some(tw => tw.includes(cw) || cw.includes(tw))
      ).length;
      const coreMatch = coreWords.length >= 2 && coreMatchCount >= 2; // At least 2 core words must match
      
      return forwardMatch || reverseMatch || coreMatch;
    };

    // Lot detection patterns - these indicate multi-packs that inflate prices
    const LOT_PATTERNS = [
      /\blot\s*(of\s*)?\d+/i,          // "lot of 2", "lot 3"
      /\b(\d+)\s*pack\b/i,             // "2 pack", "3pack"
      /\bset\s*(of\s*)?\d+/i,          // "set of 2"
      /\bbundle\s*(of\s*)?\d+/i,       // "bundle of 3"
      /\b(\d+)\s*count\b/i,            // "2 count" (but not "90 count" for pills)
      /\bx\s*\d+\b/i,                  // "x2", "x 3"
      /\b(\d+)\s*bottles?\b/i,         // "2 bottles"
      /\b(\d+)\s*pieces?\b/i,          // "2 pieces" (but not "90 pieces" for gum)
      /\bmulti[-\s]?pack/i,            // "multi-pack", "multipack"
      /\b(\d+)\s*boxes?\s*(of\s*)?\d+/i, // "2 boxes of 6", "6 boxes 6"
      /\bcase\s*(of\s*)?\d+/i,         // "case of 12", "case 24"
    ];
    
    function isLotListing(title: string, searchTitle?: string): boolean {
      if (!title) return false;
      const lower = title.toLowerCase();
      
      // NEW: If the search is for a specific pack size (e.g., "6 pack"),
      // detect if the listing has a DIFFERENT pack size
      if (searchTitle) {
        const searchPackMatch = searchTitle.match(/\b(\d+)\s*pack\b/i);
        const titlePackMatch = title.match(/\b(\d+)\s*pack\b/i);
        if (searchPackMatch && titlePackMatch) {
          const searchPack = parseInt(searchPackMatch[1], 10);
          const titlePack = parseInt(titlePackMatch[1], 10);
          // If the listing's pack size is different from search, it's wrong
          if (titlePack !== searchPack && titlePack > 1) {
            return true;
          }
        }
      }
      
      for (const pattern of LOT_PATTERNS) {
        const match = title.match(pattern);
        if (match) {
          // For patterns with numbers, only flag if quantity is 2-10 (not 90 pieces gum, etc.)
          const numMatch = match[1] || match[0].match(/\d+/)?.[0];
          if (numMatch) {
            const qty = parseInt(numMatch, 10);
            if (qty >= 2 && qty <= 10) {
              return true;
            }
          } else {
            // Pattern without captured number (like "multi-pack")
            return true;
          }
        }
      }
      return false;
    }

    // Parse sold items - now including shipping for TRUE delivered price
    const samples: SoldPriceSample[] = [];
    let lotsSkipped = 0;
    let titleMismatchSkipped = 0;
    
    for (const item of data.organic_results) {
      // Skip lot listings - they inflate prices
      // Pass the search keywords to detect pack size mismatches
      if (isLotListing(item.title, keywords)) {
        lotsSkipped++;
        continue;
      }
      
      // Skip title mismatches - wrong products contaminate pricing
      if (!isTitleMatch(item.title || '', keywords)) {
        titleMismatchSkipped++;
        continue;
      }
      
      // Extract item price
      let priceValue: number | undefined;
      
      if (item.extracted_price !== undefined) {
        priceValue = parseFloat(item.extracted_price);
      } else if (item.price?.value) {
        priceValue = parseFloat(item.price.value);
      } else if (item.price?.raw) {
        const match = item.price.raw.match(/[\d,]+\.\d+/);
        if (match) priceValue = parseFloat(match[0].replace(/,/g, ''));
      } else if (typeof item.price === 'string') {
        const match = item.price.match(/[\d,]+\.\d+/);
        if (match) priceValue = parseFloat(match[0].replace(/,/g, ''));
      }

      // Extract shipping cost
      let shippingValue = 0;
      if (item.extracted_shipping !== undefined) {
        shippingValue = parseFloat(item.extracted_shipping) || 0;
      } else if (typeof item.shipping === 'string') {
        const lower = item.shipping.toLowerCase();
        if (lower.includes('free')) {
          shippingValue = 0;
        } else {
          const match = item.shipping.match(/\$?([\d,]+\.?\d*)/);
          if (match) shippingValue = parseFloat(match[1].replace(/,/g, '')) || 0;
        }
      }

      if (priceValue && priceValue > 0) {
        const deliveredPrice = priceValue + shippingValue;
        samples.push({
          price: priceValue,
          shipping: shippingValue,
          deliveredPrice,
          currency: 'USD',
          url: item.link,
        });
      }
    }

    if (lotsSkipped > 0) {
      console.log(`[ebay-sold] Filtered out ${lotsSkipped} lot/multi-pack listings`);
    }
    if (titleMismatchSkipped > 0) {
      console.log(`[ebay-sold] Filtered out ${titleMismatchSkipped} title mismatches`);
    }
    console.log(`[ebay-sold] Parsed ${samples.length} valid title-matched samples`);

    if (samples.length === 0) {
      return empty;
    }

    // Sort and compute statistics for ITEM prices (for reference)
    const prices = samples.map(s => s.price).sort((a, b) => a - b);
    const median = percentile(prices, 0.5);
    const p35 = percentile(prices, 0.35);
    const p10 = percentile(prices, 0.1);
    const p90 = percentile(prices, 0.9);

    // Compute TRUE DELIVERED price stats (item + shipping)
    const deliveredPrices = samples.map(s => s.deliveredPrice).sort((a, b) => a - b);
    const deliveredMedian = percentile(deliveredPrices, 0.5);
    const deliveredP35 = percentile(deliveredPrices, 0.35);
    const deliveredP10 = percentile(deliveredPrices, 0.1);
    const deliveredP90 = percentile(deliveredPrices, 0.9);

    // Average shipping for reference
    const avgShipping = samples.reduce((sum, s) => sum + s.shipping, 0) / samples.length;

    const result: SoldPriceStats = {
      ok: samples.length >= 3, // Need at least 3 samples for reliable stats
      samples,
      median,
      p35,
      p10,
      p90,
      deliveredMedian,
      deliveredP35,
      deliveredP10,
      deliveredP90,
      avgShipping,
      samplesCount: samples.length,
    };

    console.log(`[ebay-sold] Statistics:`, {
      samplesCount: result.samplesCount,
      itemMedian: result.median?.toFixed(2),
      deliveredMedian: result.deliveredMedian?.toFixed(2),
      avgShipping: result.avgShipping?.toFixed(2),
      deliveredP10: result.deliveredP10?.toFixed(2),
      deliveredP90: result.deliveredP90?.toFixed(2),
    });

    return result;

  } catch (error: any) {
    console.error('[ebay-sold] Error fetching sold prices:', error.message);
    return empty;
  }
}
