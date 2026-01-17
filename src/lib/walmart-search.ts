/**
 * Walmart Search via SearchAPI.io
 * 
 * Direct Walmart product search API - provides coverage for products
 * that may not be on Amazon or indexed by Google Shopping.
 * 
 * @see https://www.searchapi.io/docs/walmart-search-api
 */

const SEARCHAPI_KEY = process.env.SEARCHAPI_KEY;
const SEARCHAPI_BASE = "https://www.searchapi.io/api/v1/search";

export interface WalmartSearchResult {
  id: string;
  product_id: string;
  title: string;
  link: string;
  description?: string;
  thumbnail?: string;
  rating?: number;
  reviews?: number;
  price?: string;
  extracted_price?: number;
  original_price?: string;
  extracted_original_price?: number;
  unit_price?: string;
  extracted_unit_price?: number;
  seller_id?: string;
  seller_name?: string;
  two_day_shipping?: boolean;
  sponsored?: boolean;
  special_offer_text?: string;
  variants?: Array<{
    id: string;
    title: string;
    link: string;
    thumbnail?: string;
  }>;
}

export interface WalmartSearchResponse {
  search_metadata: {
    id: string;
    status: string;
    created_at: string;
    request_time_taken: number;
    total_time_taken: number;
    request_url: string;
  };
  search_parameters: {
    engine: string;
    q: string;
  };
  organic_results?: WalmartSearchResult[];
  error?: string;
}

export interface WalmartPriceLookupResult {
  price: number | null;
  originalPrice: number | null;
  url: string | null;
  productId: string | null;
  title: string | null;
  seller: string | null;
  isTwoDayShipping: boolean;
  rating: number | null;
  reviews: number | null;
  allResults: WalmartSearchResult[];
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
}

/**
 * Search Walmart directly for a product
 * 
 * @param brand - Product brand (e.g., "Panda's Promise")
 * @param productName - Product name with size/count (e.g., "Immune Support Gummies 60ct")
 * @param maxResults - Maximum results to return (default: 10)
 */
