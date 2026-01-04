/**
 * eBay Browse API - Active Listings Search
 * 
 * Searches eBay for active listings to get real-time competitor pricing.
 * Uses app-level OAuth (client_credentials) - no user login required.
 * 
 * @see docs/PRICING-OVERHAUL.md - Phase 2
 */

import { appAccessToken, tokenHosts } from './_common.js';

// ============================================================================
// Types
// ============================================================================

export interface EbayItemSummary {
  itemId: string;
  title: string;
  price: {
    value: string;
    currency: string;
  };
  shippingOptions?: Array<{
    shippingCost?: {
      value: string;
      currency: string;
    };
    shippingCostType?: string;
  }>;
  condition?: string;
  conditionId?: string;
  itemLocation?: {
    country?: string;
    postalCode?: string;
  };
  categories?: Array<{
    categoryId: string;
    categoryName?: string;
  }>;
  image?: {
    imageUrl: string;
  };
  itemWebUrl?: string;
  seller?: {
    username?: string;
    feedbackPercentage?: string;
    feedbackScore?: number;
  };
  buyingOptions?: string[];
}

export interface EbaySearchResponse {
  total: number;
  limit: number;
  offset: number;
  itemSummaries?: EbayItemSummary[];
  warnings?: Array<{
    message: string;
    errorId: number;
  }>;
}

export interface EbayCompetitor {
  itemId: string;
  title: string;
  itemPriceCents: number;
  shippingCents: number;
  deliveredCents: number;
  condition: string;
  seller: string;
  url: string;
  matchScore: MatchScore;
}

export interface MatchScore {
  brandMatch: boolean;
  productTokenOverlap: number;  // 0-1 Jaccard similarity
  sizeMatch: boolean | null;    // null = couldn't extract
  conditionMatch: boolean;
  bundleDetected: boolean;
  overall: 'high' | 'medium' | 'low';
  usable: boolean;
}

export interface EbayCompsResult {
  ok: boolean;
  competitors: EbayCompetitor[];
  floorDeliveredCents: number | null;
  medianDeliveredCents: number | null;
  count: number;
  query: string;
  cached: boolean;
  cacheKey?: string;
}

// ============================================================================
// Token Cache
// ============================================================================

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAppToken(): Promise<string> {
  // Return cached token if still valid (with 5 min buffer)
  if (cachedToken && cachedToken.expiresAt > Date.now() + 5 * 60 * 1000) {
    return cachedToken.token;
  }

  // Get new token
  const scopes = ['https://api.ebay.com/oauth/api_scope'];
  const result = await appAccessToken(scopes);
  
  cachedToken = {
    token: result.access_token,
    expiresAt: Date.now() + result.expires_in * 1000,
  };

  return cachedToken.token;
}

// ============================================================================
// Match Scoring
// ============================================================================

/**
 * Tokenize a string into normalized words
 */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1)
  );
}

/**
 * Calculate Jaccard similarity between two token sets
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  const intersection = new Set([...a].filter(x => b.has(x)));
  const union = new Set([...a, ...b]);
  return union.size > 0 ? intersection.size / union.size : 0;
}

/**
 * Extract size/count from product text
 * Returns normalized size string, or null if can't extract
 */
export function extractSize(text: string): string | null {
  const lower = text.toLowerCase();
  
  // Match patterns like "90ct", "90 pieces", "16 oz", "3.3oz", "500ml"
  const patterns = [
    /(\d+)\s*(?:ct|count|pcs?|pieces?)/i,
    /(\d+(?:\.\d+)?)\s*(?:oz|fl\.?\s*oz|ounces?)/i,
    /(\d+(?:\.\d+)?)\s*(?:ml|liters?|l)\b/i,
    /(\d+(?:\.\d+)?)\s*(?:g|grams?|kg)/i,
    /(\d+)\s*pack/i,
  ];
  
  for (const pattern of patterns) {
    const match = lower.match(pattern);
    if (match) {
      return match[0].trim().toLowerCase();
    }
  }
  
  return null;
}

/**
 * Normalize size for comparison (removes spaces, standardizes units)
 */
function normalizeSize(size: string): string {
  return size
    .replace(/\s+/g, '')           // Remove spaces: "3.3 oz" -> "3.3oz"
    .replace(/ounces?/g, 'oz')     // "ounce" -> "oz"
    .replace(/liters?/g, 'l')      // "liters" -> "l"
    .replace(/grams?/g, 'g')       // "grams" -> "g"
    .replace(/pieces?/g, 'pcs')    // "pieces" -> "pcs"
    .replace(/count/g, 'ct');      // "count" -> "ct"
}

