import { extractPriceFromHtml } from "./html-price.js";
import { braveFirstUrlForBrandSite } from "./search.js";
import { getBrandUrls } from "./brand-map.js";
import { fetchSoldPriceStats, type SoldPriceStats } from "./pricing/ebay-sold-prices.js";
import { openai } from "./openai.js";
import { getCachedPrice, setCachedPrice, makePriceSig } from "./price-cache.js";

// ============================================================================
// URL VARIATION HELPERS
// ============================================================================

/**
 * Generate common URL variations for a product page
 * Example: /glutathione-rapid-boost.html → [/glutathione-rapid-boost-supplement.html, /glutathione-rapid-boost-sports-drink.html, ...]
 */
function generateUrlVariations(url: string): string[] {
  try {
    const urlObj = new URL(url);
    const path = urlObj.pathname;
    
    // Extract base path and extension
    const lastSlash = path.lastIndexOf('/');
    const basePath = path.substring(0, lastSlash + 1);
    const filename = path.substring(lastSlash + 1);
    const dotIndex = filename.lastIndexOf('.');
    const ext = dotIndex > 0 ? filename.substring(dotIndex) : '';
    const base = dotIndex > 0 ? filename.substring(0, dotIndex) : filename;
    
    // Common suffixes to try
    const suffixes = [
      '-supplement',
      '-sports-drink', 
      '-product',
      '-capsules',
      '-formula'
    ];
    
    const variations: string[] = [];
    for (const suffix of suffixes) {
      const newPath = `${basePath}${base}${suffix}${ext}`;
      variations.push(`${urlObj.origin}${newPath}`);
    }
    
    return variations;
  } catch {
    return [];
  }
}

// ============================================================================
// NEW TIERED PRICING ENGINE
// ============================================================================

export interface PriceLookupInput {
  title: string;
  brand?: string;
  brandWebsite?: string; // Official brand website URL from Vision API
  upc?: string;
  condition?: 'NEW' | 'USED' | 'OTHER';
  quantity?: number;
}

export type PriceSource = 'ebay-sold' | 'brand-msrp' | 'brave-fallback' | 'estimate';

export interface PriceSourceDetail {
  source: PriceSource;
  price: number;
  currency: string;
  url?: string;
  notes?: string;
}

export interface PriceDecision {
  ok: boolean;
  chosen?: PriceSourceDetail;
  candidates: PriceSourceDetail[];
  recommendedListingPrice?: number;
  reason?: string;
}

// ============================================================================
// LEGACY SUPPORT (keep for backward compatibility)
// ============================================================================

export type MarketPrices = {
  amazon: number | null;
  walmart: number | null;
  brand: number | null;
  avg: number;
  productType?: string;
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Detect if a brand price is suspiciously high compared to marketplace price
 * This catches bundle pricing that slips past HTML text detection
 */
function isProbablyBundlePrice(brandPrice: number, comparisonPrice: number): boolean {
  if (!Number.isFinite(brandPrice) || !Number.isFinite(comparisonPrice)) return false;
  if (comparisonPrice <= 0) return false;

  const ratio = brandPrice / comparisonPrice;

  // Tunable: > 2.5x seems very likely to be a bundle or multi-pack
  // Lowered from 3.0x to catch MLM brands like Root (2.90x ratio)
  return ratio > 2.5;
}

/**
 * Helper: Fetch HTML with timeout
 * Returns { html, isDnsFailure } where isDnsFailure indicates the domain doesn't exist
 */
async function fetchHtml(url: string | null | undefined, timeoutMs = 10000): Promise<{ html: string | null; isDnsFailure: boolean }> {
  if (!url) return { html: null, isDnsFailure: false };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
      },
    });
    clearTimeout(timer);
    if (!res.ok) return { html: null, isDnsFailure: false };
    const html = await res.text();
    return { html, isDnsFailure: false };
  } catch (err: any) {
    const isDnsFailure = err?.cause?.code === 'ENOTFOUND';
    console.warn("fetchHtml failed", { url, err });
    return { html: null, isDnsFailure };
  }
}

/**
 * Helper: Extract price from URL
 * Returns { price, isDnsFailure } where isDnsFailure indicates the domain doesn't exist
 */
