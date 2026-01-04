/**
 * Google Shopping Search via SearchAPI.io
 * 
 * Replaces the Brave + RapidAPI + GPT extraction chain with a single API call
 * that returns pre-parsed structured pricing data.
 * 
 * Pricing: ~$0.01/search ($50/month for 5,000 searches)
 */

const SEARCHAPI_KEY = process.env.SEARCHAPI_KEY;
const SEARCHAPI_BASE = "https://www.searchapi.io/api/v1/search";

export interface GoogleShoppingResult {
  position: number;
  title: string;
  price: string;
  extracted_price: number;
  original_price?: string;
  extracted_original_price?: number;
  currency?: string;
  seller: string;
  link?: string;
  product_link?: string;
  rating?: number;
  reviews?: number;
  delivery?: string;
  stock_information?: string;
  thumbnail?: string;
}

export interface GoogleShoppingResponse {
  search_metadata: {
    id: string;
    status: string;
    created_at: string;
    request_time_taken: number;
    total_time_taken: number;
  };
  search_parameters: {
    engine: string;
    q: string;
  };
  shopping_results?: GoogleShoppingResult[];
  error?: string;
}

export interface PriceLookupResult {
  amazonPrice: number | null;
  amazonUrl: string | null;
  walmartPrice: number | null;
  walmartUrl: string | null;
  targetPrice: number | null;
  targetUrl: string | null;
  bestPrice: number | null;
  bestPriceSource: string | null;
  bestPriceUrl: string | null;
  allResults: GoogleShoppingResult[];
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
}

/**
 * Search Google Shopping for a product and return structured pricing
 * 
 * @param brand - Product brand (e.g., "NOW Foods")
 * @param productName - Product name with size/count (e.g., "Vitamin D3 5000 IU 240 Softgels")
 * @param additionalContext - Optional extra search terms
 */