/**
 * Detect if listing is a bundle/lot/multi-pack
 */
export function detectBundle(title: string): boolean {
  const lower = title.toLowerCase();
  
  const bundlePatterns = [
    /\blot\s+of\s+\d+/i,
    /\bpack\s+of\s+\d+/i,
    /\b\d+[\-\s]?pack\b/i,
    /\bset\s+of\s+\d+/i,
    /\bbundle\b/i,
    /\bwholesale\b/i,
    /\bbulk\b/i,
    /\b\d+x\b/i,  // "2x", "3x"
    /\bpair\b/i,  // "pair of"
    /\bmultipack\b/i,
    /\bmulti[\-\s]?pack\b/i,
  ];
  
  return bundlePatterns.some(p => p.test(lower));
}

/**
 * Score how well a competitor listing matches our product
 */
export function scoreMatch(
  ourProduct: { brand: string; product: string; condition?: string },
  competitorTitle: string,
  competitorCondition?: string
): MatchScore {
  const ourBrand = ourProduct.brand.toLowerCase();
  const ourProductLower = ourProduct.product.toLowerCase();
  const compTitleLower = competitorTitle.toLowerCase();
  
  // Brand match
  const brandMatch = compTitleLower.includes(ourBrand);
  
  // Product token overlap
  const ourTokens = tokenize(ourProduct.product);
  const compTokens = tokenize(competitorTitle);
  const productTokenOverlap = jaccardSimilarity(ourTokens, compTokens);
  
  // Size match (using normalized comparison)
  const ourSize = extractSize(ourProduct.product);
  const compSize = extractSize(competitorTitle);
  let sizeMatch: boolean | null = null;
  if (ourSize && compSize) {
    sizeMatch = normalizeSize(ourSize) === normalizeSize(compSize);
  }
  
  // Condition match
  const ourCondition = ourProduct.condition?.toLowerCase() || 'new';
  const compCondition = (competitorCondition || 'new').toLowerCase();
  const conditionMatch = ourCondition === compCondition || 
    (ourCondition.includes('new') && compCondition.includes('new'));
  
  // Bundle detection
  const bundleDetected = detectBundle(competitorTitle);
  
  // Overall score
  let overall: 'high' | 'medium' | 'low' = 'low';
  let usable = false;
  
  // Size mismatch or bundle always makes it unusable
  if (sizeMatch === false || bundleDetected) {
    overall = bundleDetected ? 'low' : 'medium';
    usable = false;
  } else if (brandMatch && productTokenOverlap >= 0.5 && conditionMatch) {
    // High match: brand + good token overlap + condition + no bundle + no size mismatch
    overall = 'high';
    usable = true;
  } else if (brandMatch && productTokenOverlap >= 0.35 && conditionMatch) {
    overall = 'medium';
    usable = true;
  }
  
  return {
    brandMatch,
    productTokenOverlap,
    sizeMatch,
    conditionMatch,
    bundleDetected,
    overall,
    usable,
  };
}

// ============================================================================
// Main Search Function
// ============================================================================

/**
 * Search eBay for active competitor listings
 * 
 * @param brand - Product brand
 * @param productName - Product name with size
 * @param options - Search options
 * @returns Competitor listings with match scores
 */