async function priceFrom(url: string | null | undefined): Promise<{ price: number | null; isDnsFailure: boolean }> {
  const { html, isDnsFailure } = await fetchHtml(url);
  if (!html) return { price: null, isDnsFailure };
  const price = extractPriceFromHtml(html);
  return { price, isDnsFailure };
}

/**
 * Helper: Check if URL is a retailer
 */
function isRetailerUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return /amazon\.com|walmart\.com/i.test(url);
}

// ============================================================================
// TIERED PRICING ENGINE - MAIN ENTRY POINT
// ============================================================================

/**
 * AI-powered price arbitration
 * Takes multiple price candidates and uses GPT-4o-mini to decide optimal listing price
 */
async function decideFinalPrice(
  input: PriceLookupInput,
  candidates: PriceSourceDetail[],
  soldStats?: SoldPriceStats
): Promise<PriceDecision> {
  if (candidates.length === 0) {
    return {
      ok: false,
      candidates: [],
      reason: 'no-price-signals'
    };
  }

  // Build structured prompt for AI
  const prompt = `You are a pricing expert for eBay listings. Analyze the following price data and recommend the optimal listing price.

PRODUCT INFORMATION:
- Title: ${input.title}
${input.brand ? `- Brand: ${input.brand}` : ''}
${input.upc ? `- UPC: ${input.upc}` : ''}
${input.condition ? `- Condition: ${input.condition}` : ''}
${input.quantity ? `- Quantity: ${input.quantity}` : ''}

AVAILABLE PRICE DATA:
${candidates.map((c, i) => `${i + 1}. ${c.source}: $${c.price.toFixed(2)} (${c.notes || 'no notes'})`).join('\n')}

${soldStats && soldStats.ok ? `
RECENT SOLD PRICES (last 30 days):
- Median: $${soldStats.median?.toFixed(2) || 'N/A'}
- 35th percentile: $${soldStats.p35?.toFixed(2) || 'N/A'}
- 10th percentile: $${soldStats.p10?.toFixed(2) || 'N/A'}
- 90th percentile: $${soldStats.p90?.toFixed(2) || 'N/A'}
- Sample count: ${soldStats.samples.length}
` : ''}

PRICING RULES:
1. **ALWAYS prefer brand MSRP if available** - apply 10% discount to compete with retail
2. Only use eBay sold prices if NO brand MSRP is available
3. If using eBay sold price, use it as-is (p35 already represents competitive pricing)
4. Never price below 50% of brand MSRP (prevents undervaluing new products)
5. For used items, eBay sold data is more reliable than MSRP

RESPONSE FORMAT (JSON only):
{
  "chosenSource": "ebay-sold" | "brand-msrp" | "brave-fallback",
  "basePrice": <number>,
  "recommendedListingPrice": <number>,
  "reasoning": "<brief explanation of pricing decision>"
}`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      max_tokens: 500,
      response_format: { type: "json_object" },
      messages: [
        { 
          role: "system", 
          content: "You are a pricing expert. Always respond with valid JSON matching the specified format." 
        },
        { 
          role: "user", 
          content: prompt 
        },
      ],
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      console.error('[price] AI returned empty response');
      return fallbackDecision(candidates);
    }

    const parsed = JSON.parse(content);
    const chosenSource = parsed.chosenSource as PriceSource;
    const basePrice = parseFloat(parsed.basePrice);
    const recommendedListingPrice = parseFloat(parsed.recommendedListingPrice);
    const reasoning = parsed.reasoning || 'AI decision';

    // Find the chosen candidate
    const chosen = candidates.find(c => c.source === chosenSource) || candidates[0];

    console.log(`[price] AI decision: source=${chosen.source} base=$${basePrice.toFixed(2)} final=$${recommendedListingPrice.toFixed(2)} | ${reasoning}`);

    return {
      ok: true,
      chosen,
      candidates,
      recommendedListingPrice,
      reason: reasoning
    };

  } catch (error) {
    console.error('[price] AI arbitration failed:', error);
    return fallbackDecision(candidates);
  }
}

/**
 * Fallback decision when AI fails: prefer ebay-sold p35, then brand MSRP with 10% discount
 */
