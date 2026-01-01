/**
 * RapidAPI Product Search - Multi-source price lookup
 * Uses Google Shopping aggregation API for real-time pricing
 * 
 * This replaces the Perplexity web search for more structured data.
 */

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = "product-search-api.p.rapidapi.com";

export interface RapidAPIProductResult {
  title: string;
  source: string;
  price: string;
  link?: string;
  imageUrl?: string;
  rating?: number;
  ratingCount?: number;
  productId?: string;
}

export interface RapidAPIPriceResult {
  price: number | null;
  source: string;
  url: string | null;
  allResults: RapidAPIProductResult[];
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
}

/**
 * Search for a product and return pricing from multiple sources
 */
export async function searchProductPrice(
  brand: string,
  productName: string,
  additionalContext?: string
): Promise<RapidAPIPriceResult> {
  if (!RAPIDAPI_KEY) {
    console.log('[rapidapi] No API key configured, skipping');
    return {
      price: null,
      source: 'not-found',
      url: null,
      allResults: [],
      confidence: 'low',
      reasoning: 'RapidAPI key not configured',
    };
  }

  // Build search query
  const searchQuery = [brand, productName, additionalContext]
    .filter(Boolean)
    .join(' ')
    .slice(0, 150); // Limit query length

  console.log(`[rapidapi] Searching: "${searchQuery}"`);

  try {
    const url = "https://product-search-api.p.rapidapi.com/shopping";
    
    const formData = new URLSearchParams();
    formData.append("query", searchQuery);
    formData.append("country", "us");
    
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-RapidAPI-Key": RAPIDAPI_KEY,
        "X-RapidAPI-Host": RAPIDAPI_HOST,
      },
      body: formData.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[rapidapi] API Error ${response.status}: ${errorText}`);
      return {
        price: null,
        source: 'error',
        url: null,
        allResults: [],
        confidence: 'low',
        reasoning: `API error: ${response.status}`,
      };
    }

    const data = await response.json();
    const products: RapidAPIProductResult[] = data.products || [];

    if (products.length === 0) {
      console.log('[rapidapi] No results found');
      return {
        price: null,
        source: 'not-found',
        url: null,
        allResults: [],
        confidence: 'low',
        reasoning: 'No products found in search results',
      };
    }

    console.log(`[rapidapi] Found ${products.length} results`);

    // Normalize brand for matching
    const brandLower = brand.toLowerCase().replace(/[^a-z0-9]/g, '');
    
    // Find best match - prefer brand match, then official sources
    const preferredSources = [
      // Brand's own site
      brand.toLowerCase(),
      // Major retailers (more reliable pricing)
      'amazon',
      'target',
      'walmart',
      'gnc',
      'cvs',
      'walgreens',
      'iherb',
      'vitacost',
      'nordstrom',
      'sephora',
      'ulta',
      // Brand-related
      brandLower,
    ];

    // Score each result
    const scoredResults = products.map((p, index) => {
      const sourceLower = (p.source || '').toLowerCase();
      const titleLower = (p.title || '').toLowerCase();
      
      let score = 0;
      
      // Position bonus (first results are usually more relevant)
      score += Math.max(0, 10 - index);
      
      // Brand match in title
      if (titleLower.includes(brandLower)) {
        score += 20;
      }
      
      // Preferred source bonus
      for (let i = 0; i < preferredSources.length; i++) {
        if (sourceLower.includes(preferredSources[i])) {
          score += 15 - i; // Higher bonus for earlier in list
          break;
        }
      }
      
      // Penalize eBay (often reseller prices, not MSRP)
      if (sourceLower.includes('ebay')) {
        score -= 5;
      }
      
      // Has rating = more legitimate
      if (p.rating && p.ratingCount && p.ratingCount > 10) {
        score += 5;
      }

      return { product: p, score };
    });

    // Sort by score
    scoredResults.sort((a, b) => b.score - a.score);
    
    const bestMatch = scoredResults[0]?.product;
    
    if (!bestMatch) {
      return {
        price: null,
        source: 'not-found',
        url: null,
        allResults: products,
        confidence: 'low',
        reasoning: 'No suitable product match found',
      };
    }

    // Parse price
    const priceStr = bestMatch.price || '';
    const priceNum = parseFloat(priceStr.replace(/[^0-9.]/g, ''));
    
    if (isNaN(priceNum) || priceNum <= 0) {
      console.log(`[rapidapi] Could not parse price: "${priceStr}"`);
      return {
        price: null,
        source: 'parse-error',
        url: null,
        allResults: products,
        confidence: 'low',
        reasoning: `Could not parse price: ${priceStr}`,
      };
    }

    // Determine confidence
    const sourceLower = (bestMatch.source || '').toLowerCase();
    const titleLower = (bestMatch.title || '').toLowerCase();
    const hasBrandMatch = titleLower.includes(brandLower);
    const isOfficialSource = sourceLower.includes(brandLower) || 
      preferredSources.slice(0, 10).some(s => sourceLower.includes(s));

    let confidence: 'high' | 'medium' | 'low' = 'low';
    if (hasBrandMatch && isOfficialSource) {
      confidence = 'high';
    } else if (hasBrandMatch || isOfficialSource) {
      confidence = 'medium';
    }

    console.log(`[rapidapi] ✓ Best match: ${bestMatch.price} from ${bestMatch.source} (${confidence} confidence)`);
    console.log(`[rapidapi]   Title: "${bestMatch.title?.slice(0, 60)}..."`);

    return {
      price: priceNum,
      source: bestMatch.source || 'unknown',
      url: bestMatch.link || null,
      allResults: products,
      confidence,
      reasoning: `Found ${products.length} results. Best match: "${bestMatch.title}" from ${bestMatch.source}`,
    };

  } catch (error) {
    console.error('[rapidapi] Error:', error);
    return {
      price: null,
      source: 'error',
      url: null,
      allResults: [],
      confidence: 'low',
      reasoning: `Error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Get Amazon-specific result from search results
 */
export function findAmazonResult(results: RapidAPIProductResult[]): RapidAPIProductResult | null {
  return results.find(r => 
    (r.source || '').toLowerCase().includes('amazon')
  ) || null;
}

/**
 * Get brand's own site result from search results  
 */
export function findBrandResult(results: RapidAPIProductResult[], brand: string): RapidAPIProductResult | null {
  const brandLower = brand.toLowerCase().replace(/[^a-z0-9]/g, '');
  return results.find(r => 
    (r.source || '').toLowerCase().includes(brandLower)
  ) || null;
}