export async function searchEbayComps(
  brand: string,
  productName: string,
  options: {
    condition?: 'NEW' | 'USED';
    limit?: number;
    filterBundles?: boolean;
    minMatchScore?: 'high' | 'medium' | 'low';
  } = {}
): Promise<EbayCompsResult> {
  const { condition = 'NEW', limit = 50, filterBundles = true, minMatchScore = 'medium' } = options;

  const empty: EbayCompsResult = {
    ok: false,
    competitors: [],
    floorDeliveredCents: null,
    medianDeliveredCents: null,
    count: 0,
    query: '',
    cached: false,
  };

  try {
    // Build query
    const query = `${brand} ${productName}`.trim();
    console.log(`[ebay-browse] Searching: "${query}"`);

    // Get app token
    const token = await getAppToken();
    
    // Build URL
    const { apiHost } = tokenHosts(process.env.EBAY_ENV);
    const url = new URL(`${apiHost}/buy/browse/v1/item_summary/search`);
    url.searchParams.set('q', query);
    url.searchParams.set('limit', String(limit));
    
    // Filters
    const filters: string[] = [
      'buyingOptions:{FIXED_PRICE}',
      'itemLocationCountry:US',
      'deliveryCountry:US',
    ];
    
    if (condition === 'NEW') {
      filters.push('conditions:{NEW}');
    } else if (condition === 'USED') {
      filters.push('conditions:{USED}');
    }
    
    url.searchParams.set('filter', filters.join(','));

    // Make request
    const response = await fetch(url.toString(), {
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
        'X-EBAY-C-ENDUSERCTX': 'contextualLocation=country=US',
      },
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      console.error(`[ebay-browse] API error ${response.status}: ${errorText.slice(0, 200)}`);
      return empty;
    }

    const data: EbaySearchResponse = await response.json();
    const items = data.itemSummaries || [];
    
    console.log(`[ebay-browse] Found ${data.total} total, ${items.length} returned`);

    if (items.length === 0) {
      return { ...empty, ok: true, query };
    }

    // Process and score each item
    const competitors: EbayCompetitor[] = [];
    
    for (const item of items) {
      // Parse prices
      const itemPriceCents = Math.round(parseFloat(item.price.value) * 100);
      
      // Get shipping cost (first option, or 0 if free)
      let shippingCents = 0;
      if (item.shippingOptions && item.shippingOptions.length > 0) {
        const shipCost = item.shippingOptions[0].shippingCost;
        if (shipCost && parseFloat(shipCost.value) > 0) {
          shippingCents = Math.round(parseFloat(shipCost.value) * 100);
        }
      }
      
      // Score match
      const matchScore = scoreMatch(
        { brand, product: productName, condition },
        item.title,
        item.condition
      );
      
      // Filter by match score
      if (minMatchScore === 'high' && matchScore.overall !== 'high') continue;
      if (minMatchScore === 'medium' && matchScore.overall === 'low') continue;
      
      // Filter bundles if requested
      if (filterBundles && matchScore.bundleDetected) {
        console.log(`[ebay-browse] Skipping bundle: "${item.title.slice(0, 50)}..."`);
        continue;
      }
      
      // Skip if not usable
      if (!matchScore.usable) continue;
      
      competitors.push({
        itemId: item.itemId,
        title: item.title,
        itemPriceCents,
        shippingCents,
        deliveredCents: itemPriceCents + shippingCents,
        condition: item.condition || 'Unknown',
        seller: item.seller?.username || 'unknown',
        url: item.itemWebUrl || `https://www.ebay.com/itm/${item.itemId}`,
        matchScore,
      });
    }

    console.log(`[ebay-browse] ${competitors.length} usable comps after filtering`);

    // Calculate floor and median
    let floorDeliveredCents: number | null = null;
    let medianDeliveredCents: number | null = null;
    
    if (competitors.length > 0) {
      const deliveredPrices = competitors.map(c => c.deliveredCents).sort((a, b) => a - b);
      floorDeliveredCents = deliveredPrices[0];
      
      const mid = Math.floor(deliveredPrices.length / 2);
      medianDeliveredCents = deliveredPrices.length % 2 === 0
        ? Math.round((deliveredPrices[mid - 1] + deliveredPrices[mid]) / 2)
        : deliveredPrices[mid];
    }

    if (floorDeliveredCents) {
      console.log(`[ebay-browse] Floor: $${(floorDeliveredCents / 100).toFixed(2)}, Median: $${(medianDeliveredCents! / 100).toFixed(2)}`);
    }

    return {
      ok: true,
      competitors,
      floorDeliveredCents,
      medianDeliveredCents,
      count: competitors.length,
      query,
      cached: false,
    };

  } catch (err) {
    console.error('[ebay-browse] Error:', err);
    return empty;
  }
}

/**
 * Convenience function to get just the pricing stats
 */
export async function getEbayCompPricing(
  brand: string,
  productName: string
): Promise<{
  floorDeliveredCents: number | null;
  medianDeliveredCents: number | null;
  compsCount: number;
  confidence: 'high' | 'medium' | 'low';
}> {
  const result = await searchEbayComps(brand, productName);
  
  let confidence: 'high' | 'medium' | 'low' = 'low';
  if (result.count >= 5) {
    confidence = 'high';
  } else if (result.count >= 2) {
    confidence = 'medium';
  }
  
  return {
    floorDeliveredCents: result.floorDeliveredCents,
    medianDeliveredCents: result.medianDeliveredCents,
    compsCount: result.count,
    confidence,
  };
}