function fallbackDecision(candidates: PriceSourceDetail[]): PriceDecision {
  // Prefer ebay-sold first
  const ebaySold = candidates.find(c => c.source === 'ebay-sold');
  if (ebaySold) {
    console.log(`[price] Fallback decision: using ebay-sold $${ebaySold.price.toFixed(2)}`);
    return {
      ok: true,
      chosen: ebaySold,
      candidates,
      recommendedListingPrice: ebaySold.price,
      reason: 'fallback-to-ebay-sold'
    };
  }

  // Then try brand MSRP with 10% discount
  const brandMsrp = candidates.find(c => c.source === 'brand-msrp');
  if (brandMsrp) {
    const discountedPrice = Math.round(brandMsrp.price * 0.90 * 100) / 100;
    console.log(`[price] Fallback decision: using brand-msrp $${brandMsrp.price.toFixed(2)} with 10% discount = $${discountedPrice.toFixed(2)}`);
    return {
      ok: true,
      chosen: brandMsrp,
      candidates,
      recommendedListingPrice: discountedPrice,
      reason: 'fallback-to-brand-msrp-with-discount'
    };
  }

  // Last resort: use any available price
  const fallback = candidates[0];
  console.log(`[price] Fallback decision: using ${fallback.source} $${fallback.price.toFixed(2)}`);
  return {
    ok: true,
    chosen: fallback,
    candidates,
    recommendedListingPrice: fallback.price,
    reason: 'fallback-to-first-available'
  };
}

/**
 * MAIN ENTRY POINT: Tiered price lookup with AI arbitration
 * 
 * Tier 1: eBay sold/completed prices (most reliable)
 * Tier 2: Brand MSRP from official sites
 * Tier 3: AI arbitration to decide final listing price
 */
