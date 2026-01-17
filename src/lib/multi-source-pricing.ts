/**
 * Multi-Source Pricing Search
 * 
 * Unified interface that searches multiple retail APIs (Google Shopping, Amazon, Walmart)
 * and returns the best available price with source attribution.
 * 
 * Strategy:
 * 1. Search Google Shopping first (aggregates multiple sources)
 * 2. If no result, fallback to direct Amazon search
 * 3. If still no result, fallback to direct Walmart search
 * 
 * This covers edge cases where:
 * - Products aren't indexed by Google Shopping (niche brands like Panda's Promise)
 * - Google Shopping shows bundles instead of singles (Milamend 3-pack issue)
 * - Products are exclusive to one retailer
 */

import { searchGoogleShopping, type PriceLookupResult } from './google-shopping-search.js';
import { searchAmazonWithFallback, type AmazonPriceLookupResult } from './amazon-search.js';
import { searchWalmart, type WalmartPriceLookupResult } from './walmart-search.js';

export interface MultiSourcePriceResult {
  // Best price found across all sources
  bestPrice: number | null;
  bestPriceSource: 'google-shopping' | 'amazon' | 'amazon-direct' | 'walmart' | 'walmart-direct' | 'target' | 'retail' | null;
  bestPriceUrl: string | null;
  
  // Individual source results (for debugging/analysis)
  googleShoppingResult: PriceLookupResult | null;
  amazonDirectResult: AmazonPriceLookupResult | null;
  walmartDirectResult: WalmartPriceLookupResult | null;
  
  // Metadata
  searchedSources: string[];
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
}

export interface MultiSourceOptions {
  /**
   * Search strategy:
   * - 'google-first': Try Google Shopping first, then fallback to direct APIs
   * - 'parallel': Search all sources in parallel and pick best
   * - 'direct-only': Skip Google Shopping, only use Amazon/Walmart direct
   */
  strategy?: 'google-first' | 'parallel' | 'direct-only';
  
  /**
   * Whether to search Amazon directly (uses API quota)
   */
  searchAmazon?: boolean;
  
  /**
   * Whether to search Walmart directly (uses API quota)
   */
  searchWalmart?: boolean;
  
  /**
   * Maximum acceptable price difference between sources (as percentage)
   * Used to detect potential bundle/lot mismatches
   */
  maxPriceVariance?: number;
}

const DEFAULT_OPTIONS: Required<MultiSourceOptions> = {
  strategy: 'google-first',
  searchAmazon: true,
  searchWalmart: true,
  maxPriceVariance: 3.0, // 300% - if prices differ by more, flag as suspicious
};

/**
 * Search multiple retail sources for product pricing
 * 
 * @param brand - Product brand (e.g., "Panda's Promise")
 * @param productName - Product name with size/count (e.g., "Immune Support Gummies 60ct")
 * @param options - Search options
 */
