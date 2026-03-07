/**
 * Amazon Search via SearchAPI.io
 * 
 * Direct Amazon product search API - provides better coverage than Google Shopping
 * for niche products that aren't indexed by Google Shopping.
 * 
 * Use as fallback when Google Shopping returns no results.
 * 
 * @see https://www.searchapi.io/docs/amazon-search
 */

const SEARCHAPI_KEY = process.env.SEARCHAPI_KEY;
const SEARCHAPI_BASE = "https://www.searchapi.io/api/v1/search";

export interface AmazonSearchResult {
  position: number;
  asin: string;
  title: string;
  link: string;
  brand?: string;
  rating?: number;
  reviews?: number;
  recent_sales?: string;
  price?: string;
  extracted_price?: number;
  original_price?: string;
  extracted_original_price?: number;
  is_prime?: boolean;
  is_limited_time_deal?: boolean;
  is_overall_pick?: boolean;
  thumbnail?: string;
  availability?: string;
  fulfillment?: {
    standard_delivery?: { text: string; date?: string };
    fastest_delivery?: { text: string; date?: string };
  };
  attributes?: Array<{ name: string; value: string }>;
  more_offers?: {
    lowest_price?: string;
    extracted_lowest_price?: number;
    offers_count?: number;
  };
}

export interface AmazonSearchResponse {
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
    amazon_domain: string;
  };
  search_information?: {
    query_displayed: string;
    price_min?: string;
    extracted_price_min?: number;
    price_max?: string;
    extracted_price_max?: number;
  };
  organic_results?: AmazonSearchResult[];
  error?: string;
}

export interface AmazonPriceLookupResult {
  price: number | null;
  originalPrice: number | null;
  url: string | null;
  asin: string | null;
  title: string | null;
  brand: string | null;
  isPrime: boolean;
  rating: number | null;
  reviews: number | null;
  allResults: AmazonSearchResult[];
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
}

/**
 * List of untrusted third-party sellers on Amazon
 * These are often resellers with inflated prices
 */
const UNTRUSTED_AMAZON_SELLERS: string[] = [
  // These appear in the "availability" or seller name fields
  // Amazon themselves is trusted
];

/**
 * Search Amazon directly for a product
 * 
 * @param brand - Product brand (e.g., "Panda's Promise")
 * @param productName - Product name with size/count (e.g., "Immune Support Gummies 60ct")
 * @param maxResults - Maximum results to return (default: 10)
 */