export async function searchGoogleShopping(
  brand: string,
  productName: string,
  additionalContext?: string
): Promise<PriceLookupResult> {
  if (!SEARCHAPI_KEY) {
    console.log('[google-shopping] No SEARCHAPI_KEY configured, skipping');
    return {
      amazonPrice: null,
      amazonUrl: null,
      walmartPrice: null,
      walmartUrl: null,
      targetPrice: null,
      targetUrl: null,
      bestPrice: null,
      bestPriceSource: null,
      bestPriceUrl: null,
      allResults: [],
      confidence: 'low',
      reasoning: 'SEARCHAPI_KEY not configured',
    };
  }

  // Build search query - brand + product name
  const searchQuery = [brand, productName, additionalContext]
    .filter(Boolean)
    .join(' ')
    .trim()
    .slice(0, 200); // Limit query length

  console.log(`[google-shopping] Searching: "${searchQuery}"`);

  try {
    const url = new URL(SEARCHAPI_BASE);
    url.searchParams.set('engine', 'google_shopping');
    url.searchParams.set('q', searchQuery);
    url.searchParams.set('api_key', SEARCHAPI_KEY);
    url.searchParams.set('gl', 'us'); // US market
    url.searchParams.set('hl', 'en'); // English

    const response = await fetch(url.toString());
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[google-shopping] API Error ${response.status}: ${errorText}`);
      return {
        amazonPrice: null,
        amazonUrl: null,
        walmartPrice: null,
        walmartUrl: null,
        targetPrice: null,
        targetUrl: null,
        bestPrice: null,
        bestPriceSource: null,
        bestPriceUrl: null,
        allResults: [],
        confidence: 'low',
        reasoning: `API error: ${response.status}`,
      };
    }

    const data: GoogleShoppingResponse = await response.json();

    if (data.error) {
      console.error(`[google-shopping] API returned error: ${data.error}`);
      return {
        amazonPrice: null,
        amazonUrl: null,
        walmartPrice: null,
        walmartUrl: null,
        targetPrice: null,
        targetUrl: null,
        bestPrice: null,
        bestPriceSource: null,
        bestPriceUrl: null,
        allResults: [],
        confidence: 'low',
        reasoning: data.error,
      };
    }

    const results = data.shopping_results || [];
    
    if (results.length === 0) {
      console.log('[google-shopping] No results found');
      return {
        amazonPrice: null,
        amazonUrl: null,
        walmartPrice: null,
        walmartUrl: null,
        targetPrice: null,
        targetUrl: null,
        bestPrice: null,
        bestPriceSource: null,
        bestPriceUrl: null,
        allResults: [],
        confidence: 'low',
        reasoning: 'No products found in search results',
      };
    }

    console.log(`[google-shopping] Found ${results.length} results`);

    // Extract prices by retailer (prioritize Amazon)
    const amazonResult = results.find(r => 
      r.seller?.toLowerCase().includes('amazon') && 
      !r.seller?.toLowerCase().includes('marketplace') &&
      r.extracted_price > 0
    );
    
    const walmartResult = results.find(r => 
      r.seller?.toLowerCase().includes('walmart') &&
      !r.seller?.toLowerCase().includes('marketplace') &&
      r.extracted_price > 0
    );
    
    const targetResult = results.find(r => 
      r.seller?.toLowerCase() === 'target' &&
      r.extracted_price > 0
    );

    // Find best price among major retailers (excluding eBay and marketplaces)
    const retailResults = results.filter(r => {
      const seller = r.seller?.toLowerCase() || '';
      return (
        r.extracted_price > 0 &&
        !seller.includes('ebay') &&
        !seller.includes('mercari') &&
        !seller.includes('poshmark') &&
        !seller.includes('marketplace')
      );
    });

    // Sort by price to find best deal
    retailResults.sort((a, b) => a.extracted_price - b.extracted_price);
    const bestResult = retailResults[0];

    // Determine confidence based on result quality
    let confidence: 'high' | 'medium' | 'low' = 'low';
    let reasoning = '';

    if (amazonResult) {
      confidence = 'high';
      reasoning = `Found Amazon price: $${amazonResult.extracted_price}`;
    } else if (walmartResult || targetResult) {
      confidence = 'medium';
      reasoning = `Found retail price from ${walmartResult?.seller || targetResult?.seller}`;
    } else if (bestResult) {
      confidence = 'low';
      reasoning = `Best price from ${bestResult.seller}: $${bestResult.extracted_price}`;
    } else {
      reasoning = 'No valid retail prices found';
    }

    // Log top results for debugging
    console.log('[google-shopping] Top results:');
    results.slice(0, 5).forEach((r, i) => {
      console.log(`  ${i + 1}. $${r.extracted_price} - ${r.seller} - ${r.title?.slice(0, 50)}`);
    });

    return {
      amazonPrice: amazonResult?.extracted_price || null,
      amazonUrl: amazonResult?.link || amazonResult?.product_link || null,
      walmartPrice: walmartResult?.extracted_price || null,
      walmartUrl: walmartResult?.link || walmartResult?.product_link || null,
      targetPrice: targetResult?.extracted_price || null,
      targetUrl: targetResult?.link || targetResult?.product_link || null,
      bestPrice: bestResult?.extracted_price || null,
      bestPriceSource: bestResult?.seller || null,
      bestPriceUrl: bestResult?.link || bestResult?.product_link || null,
      allResults: results,
      confidence,
      reasoning,
    };

  } catch (error) {
    console.error('[google-shopping] Error:', error);
    return {
      amazonPrice: null,
      amazonUrl: null,
      walmartPrice: null,
      walmartUrl: null,
      targetPrice: null,
      targetUrl: null,
      bestPrice: null,
      bestPriceSource: null,
      bestPriceUrl: null,
      allResults: [],
      confidence: 'low',
      reasoning: `Error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Get the best retail price with Amazon priority
 * This is the main function to use in the pricing pipeline
 */
export async function getRetailPrice(
  brand: string,
  productName: string
): Promise<{ price: number | null; source: string; url: string | null; confidence: string }> {
  const result = await searchGoogleShopping(brand, productName);

  // Priority: Amazon > Walmart > Target > Best available
  if (result.amazonPrice) {
    return {
      price: result.amazonPrice,
      source: 'amazon',
      url: result.amazonUrl,
      confidence: 'high',
    };
  }

  if (result.walmartPrice) {
    return {
      price: result.walmartPrice,
      source: 'walmart',
      url: result.walmartUrl,
      confidence: 'medium',
    };
  }

  if (result.targetPrice) {
    return {
      price: result.targetPrice,
      source: 'target',
      url: result.targetUrl,
      confidence: 'medium',
    };
  }

  if (result.bestPrice) {
    return {
      price: result.bestPrice,
      source: result.bestPriceSource || 'retail',
      url: result.bestPriceUrl,
      confidence: 'low',
    };
  }

  return {
    price: null,
    source: 'not-found',
    url: null,
    confidence: 'none',
  };
}