export async function searchMultipleSources(
  brand: string,
  productName: string,
  options: MultiSourceOptions = {}
): Promise<MultiSourcePriceResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const searchedSources: string[] = [];
  
  let googleShoppingResult: PriceLookupResult | null = null;
  let amazonDirectResult: AmazonPriceLookupResult | null = null;
  let walmartDirectResult: WalmartPriceLookupResult | null = null;
  
  console.log(`[multi-source] Starting search for "${brand} ${productName}" with strategy: ${opts.strategy}`);
  
  // Strategy: google-first
  if (opts.strategy === 'google-first') {
    // Step 1: Try Google Shopping
    searchedSources.push('google-shopping');
    googleShoppingResult = await searchGoogleShopping(brand, productName);
    
    // If Google Shopping found a good result, use it
    if (googleShoppingResult.bestPrice !== null && googleShoppingResult.confidence !== 'low') {
      console.log(`[multi-source] ✅ Google Shopping found: $${googleShoppingResult.bestPrice} (${googleShoppingResult.bestPriceSource})`);
      
      return {
        bestPrice: googleShoppingResult.bestPrice,
        bestPriceSource: (googleShoppingResult.bestPriceSource as MultiSourcePriceResult['bestPriceSource']) || 'retail',
        bestPriceUrl: googleShoppingResult.bestPriceUrl,
        googleShoppingResult,
        amazonDirectResult: null,
        walmartDirectResult: null,
        searchedSources,
        confidence: googleShoppingResult.confidence,
        reasoning: `Found via Google Shopping: ${googleShoppingResult.reasoning}`,
      };
    }
    
    console.log(`[multi-source] Google Shopping returned no/low-confidence result, trying direct APIs...`);
    
    // Step 2: Fallback to direct Amazon (with brand-only fallback)
    if (opts.searchAmazon) {
      searchedSources.push('amazon-direct');
      amazonDirectResult = await searchAmazonWithFallback(brand, productName, true);
      
      if (amazonDirectResult.price !== null && amazonDirectResult.confidence !== 'low') {
        console.log(`[multi-source] ✅ Amazon Direct found: $${amazonDirectResult.price}`);
        
        return {
          bestPrice: amazonDirectResult.price,
          bestPriceSource: 'amazon-direct',
          bestPriceUrl: amazonDirectResult.url,
          googleShoppingResult,
          amazonDirectResult,
          walmartDirectResult: null,
          searchedSources,
          confidence: amazonDirectResult.confidence,
          reasoning: `Found via direct Amazon search: ${amazonDirectResult.reasoning}`,
        };
      }
    }
    
    // Step 3: Fallback to direct Walmart
    if (opts.searchWalmart) {
      searchedSources.push('walmart-direct');
      walmartDirectResult = await searchWalmart(brand, productName);
      
      if (walmartDirectResult.price !== null && walmartDirectResult.confidence !== 'low') {
        console.log(`[multi-source] ✅ Walmart Direct found: $${walmartDirectResult.price}`);
        
        return {
          bestPrice: walmartDirectResult.price,
          bestPriceSource: 'walmart-direct',
          bestPriceUrl: walmartDirectResult.url,
          googleShoppingResult,
          amazonDirectResult,
          walmartDirectResult,
          searchedSources,
          confidence: walmartDirectResult.confidence,
          reasoning: `Found via direct Walmart search: ${walmartDirectResult.reasoning}`,
        };
      }
    }
    
    // No results from any source
    console.log(`[multi-source] ❌ No results from any source`);
    return {
      bestPrice: null,
      bestPriceSource: null,
      bestPriceUrl: null,
      googleShoppingResult,
      amazonDirectResult,
      walmartDirectResult,
      searchedSources,
      confidence: 'low',
      reasoning: 'No pricing found from any source (Google Shopping, Amazon, Walmart)',
    };
  }
  
  // Strategy: parallel
  if (opts.strategy === 'parallel') {
    // Search all sources in parallel (Amazon uses brand-only fallback)
    const [gsResult, amzResult, wmResult] = await Promise.all([
      searchGoogleShopping(brand, productName),
      opts.searchAmazon ? searchAmazonWithFallback(brand, productName, true) : Promise.resolve(null),
      opts.searchWalmart ? searchWalmart(brand, productName) : Promise.resolve(null),
    ]);
    
    googleShoppingResult = gsResult;
    amazonDirectResult = amzResult;
    walmartDirectResult = wmResult;
    
    searchedSources.push('google-shopping');
    if (opts.searchAmazon) searchedSources.push('amazon-direct');
    if (opts.searchWalmart) searchedSources.push('walmart-direct');
    
    // Collect all valid prices
    const candidates: Array<{
      price: number;
      source: MultiSourcePriceResult['bestPriceSource'];
      url: string | null;
      confidence: 'high' | 'medium' | 'low';
    }> = [];
    
    if (gsResult?.bestPrice) {
      candidates.push({
        price: gsResult.bestPrice,
        source: (gsResult.bestPriceSource as MultiSourcePriceResult['bestPriceSource']) || 'retail',
        url: gsResult.bestPriceUrl,
        confidence: gsResult.confidence,
      });
    }
    
    if (amzResult?.price) {
      candidates.push({
        price: amzResult.price,
        source: 'amazon-direct',
        url: amzResult.url,
        confidence: amzResult.confidence,
      });
    }
    
    if (wmResult?.price) {
      candidates.push({
        price: wmResult.price,
        source: 'walmart-direct',
        url: wmResult.url,
        confidence: wmResult.confidence,
      });
    }
    
    if (candidates.length === 0) {
      return {
        bestPrice: null,
        bestPriceSource: null,
        bestPriceUrl: null,
        googleShoppingResult,
        amazonDirectResult,
        walmartDirectResult,
        searchedSources,
        confidence: 'low',
        reasoning: 'No pricing found from any source',
      };
    }
    
    // Sort by confidence (high > medium > low), then by price (lower is better)
    const confidenceOrder = { high: 0, medium: 1, low: 2 };
    candidates.sort((a, b) => {
      const confDiff = confidenceOrder[a.confidence] - confidenceOrder[b.confidence];
      if (confDiff !== 0) return confDiff;
      return a.price - b.price;
    });
    
    const best = candidates[0];
    
    // Check for price variance (potential bundle/lot mismatch)
    if (candidates.length > 1) {
      const minPrice = Math.min(...candidates.map(c => c.price));
      const maxPrice = Math.max(...candidates.map(c => c.price));
      const variance = maxPrice / minPrice;
      
      if (variance > opts.maxPriceVariance) {
        console.log(`[multi-source] ⚠️ High price variance detected: $${minPrice} - $${maxPrice} (${variance.toFixed(1)}x)`);
      }
    }
    
    return {
      bestPrice: best.price,
      bestPriceSource: best.source,
      bestPriceUrl: best.url,
      googleShoppingResult,
      amazonDirectResult,
      walmartDirectResult,
      searchedSources,
      confidence: best.confidence,
      reasoning: `Best of ${candidates.length} sources: ${best.source} @ $${best.price}`,
    };
  }
  
  // Strategy: direct-only
  if (opts.strategy === 'direct-only') {
    // Search Amazon and Walmart in parallel (Amazon uses brand-only fallback)
    const [amzResult, wmResult] = await Promise.all([
      opts.searchAmazon ? searchAmazonWithFallback(brand, productName, true) : Promise.resolve(null),
      opts.searchWalmart ? searchWalmart(brand, productName) : Promise.resolve(null),
    ]);
    
    amazonDirectResult = amzResult;
    walmartDirectResult = wmResult;
    
    if (opts.searchAmazon) searchedSources.push('amazon-direct');
    if (opts.searchWalmart) searchedSources.push('walmart-direct');
    
    // Prefer Amazon over Walmart
    if (amzResult?.price && amzResult.confidence !== 'low') {
      return {
        bestPrice: amzResult.price,
        bestPriceSource: 'amazon-direct',
        bestPriceUrl: amzResult.url,
        googleShoppingResult: null,
        amazonDirectResult: amzResult,
        walmartDirectResult: wmResult,
        searchedSources,
        confidence: amzResult.confidence,
        reasoning: `Amazon Direct: ${amzResult.reasoning}`,
      };
    }
    
    if (wmResult?.price && wmResult.confidence !== 'low') {
      return {
        bestPrice: wmResult.price,
        bestPriceSource: 'walmart-direct',
        bestPriceUrl: wmResult.url,
        googleShoppingResult: null,
        amazonDirectResult: amzResult,
        walmartDirectResult: wmResult,
        searchedSources,
        confidence: wmResult.confidence,
        reasoning: `Walmart Direct: ${wmResult.reasoning}`,
      };
    }
    
    return {
      bestPrice: null,
      bestPriceSource: null,
      bestPriceUrl: null,
      googleShoppingResult: null,
      amazonDirectResult: amzResult,
      walmartDirectResult: wmResult,
      searchedSources,
      confidence: 'low',
      reasoning: 'No pricing found from direct APIs',
    };
  }
  
  // Fallback (shouldn't reach here)
  return {
    bestPrice: null,
    bestPriceSource: null,
    bestPriceUrl: null,
    googleShoppingResult: null,
    amazonDirectResult: null,
    walmartDirectResult: null,
    searchedSources: [],
    confidence: 'low',
    reasoning: 'Unknown strategy',
  };
}

/**
 * Simple wrapper that returns just the best price
 * For use in the pricing pipeline
 */
export async function getBestRetailPrice(
  brand: string,
  productName: string,
  options?: MultiSourceOptions
): Promise<{
  price: number | null;
  source: string;
  url: string | null;
  confidence: string;
}> {
  const result = await searchMultipleSources(brand, productName, options);
  
  return {
    price: result.bestPrice,
    source: result.bestPriceSource || 'not-found',
    url: result.bestPriceUrl,
    confidence: result.confidence,
  };
}