export async function searchAmazon(
  brand: string,
  productName: string,
  maxResults: number = 10
): Promise<AmazonPriceLookupResult> {
  if (!SEARCHAPI_KEY) {
    console.log('[amazon-search] No SEARCHAPI_KEY configured, skipping');
    return {
      price: null,
      originalPrice: null,
      url: null,
      asin: null,
      title: null,
      brand: null,
      isPrime: false,
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

  console.log(`[amazon-search] Searching: "${searchQuery}"`);

  try {
    const url = new URL(SEARCHAPI_BASE);
    url.searchParams.set('engine', 'amazon_search');
    url.searchParams.set('q', searchQuery);
    url.searchParams.set('api_key', SEARCHAPI_KEY);
    url.searchParams.set('amazon_domain', 'amazon.com');

    const response = await fetch(url.toString());
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[amazon-search] API Error ${response.status}: ${errorText}`);
      return {
        price: null,
        originalPrice: null,
        url: null,
        asin: null,
        title: null,
        brand: null,
        isPrime: false,
        rating: null,
        reviews: null,
        allResults: [],
        confidence: 'low',
        reasoning: `API error: ${response.status}`,
      };
    }

    const data: AmazonSearchResponse = await response.json();

    if (data.error) {
      console.error(`[amazon-search] API returned error: ${data.error}`);
      return {
        price: null,
        originalPrice: null,
        url: null,
        asin: null,
        title: null,
        brand: null,
        isPrime: false,
        rating: null,
        reviews: null,
        allResults: [],
        confidence: 'low',
        reasoning: data.error,
      };
    }

    const results = data.organic_results || [];
    
    if (results.length === 0) {
      console.log('[amazon-search] No results found');
      return {
        price: null,
        originalPrice: null,
        url: null,
        asin: null,
        title: null,
        brand: null,
        isPrime: false,
        rating: null,
        reviews: null,
        allResults: [],
        confidence: 'low',
        reasoning: 'No products found on Amazon',
      };
    }

    console.log(`[amazon-search] Found ${results.length} results`);

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
      /\b3[\s-]*pack\b/i,    // Specifically catch 3-pack bundles
      /\b2[\s-]*pack\b/i,    // 2-pack bundles
      /\b4[\s-]*pack\b/i,    // 4-pack bundles
    ];
    
    const isLotListing = (title: string): boolean => {
      return LOT_PATTERNS.some(pattern => pattern.test(title));
    };

    // Title matching - verify the result is actually the same product
    const isTitleMatch = (resultTitle: string | undefined, resultBrand: string | undefined, searchBrand: string): boolean | 'weak' => {
      // Skip results with no title
      if (!resultTitle) {
        console.log(`[amazon-search] Skipping result with no title`);
        return false;
      }
      
      const normalize = (s: string): string[] => {
        return s.toLowerCase()
          .replace(/[^a-z0-9\s]/g, ' ')
          .split(/\s+/)
          .filter(w => w.length > 2)
          .filter(w => !['the', 'and', 'for', 'with', 'new'].includes(w));
      };

      // Generic words that appear in many brand names AND product titles — not reliable
      // for distinguishing brands (e.g., "labs" in "XTRAPURE LABS" also appears in "Alpha Labs")
      const GENERIC_BRAND_WORDS = new Set([
        'labs', 'lab', 'co', 'corp', 'inc', 'llc', 'brand', 'brands',
        'health', 'healthcare', 'wellness', 'nutrition', 'nutritional',
        'natural', 'naturals', 'pure', 'life', 'living', 'bio',
      ]);

      const brandWords = normalize(searchBrand);
      // Use only specific (non-generic) brand words for title matching
      const specificBrandWords = brandWords.filter(w => !GENERIC_BRAND_WORDS.has(w));
      const matchBrandWords = specificBrandWords.length > 0 ? specificBrandWords : brandWords;
      const titleLower = resultTitle.toLowerCase();
      const resultBrandLower = resultBrand?.toLowerCase().trim() || '';

      // If API returns a brand field and it EXPLICITLY contradicts ours → hard reject
      if (resultBrandLower && brandWords.length > 0) {
        const apiMatchesOurs = brandWords.some(bw => resultBrandLower.includes(bw));
        if (!apiMatchesOurs) {
          // Check reverse: our brand words vs API brand
          const ourBrandNorm = normalize(searchBrand).join(' ');
          const apiBrandNorm = normalize(resultBrandLower).join(' ');
          // Only hard-reject if they share NO words and both are non-trivial
          if (ourBrandNorm.length > 3 && apiBrandNorm.length > 3 && !ourBrandNorm.includes(apiBrandNorm) && !apiBrandNorm.includes(ourBrandNorm)) {
            console.log(`[amazon-search] ❌ Brand mismatch: our="${searchBrand}" API brand="${resultBrand}"`);
            return false;
          }
        }
      }

      // Brand in title → strong match
      const brandInTitle = matchBrandWords.some(bw => titleLower.includes(bw));
      if (brandInTitle) return true;

      // Brand in API brand field → strong match
      const brandInApiField = matchBrandWords.some(bw => resultBrandLower.includes(bw));
      if (brandInApiField) return true;

      // Brand not in title AND API brand field is empty → weak match
      // Many brands store their name in Amazon's brand field only (not in title)
      // Don't reject — caller will score this lower
      if (brandWords.length > 0) {
        console.log(`[amazon-search] ⚠️  Brand "${searchBrand}" not in title/API-field — allowing with weak confidence (brand may be in Amazon's brand-registry only)`);
        return 'weak';
      }

      return true;
    };

    // Filter and score results
    const scoredResults: Array<{
      result: AmazonSearchResult;
      score: number;
      reasons: string[];
    }> = [];

    for (const result of results.slice(0, maxResults)) {
      const reasons: string[] = [];
      let score = 100;

      // Skip if no price
      if (!result.extracted_price || result.extracted_price <= 0) {
        console.log(`[amazon-search] Skipping result with no price: "${result.title?.slice(0, 50)}"`);
        continue;
      }

      // Skip lot listings
      if (isLotListing(result.title)) {
        console.log(`[amazon-search] Skipping lot/bundle: "${result.title?.slice(0, 60)}"`);
        continue;
      }

      // Check brand match
      const brandMatch = isTitleMatch(result.title, result.brand, brand);
      if (brandMatch === false) {
        continue;
      }
      if (brandMatch === 'weak') {
        // For weak brand matches, require that key product name words appear in the title.
        // Generic supplement/product terms don't count — we need specific identifying words.
        // Require at least 2 specific words (or 1 if the product name has only 1 specific word).
        const GENERIC_TERMS = new Set(['capsules','tablets','pills','powder','supplement',
          'cream','serum','lotion','stick','pack','packs','count','serving','servings',
          'vitamin','vitamins','formula','complex','blend','extract','bottle','packet','packets']);
        const titleLower = result.title?.toLowerCase() ?? '';
        const specificWords = productName.toLowerCase()
          .split(/\s+/)
          .filter(w => w.length > 3 && !GENERIC_TERMS.has(w) && !/^\d/.test(w));
        const wordsInTitle = specificWords.filter(w => titleLower.includes(w));
        const required = specificWords.length >= 2 ? 2 : 1;
        if (specificWords.length > 0 && wordsInTitle.length < required) {
          console.log(`[amazon-search] ❌ Weak brand — only ${wordsInTitle.length}/${required} specific words from "${productName}" found in title — rejecting`);
          continue;
        }
        score -= 20; // Penalize but don't discard — brand may be in Amazon's brand registry
      }

      // Scoring bonuses
      if (result.is_prime) {
        score += 10;
        reasons.push('Prime');
      }

      if (result.is_overall_pick) {
        score += 15;
        reasons.push('Overall Pick');
      }

      if (result.position === 1) {
        score += 5;
        reasons.push('Top result');
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
      console.log('[amazon-search] No matching products after filtering');
      return {
        price: null,
        originalPrice: null,
        url: null,
        asin: null,
        title: null,
        brand: null,
        isPrime: false,
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

    console.log(`[amazon-search] ✅ Best match: "${bestResult.title?.slice(0, 60)}" @ $${bestResult.extracted_price} (${best.reasons.join(', ')})`);

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
      asin: bestResult.asin || null,
      title: bestResult.title || null,
      brand: bestResult.brand || null,
      isPrime: bestResult.is_prime || false,
      rating: bestResult.rating || null,
      reviews: bestResult.reviews || null,
      allResults: results,
      confidence,
      reasoning: `Best Amazon result: ${best.reasons.join(', ') || 'matched'}`,
    };

  } catch (error) {
    console.error('[amazon-search] Error:', error);
    return {
      price: null,
      originalPrice: null,
      url: null,
      asin: null,
      title: null,
      brand: null,
      isPrime: false,
      rating: null,
      reviews: null,
      allResults: [],
      confidence: 'low',
      reasoning: `Error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Get Amazon price with fallback behavior
 * Convenience wrapper for the pricing pipeline
 */
export async function getAmazonPrice(
  brand: string,
  productName: string
): Promise<{ price: number | null; url: string | null; confidence: string; source: string }> {
  const result = await searchAmazon(brand, productName);

  if (result.price) {
    return {
      price: result.price,
      url: result.url,
      confidence: result.confidence,
      source: 'amazon-direct',
    };
  }

  return {
    price: null,
    url: null,
    confidence: 'none',
    source: 'amazon-not-found',
  };
}

/**
 * Search Amazon with brand-only fallback
 * 
 * For niche brands that have only one product line, searching by just the brand
 * can be more effective than brand + product name (which may differ on Amazon).
 * 
 * Example: Milamend is sold on Amazon but as "Hormone Balance for Women"
 * not "Hemp Seed Oil Capsules" - so searching "Milamend" alone finds it.
 * 
 * @param brand - Product brand
 * @param productName - Product name
 * @param tryBrandOnly - If true, try brand-only search as fallback
 */
export async function searchAmazonWithFallback(
  brand: string,
  productName: string,
  tryBrandOnly: boolean = true
): Promise<AmazonPriceLookupResult> {
  // First try the full brand + product search
  const fullResult = await searchAmazon(brand, productName);
  
  if (fullResult.price !== null && fullResult.confidence !== 'low') {
    return fullResult;
  }
  
  // If no result and brand-only fallback is enabled, try just the brand
  if (tryBrandOnly && brand && brand.length >= 3) {
    console.log(`[amazon-search] Brand+product search failed, trying brand-only: "${brand}"`);
    
    const brandOnlyResult = await searchAmazon(brand, '');
    
    if (brandOnlyResult.price !== null) {
      console.log(`[amazon-search] ✅ Brand-only fallback found: $${brandOnlyResult.price}`);
      return {
        ...brandOnlyResult,
        reasoning: `Brand-only fallback: ${brandOnlyResult.reasoning}`,
      };
    }
  }
  
  // Return original result (even if no match)
  return fullResult;
}