export async function searchWalmart(
  brand: string,
  productName: string,
  maxResults: number = 10
): Promise<WalmartPriceLookupResult> {
  if (!SEARCHAPI_KEY) {
    console.log('[walmart-search] No SEARCHAPI_KEY configured, skipping');
    return {
      price: null,
      originalPrice: null,
      url: null,
      productId: null,
      title: null,
      seller: null,
      isTwoDayShipping: false,
      rating: null,
      reviews: null,
      allResults: [],
      confidence: 'low',
      reasoning: 'SEARCHAPI_KEY not configured',
    };
  }

  // Build search query - brand + product name
  const searchQuery = [brand, productName]
    .filter(Boolean)
    .join(' ')
    .trim()
    .slice(0, 200); // Limit query length

  console.log(`[walmart-search] Searching: "${searchQuery}"`);

  try {
    const url = new URL(SEARCHAPI_BASE);
    url.searchParams.set('engine', 'walmart_search');
    url.searchParams.set('q', searchQuery);
    url.searchParams.set('api_key', SEARCHAPI_KEY);

    const response = await fetch(url.toString());
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[walmart-search] API Error ${response.status}: ${errorText}`);
      return {
        price: null,
        originalPrice: null,
        url: null,
        productId: null,
        title: null,
        seller: null,
        isTwoDayShipping: false,
        rating: null,
        reviews: null,
        allResults: [],
        confidence: 'low',
        reasoning: `API error: ${response.status}`,
      };
    }

    const data: WalmartSearchResponse = await response.json();

    if (data.error) {
      console.error(`[walmart-search] API returned error: ${data.error}`);
      return {
        price: null,
        originalPrice: null,
        url: null,
        productId: null,
        title: null,
        seller: null,
        isTwoDayShipping: false,
        rating: null,
        reviews: null,
        allResults: [],
        confidence: 'low',
        reasoning: data.error,
      };
    }

    const results = data.organic_results || [];
    
    if (results.length === 0) {
      console.log('[walmart-search] No results found');
      return {
        price: null,
        originalPrice: null,
        url: null,
        productId: null,
        title: null,
        seller: null,
        isTwoDayShipping: false,
        rating: null,
        reviews: null,
        allResults: [],
        confidence: 'low',
        reasoning: 'No products found on Walmart',
      };
    }

    console.log(`[walmart-search] Found ${results.length} results`);

    // Lot/multi-pack filter patterns
    const LOT_PATTERNS = [
      /\bpack\s+of\s+\d+/i,
      /\b\d+\s*-?\s*pack\b/i,
      /\blot\s+of\s+\d+/i,
      /\bset\s+of\s+\d+/i,
      /\bbundle\s+of\s+\d+/i,
      /\(\s*pack\s+of\s+\d+\s*\)/i,
      /,\s*\d+\s*pack\b/i,
      /\bqty\s*:?\s*\d+\b/i,
      /\b3[\s-]*pack\b/i,
      /\b2[\s-]*pack\b/i,
      /\b4[\s-]*pack\b/i,
    ];
    
    const isLotListing = (title: string): boolean => {
      return LOT_PATTERNS.some(pattern => pattern.test(title));
    };

    // Title matching - verify the result is actually the same product
    const isTitleMatch = (resultTitle: string, searchBrand: string): boolean => {
      const normalize = (s: string): string[] => {
        return s.toLowerCase()
          .replace(/[^a-z0-9\s]/g, ' ')
          .split(/\s+/)
          .filter(w => w.length > 2)
          .filter(w => !['the', 'and', 'for', 'with', 'new'].includes(w));
      };

      const brandWords = normalize(searchBrand);
      const titleLower = resultTitle.toLowerCase();

      // Check if brand matches
      const brandInTitle = brandWords.some(bw => titleLower.includes(bw));

      if (!brandInTitle && brandWords.length > 0) {
        console.log(`[walmart-search] ❌ Brand mismatch: "${searchBrand}" not in "${resultTitle.slice(0, 60)}"`);
        return false;
      }

      return true;
    };

    // Filter and score results
    const scoredResults: Array<{
      result: WalmartSearchResult;
      score: number;
      reasons: string[];
    }> = [];

    for (const result of results.slice(0, maxResults)) {
      const reasons: string[] = [];
      let score = 100;

      // Skip if no price
      if (!result.extracted_price || result.extracted_price <= 0) {
        console.log(`[walmart-search] Skipping result with no price: "${result.title?.slice(0, 50)}"`);
        continue;
      }

      // Skip lot listings
      if (isLotListing(result.title)) {
        console.log(`[walmart-search] Skipping lot/bundle: "${result.title?.slice(0, 60)}"`);
        continue;
      }

      // Check brand match
      if (!isTitleMatch(result.title, brand)) {
        continue;
      }

      // Scoring bonuses
      if (result.two_day_shipping) {
        score += 10;
        reasons.push('2-day shipping');
      }

      // Prefer Walmart.com as seller (1st party)
      if (result.seller_name === 'Walmart.com') {
        score += 15;
        reasons.push('Sold by Walmart');
      }

      // Skip sponsored results (often less relevant)
      if (result.sponsored) {
        score -= 10;
        reasons.push('Sponsored');
      }

      // High ratings bonus
      if (result.rating && result.rating >= 4.0) {
        score += 5;
        reasons.push(`${result.rating}★`);
      }

      // Reviews count bonus (social proof)
      if (result.reviews && result.reviews >= 100) {
        score += 5;
        reasons.push(`${result.reviews} reviews`);
      }

      scoredResults.push({ result, score, reasons });
    }

    if (scoredResults.length === 0) {
      console.log('[walmart-search] No matching products after filtering');
      return {
        price: null,
        originalPrice: null,
        url: null,
        productId: null,
        title: null,
        seller: null,
        isTwoDayShipping: false,
        rating: null,
        reviews: null,
        allResults: results,
        confidence: 'low',
        reasoning: 'No matching products found after filtering',
      };
    }

    // Sort by score descending
    scoredResults.sort((a, b) => b.score - a.score);

    const best = scoredResults[0];
    const bestResult = best.result;

    console.log(`[walmart-search] ✅ Best match: "${bestResult.title?.slice(0, 60)}" @ $${bestResult.extracted_price} (${best.reasons.join(', ')})`);

    // Determine confidence
    let confidence: 'high' | 'medium' | 'low' = 'medium';
    if (best.score >= 120 && bestResult.reviews && bestResult.reviews >= 50) {
      confidence = 'high';
    } else if (best.score < 100) {
      confidence = 'low';
    }

    return {
      price: bestResult.extracted_price || null,
      originalPrice: bestResult.extracted_original_price || null,
      url: bestResult.link || null,
      productId: bestResult.product_id || null,
      title: bestResult.title || null,
      seller: bestResult.seller_name || null,
      isTwoDayShipping: bestResult.two_day_shipping || false,
      rating: bestResult.rating || null,
      reviews: bestResult.reviews || null,
      allResults: results,
      confidence,
      reasoning: `Best Walmart result: ${best.reasons.join(', ') || 'matched'}`,
    };

  } catch (error) {
    console.error('[walmart-search] Error:', error);
    return {
      price: null,
      originalPrice: null,
      url: null,
      productId: null,
      title: null,
      seller: null,
      isTwoDayShipping: false,
      rating: null,
      reviews: null,
      allResults: [],
      confidence: 'low',
      reasoning: `Error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Get Walmart price with fallback behavior
 * Convenience wrapper for the pricing pipeline
 */
export async function getWalmartPrice(
  brand: string,
  productName: string
): Promise<{ price: number | null; url: string | null; confidence: string; source: string }> {
  const result = await searchWalmart(brand, productName);

  if (result.price) {
    return {
      price: result.price,
      url: result.url,
      confidence: result.confidence,
      source: 'walmart-direct',
    };
  }

  return {
    price: null,
    url: null,
    confidence: 'none',
    source: 'walmart-not-found',
  };
}
