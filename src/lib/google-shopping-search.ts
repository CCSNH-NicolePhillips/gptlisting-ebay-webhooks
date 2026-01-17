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
  /** Lowest price from any major chain retailer (Ulta, CVS, Walgreens, etc.) */
  lowestRetailPrice: number | null;
  lowestRetailSource: string | null;
  lowestRetailUrl: string | null;
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
      lowestRetailPrice: null,
      lowestRetailSource: null,
      lowestRetailUrl: null,
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
        lowestRetailPrice: null,
        lowestRetailSource: null,
        lowestRetailUrl: null,
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
        lowestRetailPrice: null,
        lowestRetailSource: null,
        lowestRetailUrl: null,
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
        lowestRetailPrice: null,
        lowestRetailSource: null,
        lowestRetailUrl: null,
        bestPrice: null,
        bestPriceSource: null,
        bestPriceUrl: null,
        allResults: [],
        confidence: 'low',
        reasoning: 'No products found in search results',
      };
    }

    console.log(`[google-shopping] Found ${results.length} results`);

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
    ];
    
    const isLotListing = (title: string): boolean => {
      return LOT_PATTERNS.some(pattern => pattern.test(title));
    };
    
    // Title matching - verify the result is actually the same product
    // Uses bidirectional matching: checks if query words appear in title OR if title words appear in query
    // This handles cases where Google Shopping returns abbreviated titles (e.g., "Root Sculpt" vs full query)
    // 
    // CRITICAL FIX: REQUIRE BRAND MATCH + PRODUCT TYPE MATCH
    // Without proper matching, similar products get confused:
    // - "Undereye Masks" wrongly matching "Undereye Balm" (different product types)
    // - "Watermelon Hydration" wrongly matching unrelated watermelon products
    //
    // 2025-01 FIX: Brand sites often omit brand name from product titles
    // (e.g., pumpsauce.com shows "Watermelon Marg 12 x 2 fl oz" not "Pump Sauce Watermelon...")
    // If sellerUrl contains brand name, trust it even without brand in title
    const isTitleMatch = (resultTitle: string, searchQuery: string, searchBrand?: string, sellerUrl?: string): boolean => {
      // Normalize both strings
      const normalize = (s: string): string[] => {
        return s.toLowerCase()
          .replace(/[^a-z0-9\s]/g, ' ')  // Remove punctuation
          .split(/\s+/)                   // Split on whitespace
          .filter(w => w.length > 2)      // Ignore tiny words
          .filter(w => !['the', 'and', 'for', 'with', 'new'].includes(w)); // Common words
      };
      
      const queryWords = normalize(searchQuery);
      const titleWords = normalize(resultTitle);
      
      if (queryWords.length === 0) return true;
      
      // CRITICAL: Check brand match first
      // If we have a brand, the result MUST contain it (or a close variant)
      if (searchBrand && searchBrand.length > 0) {
        const brandWords = normalize(searchBrand);
        const titleLower = resultTitle.toLowerCase();
        
        // Check if ANY brand word appears in title
        const brandInTitle = brandWords.some(bw => 
          titleLower.includes(bw) || 
          titleWords.some(tw => tw.includes(bw) || bw.includes(tw))
        );
        
        // NEW: Check if seller URL contains brand name
        // Brand sites often omit their name from product titles
        // e.g., pumpsauce.com shows "Watermelon Marg" not "Pump Sauce Watermelon Marg"
        let brandInSellerUrl = false;
        if (sellerUrl) {
          const urlLower = sellerUrl.toLowerCase();
          // Extract domain from URL
          const domainMatch = urlLower.match(/(?:https?:\/\/)?(?:www\.)?([^\/]+)/);
          const domain = domainMatch?.[1] || urlLower;
          
          // Check if any brand word appears in the domain
          // Normalize brand for domain matching: "Pump Sauce" → "pumpsauce"
          const brandSlug = searchBrand.toLowerCase().replace(/[^a-z0-9]/g, '');
          const brandWordsNormalized = brandWords.map(w => w.replace(/[^a-z0-9]/g, ''));
          
          brandInSellerUrl = domain.includes(brandSlug) || 
                             brandWordsNormalized.some(bw => bw.length > 3 && domain.includes(bw));
          
          if (brandInSellerUrl && !brandInTitle) {
            console.log(`[google-shopping] ✅ Brand "${searchBrand}" found in seller URL (${domain}) - trusting despite title mismatch`);
          }
        }
        
        if (!brandInTitle && !brandInSellerUrl) {
          // Brand not found in title OR URL - this is likely a wrong product
          console.log(`[google-shopping] ❌ Brand mismatch: "${searchBrand}" not in "${resultTitle.slice(0, 60)}"`);
          return false;
        }
        
        // NEW: If brand was verified via URL (official brand site), trust it for pricing
        // Brand sites are authoritative and may use different product names than retailers
        // e.g., pumpsauce.com "Watermelon Marg" vs search "Pump Sauce 12-Pack"
        if (brandInSellerUrl && !brandInTitle) {
          console.log(`[google-shopping] ✅ Brand site detected - auto-approving for pricing`);
          return true;  // Trust the brand's own site
        }
      }
      
      // CRITICAL: Check product type match
      // Common confusions: masks vs balm, gummies vs capsules, powder vs liquid
      // Normalize plurals: masks/mask, gummies/gummy, etc.
      const PRODUCT_TYPE_GROUPS = [
        ['mask', 'masks'],
        ['balm', 'balms'],
        ['cream', 'creams'],
        ['serum', 'serums'],
        ['lotion', 'lotions'],
        ['gel', 'gels'],
        ['oil', 'oils'],
        ['spray', 'sprays'],
        ['gummy', 'gummies'],
        ['chew', 'chews'],      // Heart Chews vs Heart Tablets
        ['capsule', 'capsules'],
        ['tablet', 'tablets'],
        ['pill', 'pills'],
        ['powder', 'powders'],
        ['liquid', 'liquids'],
        ['drop', 'drops'],
        ['patch', 'patches'],
        ['bar', 'bars'],
        ['drink', 'drinks'],
        ['shot', 'shots'],
        ['kit', 'kits'],       // Discovery Kit vs individual products
        ['set', 'sets'],       // Gift Set vs individual items
        ['bundle', 'bundles'],
        ['shampoo', 'shampoos'],
        ['conditioner', 'conditioners'],
      ];
      
      // Normalize type word to base form
      const normalizeType = (word: string): string => {
        for (const group of PRODUCT_TYPE_GROUPS) {
          if (group.includes(word)) return group[0]; // Return base form
        }
        return word;
      };
      
      const ALL_PRODUCT_TYPES = PRODUCT_TYPE_GROUPS.flat();
      
      const queryTypes = queryWords.filter(w => ALL_PRODUCT_TYPES.includes(w)).map(normalizeType);
      const titleTypes = titleWords.filter(w => ALL_PRODUCT_TYPES.includes(w)).map(normalizeType);
      
      // If query specifies a product type, the result MUST have a matching type
      if (queryTypes.length > 0 && titleTypes.length > 0) {
        const typesMatch = queryTypes.some(qt => titleTypes.includes(qt));
        if (!typesMatch) {
          console.log(`[google-shopping] ❌ Product type mismatch: query has "${queryTypes.join(',')}" but title has "${titleTypes.join(',')}": "${resultTitle.slice(0, 60)}"`);
          return false;
        }
      }
      
      // Count how many query words appear in the title (forward match)
      const forwardMatchCount = queryWords.filter(qw => 
        titleWords.some(tw => tw.includes(qw) || qw.includes(tw))
      ).length;
      
      const forwardMatchRatio = forwardMatchCount / queryWords.length;
      
      // ALSO check reverse: what % of title words appear in query (handles abbreviated titles)
      // e.g., "Root Sculpt" (2 words) should match query "Root Sculpt Dietary Supplement..."
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
      
      const isMatch = forwardMatch || reverseMatch || coreMatch;
      
      if (!isMatch && resultTitle.length > 0) {
        // Log mismatches for debugging
        console.log(`[google-shopping] Title mismatch (fwd:${(forwardMatchRatio * 100).toFixed(0)}% rev:${(reverseMatchRatio * 100).toFixed(0)}%): "${resultTitle.slice(0, 50)}"`);
      }
      
      return isMatch;
    };

    // Helper to check if seller is first-party (not marketplace/seller)
    const isFirstPartySeller = (seller: string): boolean => {
      const s = seller.toLowerCase();
      // "Walmart - Seller" means third-party on Walmart, not Walmart itself
      if (s.includes('seller')) return false;
      if (s.includes('marketplace')) return false;
      return true;
    };

    // Extract prices by retailer (prioritize Amazon, first-party only)
    // CRITICAL: Also filter by title match to avoid using wrong product prices
    const amazonResult = results.find(r => 
      r.seller?.toLowerCase().includes('amazon') && 
      isFirstPartySeller(r.seller) &&
      !isLotListing(r.title || '') &&
      isTitleMatch(r.title || '', searchQuery, brand, r.link || r.product_link) &&
      r.extracted_price > 0
    );
    
    const walmartResult = results.find(r => 
      r.seller?.toLowerCase().includes('walmart') &&
      isFirstPartySeller(r.seller) &&
      !isLotListing(r.title || '') &&
      isTitleMatch(r.title || '', searchQuery, brand, r.link || r.product_link) &&
      r.extracted_price > 0
    );
    
    const targetResult = results.find(r => 
      r.seller?.toLowerCase() === 'target' &&
      !isLotListing(r.title || '') &&
      isTitleMatch(r.title || '', searchQuery, brand, r.link || r.product_link) &&
      r.extracted_price > 0
    );

    // Major chain retailers we trust for retail pricing comparison
    const MAJOR_RETAILERS = [
      'amazon', 'walmart', 'target', 'ulta', 'ulta beauty',
      'cvs', 'cvs pharmacy', 'walgreens', 'rite aid',
      'costco', 'sams club', 'sam\'s club', 'bjs',
      'kroger', 'publix', 'safeway', 'albertsons',
      'gnc', 'vitamin shoppe', 'the vitamin shoppe',
      'bed bath', 'bath & body works', 'sephora',
      'best buy', 'staples', 'office depot',
    ];

    // Sellers that often sell different variants (sample sizes, counterfeits, gray market)
    // These should NOT be used for pricing comparisons
    const UNTRUSTED_SELLERS = [
      // Discount/gray market sellers
      'shein',
      'aliexpress',
      'temu',
      'wish',
      'dhgate',
      'banggood',
      'gearbest',
      'lightinthebox',
      'miniinthebox',
      // Delivery services (not actual prices)
      'instacart',  // Often shows per-unit prices not pack prices
      'gopuff',     // Convenience store markup/different sizes
      'shipt',      // Delivery service, not retailer
      'ubereats',
      'doordash',
      // K-beauty/Asian beauty resellers (often sell different pack sizes)
      'pinkseoul',
      'yesstyle',
      'stylevana',
      'jolse',
      'holiholic',
      'sokoglam',
      'style korean',
      'stylekorean',
      'beautytap',
      'masksheets',
      'miss a',
      'missa',
      // Sample size sellers
      'beauty barn',
      'sample',
    ];

    const isUntrustedSeller = (seller: string): boolean => {
      const s = seller.toLowerCase();
      return UNTRUSTED_SELLERS.some(u => s.includes(u));
    };

    const isMajorRetailer = (seller: string): boolean => {
      const s = seller.toLowerCase();
      return MAJOR_RETAILERS.some(r => s.includes(r));
    };

    // Find lowest price from major chain retailers only (for retail comparison)
    // CRITICAL: Must match product title to avoid using different product prices as retail cap
    const majorRetailResults = results.filter(r => {
      const seller = r.seller || '';
      const title = r.title || '';
      const url = r.link || r.product_link || '';
      return (
        r.extracted_price > 0 &&
        isMajorRetailer(seller) &&
        isFirstPartySeller(seller) &&
        !isLotListing(title) &&
        isTitleMatch(title, searchQuery, brand, url)
      );
    });
    majorRetailResults.sort((a, b) => a.extracted_price - b.extracted_price);
    const lowestRetailResult = majorRetailResults[0];

    // Find brand's official website price (highest trust for pricing)
    // Brand sites often omit brand name from titles but have brand in URL
    // STRICT: Only match if brand name is a significant portion of seller name
    const brandResult = brand ? results.find(r => {
      const url = r.link || r.product_link || '';
      const seller = r.seller || '';
      const title = r.title || '';
      
      // Skip untrusted sellers even if they match brand name
      if (isUntrustedSeller(seller)) return false;
      
      // Check if seller name matches brand name (strict matching)
      const brandSlug = brand.toLowerCase().replace(/[^a-z0-9]/g, '');
      const sellerSlug = seller.toLowerCase().replace(/[^a-z0-9]/g, '');
      const urlLower = url.toLowerCase();
      
      // For brand matching, require high similarity (not just substring)
      // e.g., "Humann" seller for "HumanN" brand = OK
      // e.g., "Stylevana" seller for "Biodance" brand = NOT OK
      const isBrandSite = (
        // Seller contains brand slug (brand must be at least 4 chars)
        (brandSlug.length >= 4 && sellerSlug.includes(brandSlug)) ||
        // Brand contains seller slug (seller must be at least 4 chars)
        (sellerSlug.length >= 4 && brandSlug.includes(sellerSlug)) ||
        // URL domain contains brand
        urlLower.includes(brandSlug + '.') ||  // e.g., milamend.com
        urlLower.includes('//' + brandSlug)     // e.g., //milamend.
      );
      
      return (
        r.extracted_price > 0 &&
        isBrandSite &&
        !isLotListing(title) &&
        isFirstPartySeller(seller)
      );
    }) : null;

    if (brandResult) {
      console.log(`[google-shopping] 🏪 Brand site found: $${brandResult.extracted_price} from ${brandResult.seller}`);
    }

    // Find best price among any retailers (excluding eBay, marketplaces, lots, and untrusted sellers)
    // CRITICAL: Title matching prevents using wrong product prices
    const retailResults = results.filter(r => {
      const seller = r.seller?.toLowerCase() || '';
      const title = r.title || '';
      const url = r.link || r.product_link || '';
      return (
        r.extracted_price > 0 &&
        !seller.includes('ebay') &&
        !seller.includes('mercari') &&
        !seller.includes('poshmark') &&
        !isUntrustedSeller(seller) &&
        !isLotListing(title) &&
        isFirstPartySeller(r.seller || '') &&
        isTitleMatch(title, searchQuery, brand, url)
      );
    });

    // Sort by price to find best deal
    retailResults.sort((a, b) => a.extracted_price - b.extracted_price);
    
    // Get reference price for sanity check (prefer brand site, then major retail)
    const referencePrice = brandResult?.extracted_price || 
                           lowestRetailResult?.extracted_price || 
                           amazonResult?.extracted_price ||
                           walmartResult?.extracted_price ||
                           targetResult?.extracted_price;
    
    // Filter out suspiciously low prices (likely different product sizes or counterfeits)
    // If a price is <40% of reference, it's probably wrong
    let bestResult: GoogleShoppingResult | undefined = retailResults[0];
    if (referencePrice && bestResult && bestResult.extracted_price < referencePrice * 0.4) {
      console.log(`[google-shopping] ⚠️ Rejecting suspiciously low price $${bestResult.extracted_price} from ${bestResult.seller} (reference: $${referencePrice})`);
      // Find next best price that isn't suspiciously low
      bestResult = retailResults.find(r => r.extracted_price >= referencePrice * 0.4);
      if (bestResult) {
        console.log(`[google-shopping] Using $${bestResult.extracted_price} from ${bestResult.seller} instead`);
      }
    }

    // If brand site price is available, PREFER it as authoritative MSRP
    // Brand's own website is the most trusted source for pricing
    // Only use a cheaper non-brand result if it's from a major retailer AND within 30% of brand price
    // (Major retailers can have legitimate sales, but gray market sellers often have wrong products)
    if (brandResult) {
      const isMajorRetailerResult = bestResult && isMajorRetailer(bestResult.seller);
      const isWithinSaleRange = bestResult && bestResult.extracted_price >= brandResult.extracted_price * 0.7;
      
      if (!isMajorRetailerResult || !isWithinSaleRange) {
        // Use brand site price - it's authoritative
        if (bestResult && bestResult.extracted_price < brandResult.extracted_price) {
          console.log(`[google-shopping] 📍 Preferring brand site $${brandResult.extracted_price} over $${bestResult.extracted_price} from ${bestResult.seller} (not a trusted sale)`);
        }
        bestResult = brandResult;
      }
    }

    // Determine confidence based on result quality
    let confidence: 'high' | 'medium' | 'low' = 'low';
    let reasoning = '';

    if (amazonResult) {
      confidence = 'high';
      reasoning = `Found Amazon price: $${amazonResult.extracted_price}`;
    } else if (walmartResult || targetResult) {
      confidence = 'medium';
      reasoning = `Found retail price from ${walmartResult?.seller || targetResult?.seller}`;
    } else if (lowestRetailResult) {
      confidence = 'medium';
      reasoning = `Lowest major retail: $${lowestRetailResult.extracted_price} from ${lowestRetailResult.seller}`;
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

    // CRITICAL: Filter allResults to only include title-matched products
    // This prevents mismatched products (like $2.99 accessories) from being used as eBay comps
    const filteredResults = results.filter(r => {
      const title = r.title || '';
      const url = r.link || r.product_link || '';
      return r.extracted_price > 0 && 
             !isLotListing(title) && 
             isTitleMatch(title, searchQuery, brand, url);
    });
    
    console.log(`[google-shopping] Filtered ${results.length} results down to ${filteredResults.length} title-matched results`);

    return {
      amazonPrice: amazonResult?.extracted_price || null,
      amazonUrl: amazonResult?.link || amazonResult?.product_link || null,
      walmartPrice: walmartResult?.extracted_price || null,
      walmartUrl: walmartResult?.link || walmartResult?.product_link || null,
      targetPrice: targetResult?.extracted_price || null,
      targetUrl: targetResult?.link || targetResult?.product_link || null,
      lowestRetailPrice: lowestRetailResult?.extracted_price || null,
      lowestRetailSource: lowestRetailResult?.seller || null,
      lowestRetailUrl: lowestRetailResult?.link || lowestRetailResult?.product_link || null,
      bestPrice: bestResult?.extracted_price || null,
      bestPriceSource: bestResult?.seller || null,
      bestPriceUrl: bestResult?.link || bestResult?.product_link || null,
      allResults: filteredResults,
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
      lowestRetailPrice: null,
      lowestRetailSource: null,
      lowestRetailUrl: null,
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