export async function lookupPrice(
  input: PriceLookupInput
): Promise<PriceDecision> {
  console.log(`[price] Starting lookup for: "${input.title}"${input.brand ? ` (${input.brand})` : ''}${input.upc ? ` [${input.upc}]` : ''}`);

  // Check cache first
  const cacheKey = makePriceSig(input.brand, input.title);
  const cached = await getCachedPrice(cacheKey);
  
  if (cached?.recommendedListingPrice) {
    console.log(`[price] ✓ Using cached price: $${cached.recommendedListingPrice.toFixed(2)} (source: ${cached.chosen?.source || 'unknown'})`);
    return cached as PriceDecision;
  }

  const candidates: PriceSourceDetail[] = [];

  // ========================================
  // TIER 1: eBay Sold/Completed Prices
  // ========================================
  console.log('[price] Tier 1: Checking eBay sold prices...');
  
  const soldStats = await fetchSoldPriceStats({
    title: input.title,
    brand: input.brand,
    upc: input.upc,
    condition: input.condition,
    quantity: input.quantity,
  });

  if (soldStats.rateLimited) {
    console.warn('[price] ⚠️  eBay sold prices rate limited - skipping to brand MSRP');
  } else if (soldStats.ok && soldStats.p35) {
    candidates.push({
      source: 'ebay-sold',
      price: soldStats.p35,
      currency: 'USD',
      notes: `35th percentile of ${soldStats.samples.length} recent sold items`,
    });
    console.log(`[price] ✓ eBay sold price: $${soldStats.p35.toFixed(2)} (median: $${soldStats.median?.toFixed(2)})`);
  } else {
    console.log('[price] ✗ No eBay sold price data available');
  }

  // ========================================
  // TIER 2: Brand MSRP (Official Sites)
  // ========================================
  console.log('[price] Tier 2: Checking brand MSRP...');
  
  let brandPrice: number | null = null;
  let brandUrl: string | undefined;

  // FIRST: Try Vision API-provided brand website (most accurate!)
  let domainReachable = true;
  if (input.brandWebsite) {
    // Skip homepage URLs - they often show bundle/subscription prices, not individual products
    // Match: http://example.com, https://example.com, https://example.com/, http://example.com/
    const isHomepage = /^https?:\/\/[^\/]+\/?$/.test(input.brandWebsite);
    
    if (isHomepage) {
      console.log(`[price] ⚠️ Vision website is homepage (${input.brandWebsite}), skipping direct price extraction`);
    } else {
      console.log(`[price] Trying Vision API brand website: ${input.brandWebsite}`);
      const { price, isDnsFailure } = await priceFrom(input.brandWebsite);
      brandPrice = price;
      
      if (brandPrice) {
        brandUrl = input.brandWebsite;
        console.log(`[price] ✓ Brand MSRP from Vision API website: $${brandPrice.toFixed(2)}`);
      } else if (isDnsFailure) {
        // Domain doesn't exist - skip URL variations and go straight to Brave
        console.warn(`[price] Vision domain unreachable (DNS lookup failed), skipping URL variations`);
        domainReachable = false;
      } else if (input.brandWebsite.includes('/')) {
        // Vision URL didn't work but domain exists - try common variations before falling back to Brave
        const variations = generateUrlVariations(input.brandWebsite);
        for (const variant of variations) {
          console.log(`[price] Trying URL variation: ${variant}`);
          const { price: variantPrice } = await priceFrom(variant);
          if (variantPrice) {
            brandPrice = variantPrice;
            brandUrl = variant;
            console.log(`[price] ✓ Brand MSRP from URL variation: $${brandPrice.toFixed(2)}`);
            break;
          }
        }
      }
    }
  }

  // SECOND: Try brand-map (curated brand URLs)
  if (!brandPrice && domainReachable) {
    const signature = [input.brand, input.title].filter(Boolean).join(' ').trim();
    if (signature) {
      const mapped = await getBrandUrls(signature);
      if (mapped?.brand) {
        const { price: mappedPrice } = await priceFrom(mapped.brand);
        if (mappedPrice) {
          brandPrice = mappedPrice;
          brandUrl = mapped.brand;
          console.log(`[price] ✓ Brand MSRP from curated URL: $${brandPrice.toFixed(2)}`);
        }
      }
    }
  }

  // LAST: Fall back to Brave search for official brand site
  if (!brandPrice && input.brand) {
    const braveUrl = await braveFirstUrlForBrandSite(
      input.brand,
      input.title,
      undefined // Could pass brand domain from brand-map if available
    );
    
    if (braveUrl) {
      const { price: bravePrice } = await priceFrom(braveUrl);
      if (bravePrice && bravePrice > 0) { // Check for valid price (not -1 rejection)
        brandPrice = bravePrice;
        brandUrl = braveUrl;
        console.log(`[price] ✓ Brand MSRP from Brave search: $${bravePrice.toFixed(2)}`);
      }
    }
  }

  // AMAZON: Always try Amazon to provide marketplace pricing for comparison
  // This enables Phase 2 bundle price detection even when brand site works
  let amazonPrice: number | null = null;
  let amazonUrl: string | undefined;
  
  if (input.brand) {
    console.log('[price] Checking Amazon for marketplace pricing...');
    const { braveFirstUrl } = await import('./search.js');
    const amazonUrlFound = await braveFirstUrl(
      `${input.brand} ${input.title}`,
      'amazon.com'
    );
    
    if (amazonUrlFound) {
      console.log(`[price] Amazon URL found: ${amazonUrlFound}`);
      const { price } = await priceFrom(amazonUrlFound);
      if (price && price > 0) {
        amazonPrice = price;
        amazonUrl = amazonUrlFound;
        console.log(`[price] ✓ Amazon marketplace price: $${amazonPrice.toFixed(2)}`);
        
        // Add Amazon as a separate candidate for Phase 2 comparison
        candidates.push({
          source: 'brand-msrp',
          price: amazonPrice,
          currency: 'USD',
          url: amazonUrl,
          notes: 'Amazon marketplace price',
        });
      }
    }
  }

  // Add brand website price if we found one AND it's different from Amazon
  if (brandPrice && (!amazonPrice || Math.abs(brandPrice - amazonPrice) > 0.01)) {
    candidates.push({
      source: 'brand-msrp',
      price: brandPrice,
      currency: 'USD',
      url: brandUrl,
      notes: 'Official brand site MSRP',
    });
  } else {
    console.log('[price] ✗ No brand MSRP found');
  }

  // ========================================
  // PRICE SANITY CHECK: Filter out bundle prices
  // ========================================
  // Before AI arbitration, check if brand prices look like bundles compared to marketplace prices
  const brandCandidates = candidates.filter(c => c.source === 'brand-msrp');
  const marketCandidates = candidates.filter(c => 
    c.source === 'ebay-sold' || 
    c.url?.includes('amazon.com') || 
    c.url?.includes('walmart.com')
  );

  if (brandCandidates.length > 0 && marketCandidates.length > 0) {
    // Find the lowest marketplace price for comparison
    const bestMarket = marketCandidates.reduce((best, c) =>
      c.price < best.price ? c : best,
      marketCandidates[0]
    );

    // Check each brand candidate
    for (const brand of brandCandidates) {
      if (isProbablyBundlePrice(brand.price, bestMarket.price)) {
        console.log(`[price] ⚠️ Brand price looks like bundle (>3x market). Dropping brand candidate`, {
          brandPrice: brand.price,
          comparisonPrice: bestMarket.price,
          ratio: (brand.price / bestMarket.price).toFixed(2) + 'x',
          brandUrl: brand.url,
        });

        // Remove it from candidates
        const idx = candidates.indexOf(brand);
        if (idx >= 0) {
          candidates.splice(idx, 1);
        }
      }
    }
  }

  // ========================================
  // TIER 3: AI Arbitration
  // ========================================
  if (candidates.length === 0) {
    console.warn('[price] No price signals available - using category-based estimate');
    
    // Last resort: reasonable estimate based on product type
    let estimatedPrice = 29.99; // Default for supplements/beauty
    
    const titleLower = input.title.toLowerCase();
    if (titleLower.includes('serum') || titleLower.includes('cream') || titleLower.includes('moisturizer')) {
      estimatedPrice = 24.99; // Skincare
    } else if (titleLower.includes('supplement') || titleLower.includes('vitamin') || titleLower.includes('capsule')) {
      estimatedPrice = 29.99; // Supplements
    } else if (titleLower.includes('protein') || titleLower.includes('pre-workout') || titleLower.includes('collagen')) {
      estimatedPrice = 39.99; // Sports nutrition
    } else if (titleLower.includes('oil') && titleLower.includes('fish')) {
      estimatedPrice = 24.99; // Fish oil
    }
    
    console.log(`[price] Using category estimate: $${estimatedPrice.toFixed(2)}`);
    
    candidates.push({
      source: 'estimate',
      price: estimatedPrice,
      currency: 'USD',
      notes: 'Category-based estimate (no market data available)',
    });
  }

  // Debug log for troubleshooting pricing issues without brand-specific hardcoding
  console.log('[price] DEBUG: Price selection summary', {
    productTitle: input.title,
    productBrand: input.brand,
    candidatesCount: candidates.length,
    candidates: candidates.map(c => ({
      source: c.source,
      price: c.price,
      url: c.url?.substring(0, 50) + (c.url && c.url.length > 50 ? '...' : '')
    }))
  });
  
  console.log(`[price] Tier 3: AI arbitration with ${candidates.length} candidate(s)...`);
  const decision = await decideFinalPrice(input, candidates, soldStats);

  if (decision.ok && decision.chosen && decision.recommendedListingPrice) {
    console.log(`[price] ✓ Final decision: source=${decision.chosen.source} base=$${decision.chosen.price.toFixed(2)} final=$${decision.recommendedListingPrice.toFixed(2)}`);
    
    // Cache the successful result
    await setCachedPrice(cacheKey, decision);
    console.log(`[price] ✓ Cached result for future lookups (30-day TTL)`);
  }

  return decision;
}

// ============================================================================
// LEGACY FUNCTION (deprecated, kept for backward compatibility)
// ============================================================================

/**
 * @deprecated Use lookupPrice() instead for AI-powered tiered pricing
 */
export async function lookupMarketPrice(
  brand?: string,
  product?: string,
  variant?: string
): Promise<MarketPrices> {
  console.warn('[price-lookup] lookupMarketPrice is deprecated. Use lookupPrice() instead.');
  
  // Map to new system
  const input: PriceLookupInput = {
    title: [product, variant].filter(Boolean).join(' ').trim() || 'Unknown Product',
    brand: brand || undefined,
    condition: 'NEW',
  };

  const decision = await lookupPrice(input);

  // Map back to legacy format
  const legacy: MarketPrices = {
    amazon: null,
    walmart: null,
    brand: decision.chosen?.source === 'brand-msrp' ? decision.chosen.price : null,
    avg: decision.recommendedListingPrice || 0,
  };

  return legacy;
}
