/**
 * Delivered-Price-First Pricing Engine (v2)
 * 
 * Prices to delivered-to-door, then backs into item + shipping.
 * Uses Google Shopping for comps (eBay + retail), falls back to sold prices.
 * 
 * ============================================================================
 * CRITICAL DEFINITIONS (DO NOT CONFUSE THESE)
 * ============================================================================
 * 
 * targetDeliveredTotalCents:
 *   What the BUYER pays TOTAL (item + shippingCharge).
 *   This is the anchor for all pricing decisions.
 * 
 * shippingChargeCents:
 *   What the BUYER pays for shipping on eBay.
 *   - 0 if FREE_SHIPPING mode
 *   - flatRateCents if BUYER_PAYS_FLAT mode
 *   - categoryEstimateCents if BUYER_PAYS_CATEGORY_ESTIMATE mode
 * 
 * shippingCostEstimateCents:
 *   What WE estimate we pay the carrier (USPS/UPS).
 *   Used for margin calculations and analytics ONLY.
 *   NEVER affects the buyer-facing split.
 * 
 * ============================================================================
 * INVARIANT (MUST HOLD ALWAYS)
 * ============================================================================
 * 
 * itemPriceCents + shippingChargeCents === targetDeliveredTotalCents
 * 
 * If this invariant is violated, the pricing is WRONG.
 * 
 * ============================================================================
 * SHIPPING MODES
 * ============================================================================
 * 
 * 1. FREE_SHIPPING:
 *    - shippingChargeCents = 0
 *    - itemPriceCents = targetDeliveredTotalCents
 *    - eBay shows "Free shipping" to buyer
 *    - Seller absorbs shipping cost
 * 
 * 2. BUYER_PAYS (flat or category-based):
 *    - shippingChargeCents = flatRateCents or categoryEstimateCents
 *    - itemPriceCents = targetDeliveredTotalCents - shippingChargeCents
 *    - eBay shows shipping charge to buyer
 * 
 * @see docs/PRICING-OVERHAUL.md for full specification
 */

import { searchGoogleShopping, GoogleShoppingResult } from './google-shopping-search.js';
import { fetchSoldPriceStats, SoldPriceStats } from './pricing/ebay-sold-prices.js';
import { getShippingEstimate, ShippingEstimate, ShippingSettings, DEFAULT_SHIPPING_SETTINGS } from './shipping-estimates.js';
import { braveFirstUrl } from './search.js';
import { searchAmazonWithFallback } from './amazon-search.js';
import { searchWalmart } from './walmart-search.js';
import { extractPriceWithShipping } from './html-price.js';

// v2 pricing modules
import { computeRobustStats, isFloorOutlier, isSoldStrong, isActiveStrong, sellThrough, type RobustStats, type CompSample } from './pricing/robust-stats.js';
import { buildIdentity, type CanonicalIdentity } from './pricing/identity-model.js';
import { matchComps, filterMatches, filterMatchesAndAmbiguous, type CompCandidate, type MatchResult } from './pricing/comp-matcher.js';
import { enforceSafetyFloor, estimateProfit, DEFAULT_FEE_MODEL, DEFAULT_SAFETY_INPUTS, type SafetyFloorInputs, type SafetyFloorResult } from './pricing/safety-floors.js';
import { pricingFlags } from './pricing/feature-flags.js';
import { computeConfidence, checkCrossSignal, type ConfidenceInputs, type ConfidenceResult } from './pricing/confidence-scoring.js';
import { searchEbayComps, type EbayCompetitor, type EbayCompsResult } from './ebay-browse-search.js';

// ============================================================================
// Types
// ============================================================================

export type PricingMode = 'market-match' | 'fast-sale' | 'max-margin';

/**
 * What to do when we cannot compete on price
 * - FLAG_ONLY: Create listing but add cannotCompete warning (soft rollout)
 * - AUTO_SKIP: Don't create listing, return skipListing: true
 * - ALLOW_ANYWAY: Create listing even if overpriced (user's choice)
 */
export type LowPriceMode = 'FLAG_ONLY' | 'AUTO_SKIP' | 'ALLOW_ANYWAY';

export interface CompetitorPrice {
  source: 'amazon' | 'walmart' | 'ebay' | 'target' | 'other';
  itemCents: number;
  shipCents: number;        // 0 if free shipping
  deliveredCents: number;   // item + ship
  title: string;
  url: string | null;
  inStock: boolean;
  seller: string;
}

export interface DeliveredPricingSettings {
  mode: PricingMode;
  shippingEstimateCents: number;
  minItemCents: number;
  undercutCents: number;           // For fast-sale mode
  
  // Free shipping controls
  allowFreeShippingWhenNeeded: boolean;  // Auto-enable free ship to hit market price
  freeShippingMaxSubsidyCents: number;   // Max we'll absorb for free shipping
  
  // What to do when we can't compete
  lowPriceMode: LowPriceMode;
  
  // Phase 4: Smart shipping
  useSmartShipping: boolean;       // Use category/comp-based shipping
  shippingSettings?: ShippingSettings;
}

export interface DeliveredPricingDecision {
  // Inputs
  brand: string;
  productName: string;
  
  // Comps
  ebayComps: CompetitorPrice[];
  retailComps: CompetitorPrice[];
  
  // Calculated from active comps
  activeFloorDeliveredCents: number | null;   // lowest eBay comp delivered
  activeMedianDeliveredCents: number | null;  // median eBay comp delivered
  amazonPriceCents: number | null;
  walmartPriceCents: number | null;
  
  // Sold comps (Phase 3)
  soldMedianDeliveredCents: number | null;    // median of sold items
  soldCount: number;                           // number of sold items found
  soldStrong: boolean;                         // soldCount >= 5
  
  // Decision
  mode: PricingMode;
  targetDeliveredCents: number;
  
  // Output
  finalItemCents: number;
  finalShipCents: number;
  freeShipApplied: boolean;
  subsidyCents: number;
  shippingEstimateSource: 'default' | 'flat' | 'category' | 'size-heuristic' | 'comps' | 'comp-median' | 'fixed';
  
  // Skip/compete status
  skipListing: boolean;                        // true = don't create listing
  canCompete: boolean;                         // false = we're overpriced vs market
  
  // Quality
  matchConfidence: 'high' | 'medium' | 'low';
  fallbackUsed: boolean;
  compsSource: 'ebay-browse' | 'ebay' | 'google-shopping' | 'fallback';
  warnings: string[];
}

export interface DeliveredPricingLog {
  version: '1.0';
  timestamp: string;
  userId?: string;
  jobId?: string;
  groupId?: string;
  decision: DeliveredPricingDecision;
}

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_PRICING_SETTINGS: DeliveredPricingSettings = {
  mode: 'market-match',
  shippingEstimateCents: 600,          // $6.00 default shipping template
  minItemCents: 499,                   // $4.99 item price floor
  undercutCents: 100,                  // $1.00 undercut for fast-sale
  
  // Smart defaults: enable free shipping to compete
  allowFreeShippingWhenNeeded: true,   // Auto-enable free ship when market demands it
  freeShippingMaxSubsidyCents: 500,    // Max $5.00 subsidy (prevents losing money)
  lowPriceMode: 'FLAG_ONLY',           // Soft rollout: flag but don't skip
  
  useSmartShipping: true,              // Use category/comp-based shipping
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Parse shipping info from Google Shopping delivery field
 * Examples: "Free delivery", "Free delivery by Fri", "+$5.99 shipping", "$4.99 delivery"
 */
export function parseShippingFromDelivery(delivery: string | undefined): number {
  if (!delivery) return 0;
  
  const lower = delivery.toLowerCase();
  
  // Free shipping
  if (lower.includes('free')) return 0;
  
  // Extract dollar amount: "+$5.99 shipping" or "$4.99 delivery"
  const match = delivery.match(/\$(\d+(?:\.\d{2})?)/);
  if (match) {
    return Math.round(parseFloat(match[1]) * 100);
  }
  
  return 0; // Default to free if can't parse
}

/**
 * Convert Google Shopping result to CompetitorPrice
 */
export function googleResultToCompetitor(result: GoogleShoppingResult): CompetitorPrice {
  const seller = result.seller?.toLowerCase() || '';
  const itemCents = Math.round(result.extracted_price * 100);
  const shipCents = parseShippingFromDelivery(result.delivery);
  
  let source: CompetitorPrice['source'] = 'other';
  if (seller.includes('amazon') && !seller.includes('marketplace')) {
    source = 'amazon';
  } else if (seller.includes('walmart')) {
    source = 'walmart';
  } else if (seller === 'target') {
    source = 'target';
  } else if (seller.includes('ebay')) {
    source = 'ebay';
  }
  
  return {
    source,
    itemCents,
    shipCents,
    deliveredCents: itemCents + shipCents,
    title: result.title || '',
    url: result.link || result.product_link || null,
    inStock: result.stock_information?.toLowerCase() !== 'out of stock',
    seller: result.seller || 'unknown',
  };
}

/**
 * Calculate median of an array of numbers
 */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  
  if (sorted.length % 2 === 0) {
    return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }
  return sorted[mid];
}

/**
 * Check if any retail comp title contains the brand name
 * Used to detect when retail comps are from wrong brands
 */
function retailCompsIncludeBrand(retailComps: CompetitorPrice[], brand: string): boolean {
  if (!brand) return false;
  const brandLower = brand.toLowerCase();
  return retailComps.some(c => 
    c.title.toLowerCase().includes(brandLower) ||
    c.seller.toLowerCase().includes(brandLower)
  );
}

/**
 * Fetch HTML from a URL with timeout
 */
async function fetchHtmlWithTimeout(url: string, timeoutMs = 8000): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    });
    clearTimeout(timeout);
    
    if (!res.ok) return null;
    return await res.text();
  } catch (err) {
    console.log(`[delivered-pricing] Failed to fetch ${url}: ${err}`);
    return null;
  }
}

/**
 * Fallback: Search Amazon via Brave when Google Shopping fails to find brand
 * Returns price in cents or null if not found
 */
async function braveAmazonFallback(brand: string, productName: string): Promise<{ 
  priceCents: number | null;
  url: string | null;
}> {
  const query = `${brand} ${productName}`;
  console.log(`[delivered-pricing] Brave Amazon fallback for: "${query}"`);
  
  const amazonUrl = await braveFirstUrl(query, 'amazon.com');
  if (!amazonUrl) {
    console.log(`[delivered-pricing] Brave found no Amazon result for "${query}"`);
    return { priceCents: null, url: null };
  }
  
  console.log(`[delivered-pricing] Brave found Amazon: ${amazonUrl}`);
  
  // Fetch and extract price from Amazon page
  const html = await fetchHtmlWithTimeout(amazonUrl);
  if (!html) {
    console.log(`[delivered-pricing] Failed to fetch Amazon page`);
    return { priceCents: null, url: amazonUrl };
  }
  
  const result = extractPriceWithShipping(html, productName);
  if (result.amazonItemPrice && result.amazonItemPrice > 0) {
    // Use item + shipping for total delivered price
    const totalPrice = result.amazonItemPrice + (result.amazonShippingPrice || 0);
    const priceCents = Math.round(totalPrice * 100);
    console.log(`[delivered-pricing] Brave Amazon price: $${result.amazonItemPrice.toFixed(2)} + $${(result.amazonShippingPrice || 0).toFixed(2)} ship = $${totalPrice.toFixed(2)} → ${priceCents} cents`);
    return { priceCents, url: amazonUrl };
  }
  
  console.log(`[delivered-pricing] Could not extract price from Amazon page`);
  return { priceCents: null, url: amazonUrl };
}

/**
 * Get the lowest delivered price from eBay comps
 */
export function getActiveFloorDelivered(comps: CompetitorPrice[]): number | null {
  const ebayComps = comps.filter(c => c.source === 'ebay' && c.inStock);
  if (ebayComps.length === 0) return null;
  
  return Math.min(...ebayComps.map(c => c.deliveredCents));
}

/**
 * Get the median delivered price from eBay comps
 */
export function getActiveMedianDelivered(comps: CompetitorPrice[]): number | null {
  const ebayComps = comps.filter(c => c.source === 'ebay' && c.inStock);
  if (ebayComps.length === 0) return null;
  
  return median(ebayComps.map(c => c.deliveredCents));
}

/**
 * Calculate target delivered price based on mode
 * 
 * Phase 3: Now incorporates sold comps:
 * - market-match: min(soldMedian, activeFloor) when soldStrong
 * - max-margin: min(activeMedian, soldMedian) when soldStrong
 * 
 * Phase 4: Always cap against retail prices
 * - If major retailer (Amazon, Walmart, Ulta, etc.) is selling for $X,
 *   we should price at ~80% of that to be competitive
 * - RETAIL_CAP_RATIO: 0.80 = never price above 80% of retail
 */

const RETAIL_CAP_RATIO = 0.80; // Never price above 80% of best retail
const RETAIL_FLOOR_RATIO = 0.65; // Don't price below 65% of trusted retail when sold data may be noisy

export function calculateTargetDelivered(
  mode: PricingMode,
  activeFloor: number | null,
  activeMedian: number | null,
  soldMedian: number | null,
  soldCount: number,
  amazonPrice: number | null,
  walmartPrice: number | null,
  undercutCents: number,
  minDeliveredCents: number,
  retailComps: CompetitorPrice[] = [],
  targetPrice: number | null = null,  // Target.com price
  brandSitePrice: number | null = null  // Brand's official website price (most authoritative)
): { targetCents: number; fallbackUsed: boolean; soldStrong: boolean; warnings: string[] } {
  const warnings: string[] = [];
  let fallbackUsed = false;
  let targetCents: number;
  
  // Sold data is "strong" if we have 5+ samples
  let soldStrong = soldMedian !== null && soldCount >= 5;
  
  if (soldStrong) {
    console.log(`[delivered-pricing] Sold data is STRONG (${soldCount} samples, median $${(soldMedian! / 100).toFixed(2)})`);
  } else if (soldMedian !== null) {
    console.log(`[delivered-pricing] Sold data is weak (${soldCount} samples) - ignoring`);
  }
  
  // Calculate the retail cap - never price above 80% of best retail
  // Filter out obviously wrong retail prices (likely wrong variants/sizes)
  // A retail price < 50% of sold median is almost certainly wrong data (single servings, different sizes)
  // Rationale: Retail should never be less than what things sell for on eBay - eBay is discounted
  const minValidRetailCents = soldStrong ? Math.round(soldMedian! * 0.50) : 500; // At least $5 or 50% of sold median
  
  // RETAIL CAP LOGIC:
  // Only apply retail cap when we have HIGH CONFIDENCE retail data (Brand Site, Amazon, Walmart, or Target)
  // Brand site is MOST authoritative - it's the official MSRP
  // Google Shopping often returns wrong variants (8-count box vs 30 oz bottle) which pollute pricing
  // When sold data is strong, we trust the sold median as the true market price
  
  // VARIANT DETECTION: If brand site exists and other retail is <50% of brand site, 
  // those lower prices are almost certainly different variants (single servings, trial sizes, etc.)
  // In this case, prefer brand site as the authoritative MSRP
  let effectiveBrandSitePrice = brandSitePrice;
  let effectiveAmazonPrice = amazonPrice;
  let effectiveWalmartPrice = walmartPrice;
  let effectiveTargetPrice = targetPrice;
  
  if (brandSitePrice && brandSitePrice >= minValidRetailCents) {
    const variantThreshold = brandSitePrice * 0.50; // 50% of brand site = likely different variant
    
    if (amazonPrice !== null && amazonPrice < variantThreshold) {
      console.log(`[delivered-pricing] ⚠️ Amazon $${(amazonPrice / 100).toFixed(2)} is <50% of brand site $${(brandSitePrice / 100).toFixed(2)} - likely different variant, ignoring`);
      effectiveAmazonPrice = null;
    }
    if (walmartPrice !== null && walmartPrice < variantThreshold) {
      console.log(`[delivered-pricing] ⚠️ Walmart $${(walmartPrice / 100).toFixed(2)} is <50% of brand site $${(brandSitePrice / 100).toFixed(2)} - likely different variant, ignoring`);
      effectiveWalmartPrice = null;
    }
    if (targetPrice !== null && targetPrice < variantThreshold) {
      console.log(`[delivered-pricing] ⚠️ Target $${(targetPrice / 100).toFixed(2)} is <50% of brand site $${(brandSitePrice / 100).toFixed(2)} - likely different variant, ignoring`);
      effectiveTargetPrice = null;
    }
  }
  
  const trustedRetailPrices = [effectiveBrandSitePrice, effectiveAmazonPrice, effectiveWalmartPrice, effectiveTargetPrice].filter((p): p is number => p !== null && p > 0 && p >= minValidRetailCents);
  
  let retailCapCents: number | null = null;
  let lowestRetailCents: number | null = null;
  
  // EXCLUDE discount/liquidation sites - they don't represent true retail value
  const discountSites = [
    'editorialist', 'overstock', 'nordstrom rack', 'hautelook', 'gilt', 
    'poshmark', 'mercari', 'whatnot', 'ebay', 'tjmaxx', 'marshalls',
    'burlington', 'ross', 'bluefly', 'yoox', 'the realreal', 'therealreal',
    'tradesy', 'vestiaire', 'grailed', 'depop', 'offerup', 'craigslist',
    'facebook marketplace', 'letgo', 'wish', 'temu', 'shein', 'aliexpress'
  ];
  
  if (trustedRetailPrices.length > 0) {
    // We have Brand Site/Amazon/Walmart/Target - use that for cap (high confidence)
    lowestRetailCents = Math.min(...trustedRetailPrices);
    retailCapCents = Math.round(lowestRetailCents * RETAIL_CAP_RATIO);
    const capSource = effectiveBrandSitePrice === lowestRetailCents ? 'brand site' 
      : effectiveAmazonPrice === lowestRetailCents ? 'Amazon'
      : effectiveWalmartPrice === lowestRetailCents ? 'Walmart' 
      : 'Target';
    console.log(`[delivered-pricing] Using trusted retail (${capSource}) for cap: $${(lowestRetailCents / 100).toFixed(2)}`);
    console.log(`[delivered-pricing] Retail cap: $${(retailCapCents / 100).toFixed(2)} (80% of $${(lowestRetailCents / 100).toFixed(2)})`);
  } else if (!soldStrong) {
    // No trusted retail AND weak sold data - use Google Shopping with caution
    
    const retailPrices = retailComps
      .filter(c => c.inStock)
      .filter(c => {
        const sellerLower = c.seller.toLowerCase();
        const isDiscount = discountSites.some(s => sellerLower.includes(s));
        if (isDiscount) {
          console.log(`[delivered-pricing] Excluding discount site from retail cap: ${c.seller} @ $${(c.deliveredCents / 100).toFixed(2)}`);
        }
        return !isDiscount;
      })
      .map(c => c.deliveredCents)
      .filter((p): p is number => p !== null && p >= minValidRetailCents);
    
    if (retailPrices.length > 0) {
      lowestRetailCents = Math.min(...retailPrices);
      retailCapCents = Math.round(lowestRetailCents * RETAIL_CAP_RATIO);
      console.log(`[delivered-pricing] Weak sold data - using Google Shopping for cap: $${(lowestRetailCents / 100).toFixed(2)}`);
      console.log(`[delivered-pricing] Retail cap: $${(retailCapCents / 100).toFixed(2)} (80% of $${(lowestRetailCents / 100).toFixed(2)})`);
    }
  } else {
    // Strong sold data but no Amazon/Walmart - SKIP retail cap from Google Shopping
    // Google Shopping often has wrong variants that would incorrectly cap our price
    // HOWEVER: If sold median is 3x+ higher than retail, trust retail (sold data is likely contaminated)
    
    // Get reliable retail prices (excluding discount sites, eBay)
    const reliableRetailPrices = retailComps
      .filter(c => c.inStock)
      .filter(c => {
        const sellerLower = c.seller.toLowerCase();
        // Exclude discount sites AND eBay sellers from this check
        const isDiscount = discountSites.some(s => sellerLower.includes(s));
        const isEbay = c.source === 'ebay';
        return !isDiscount && !isEbay;
      })
      .map(c => c.deliveredCents)
      .filter((p): p is number => p !== null && p >= minValidRetailCents);
    
    console.log(`[delivered-pricing] Reliable retail prices (non-eBay, non-discount, >= $${(minValidRetailCents / 100).toFixed(2)}): ${reliableRetailPrices.map(p => '$' + (p / 100).toFixed(2)).join(', ') || 'none'}`);
    
    if (reliableRetailPrices.length >= 1 && soldMedian) {
      // Sort prices ascending to find lowest cluster
      const sortedRetail = [...reliableRetailPrices].sort((a, b) => a - b);
      const lowestReliableRetail = sortedRetail[0];
      
      // Use the average of the two lowest prices as "expected retail"
      // If only 1 comp, use it directly — even a single retail data point
      // can indicate contamination when sold median is wildly different
      const lowestClusterAvg = sortedRetail.length >= 2
        ? (sortedRetail[0] + sortedRetail[1]) / 2
        : sortedRetail[0];
      
      // If sold median is 1.5x+ higher than lowest retail cluster, sold data is likely contaminated
      // This catches cases where sold data includes multi-packs that weren't filtered
      if (soldMedian > lowestClusterAvg * 1.5) {
        console.log(`[delivered-pricing] ⚠️ Sold median ($${(soldMedian / 100).toFixed(2)}) is ${(soldMedian / lowestClusterAvg).toFixed(1)}x lowest retail cluster ($${(lowestClusterAvg / 100).toFixed(2)})`);
        console.log(`[delivered-pricing] Sold data likely contaminated with multi-packs - ignoring sold data`);
        
        // Mark sold data as NOT strong since it's contaminated
        soldStrong = false;
        
        // Use retail as the cap, but with a smaller discount (95% not 80%)
        // This allows competitive pricing at/just below retail without excessive discounting
        lowestRetailCents = lowestReliableRetail;
        retailCapCents = Math.round(lowestRetailCents * 0.95);
        console.log(`[delivered-pricing] Retail cap: $${(retailCapCents / 100).toFixed(2)} (95% of $${(lowestRetailCents / 100).toFixed(2)})`);
      } else {
        console.log(`[delivered-pricing] Strong sold data (${soldCount} samples) - skipping Google Shopping retail cap (unreliable variants)`);
        console.log(`[delivered-pricing] Trusting sold median: $${(soldMedian / 100).toFixed(2)}`);
      }
    } else {
      console.log(`[delivered-pricing] Strong sold data (${soldCount} samples) - skipping Google Shopping retail cap (unreliable variants)`);
      console.log(`[delivered-pricing] Trusting sold median: $${(soldMedian! / 100).toFixed(2)}`);
    }
  }
  
  // Log retail prices for debugging
  const allRetailPrices = [
    amazonPrice,
    walmartPrice,
    ...retailComps.filter(c => c.inStock).map(c => c.deliveredCents)
  ].filter((p): p is number => p !== null && p > 0);
  
  if (allRetailPrices.length > 0) {
    console.log(`[delivered-pricing] All retail prices: ${allRetailPrices.map(p => '$' + (p / 100).toFixed(2)).join(', ')}`);
  }

  // Try eBay comps first
  if (activeFloor !== null) {
    switch (mode) {
      case 'market-match':
        // Phase 3: Use sold median when strong, but detect outlier floors
        if (soldStrong) {
          // If floor is < 70% of sold median, it's likely an outlier (auction end, damaged item, etc)
          // In that case, use sold median instead of racing to the bottom
          const floorRatio = activeFloor / soldMedian!;
          if (floorRatio < 0.70) {
            // Check if we have ANY retail reference to validate the sold median
            const hasRetailValidation = (retailCapCents !== null) || 
              (amazonPrice !== null) || (walmartPrice !== null) || (brandSitePrice !== null);
            
            if (hasRetailValidation) {
              // Have retail data to cross-check — trust sold median over floor
              targetCents = soldMedian!;
              console.log(`[delivered-pricing] Floor ($${(activeFloor / 100).toFixed(2)}) is outlier (${Math.round(floorRatio * 100)}% of sold median $${(soldMedian! / 100).toFixed(2)}) - using sold median (retail validated)`);
            } else {
              // NO retail data to validate — sold median could be contaminated
              // with multi-packs, bundles, or wrong variants.
              // Cap at 1.5x active floor to prevent wildly inflated prices.
              const maxUplift = Math.round(activeFloor * 1.50);
              targetCents = Math.min(soldMedian!, maxUplift);
              warnings.push('soldMedianCappedNoRetail');
              console.log(`[delivered-pricing] ⚠️ Floor ($${(activeFloor / 100).toFixed(2)}) is ${Math.round(floorRatio * 100)}% of sold median ($${(soldMedian! / 100).toFixed(2)}) but NO retail validation`);
              console.log(`[delivered-pricing] ⚠️ Sold median may be contaminated (multi-packs?) - capping at $${(maxUplift / 100).toFixed(2)} (1.5x floor)`);
            }
          } else {
            targetCents = Math.min(soldMedian!, activeFloor);
            if (soldMedian! < activeFloor) {
              console.log(`[delivered-pricing] Sold median ($${(soldMedian! / 100).toFixed(2)}) < active floor ($${(activeFloor / 100).toFixed(2)}) - using sold`);
            }
          }
        } else {
          targetCents = activeFloor;
        }
        break;
      case 'fast-sale':
        targetCents = Math.max(activeFloor - undercutCents, minDeliveredCents);
        break;
      case 'max-margin':
        // Phase 3: Use min(activeMedian, soldMedian) when sold data is strong
        if (soldStrong) {
          targetCents = Math.min(activeMedian ?? activeFloor, soldMedian!);
        } else {
          targetCents = activeMedian ?? activeFloor;
        }
        break;
    }
  } else if (soldStrong) {
    // No active eBay comps BUT we have strong sold data - use it!
    // This handles cases where Google Shopping doesn't find active listings
    // but eBay sold API finds plenty of recent sales
    targetCents = soldMedian!;
    fallbackUsed = false; // Not a fallback - this is real market data
    warnings.push('usingSoldDataOnly');
    console.log(`[delivered-pricing] No active comps, using sold median: $${(soldMedian! / 100).toFixed(2)}`);
  } else {
    // No eBay comps and no strong sold data - fall back to retail
    fallbackUsed = true;
    warnings.push('noEbayComps');
    
    // Use lowest retail price from any source
    // Priority: Amazon/Walmart first, then any other retail
    const knownRetailPrice = Math.min(
      amazonPrice ?? Infinity,
      walmartPrice ?? Infinity
    );
    
    // Also check all retail comps (brand sites, Target, etc)
    const allRetailPrices = retailComps.length > 0 
      ? Math.min(...retailComps.map(c => c.deliveredCents))
      : Infinity;
    
    const retailPrice = Math.min(knownRetailPrice, allRetailPrices);
    
    if (retailPrice !== Infinity) {
      // Determine pricing strategy based on price source
      // - Amazon/Walmart/Target: 60% (they're typically at MSRP or higher)
      // - Brand site or niche retailer: 80% (they're selling direct at competitive prices)
      const hasKnownRetailer = amazonPrice !== null || walmartPrice !== null;
      
      // Check if the lowest retail price is from a brand site (seller name contains brand)
      const lowestRetailComp = retailComps.length > 0 
        ? retailComps.find(c => c.deliveredCents === allRetailPrices)
        : null;
      const isBrandSite = lowestRetailComp && 
        lowestRetailComp.seller.toLowerCase().includes(
          // Extract first word of brand as key identifier
          (retailComps[0] ? '' : '').toLowerCase().split(/\s+/)[0] || ''
        );
      
      // Use 60% for major retailers, 80% for brand sites/niche sellers
      const discountRatio = hasKnownRetailer ? 0.60 : 0.80;
      targetCents = Math.round(retailPrice * discountRatio);
      warnings.push('usingRetailFallback');
      console.log(`[delivered-pricing] Using retail fallback: $${(retailPrice / 100).toFixed(2)} → target $${(targetCents / 100).toFixed(2)} (${Math.round(discountRatio * 100)}%${hasKnownRetailer ? ' major retail' : ' brand/niche site'})`);
    } else {
      // No pricing data at all
      targetCents = 0;
      warnings.push('noPricingData');
    }
  }
  
  // Apply retail cap - never price above discounted retail
  // The retail cap IS the deal (80% of retail = 20% off for buyers)
  // We WANT to beat eBay competition, not match them
  if (retailCapCents !== null && targetCents > retailCapCents) {
    console.log(`[delivered-pricing] Applying retail cap: $${(targetCents / 100).toFixed(2)} → $${(retailCapCents / 100).toFixed(2)} (deal price)`);
    warnings.push('retailCapApplied');
    targetCents = retailCapCents;
  }

  // Apply a retail floor when we have trusted retail and strong sold data but the target is too low
  // This catches cases where sold comps include cheaper variants (e.g., older model/OG) that drag the median down
  if (lowestRetailCents !== null && soldStrong) {
    const retailFloorCents = Math.round(lowestRetailCents * RETAIL_FLOOR_RATIO);
    const newTarget = Math.max(targetCents, retailFloorCents, minDeliveredCents);
    if (newTarget > targetCents) {
      console.log(`[delivered-pricing] Applying retail floor: $${(targetCents / 100).toFixed(2)} → $${(newTarget / 100).toFixed(2)} (floor ${Math.round(RETAIL_FLOOR_RATIO * 100)}% of trusted retail $${(lowestRetailCents / 100).toFixed(2)})`);
      warnings.push('retailFloorApplied');
      targetCents = newTarget;
    }
  }

  return { targetCents, fallbackUsed, soldStrong, warnings };
}

/**
 * Split delivered price into item + shipping for eBay listing.
 * 
 * ============================================================================
 * KEY DEFINITIONS (do not confuse these)
 * ============================================================================
 * 
 * targetDeliveredCents:
 *   The total price we want the BUYER to pay (item + shipping shown on eBay).
 *   This is computed from market comps and is the anchor for pricing decisions.
 * 
 * buyerShippingChargeCents (settings.shippingEstimateCents):
 *   The shipping amount shown to the BUYER when mode=BUYER_PAYS_SHIPPING.
 *   This is what eBay displays as the shipping cost.
 *   IMPORTANT: This is NOT the same as carrierShippingCostEstimateCents!
 * 
 * carrierShippingCostEstimateCents:
 *   Our internal estimate of what shipping will cost US (carrier cost).
 *   Used for margin calculations ONLY. Never affects buyer-facing split.
 * 
 * minItemCents:
 *   Minimum allowed item price (prevents $0.01 items). Default: $4.99.
 * 
 * ============================================================================
 * INVARIANT: totalDelivered === finalItemCents + finalShipCents (always)
 * ============================================================================
 * 
 * WORKED EXAMPLE A — Normal buyer-pays-shipping (OK):
 *   Input:  targetDeliveredCents=2038 ($20.38), buyerShippingChargeCents=600, minItemCents=499
 *   Calc:   rawItem = 2038 - 600 = 1438 ($14.38)
 *   Check:  1438 >= 499? YES → canCompete=true
 *   Output: finalItem=1438, finalShip=600, total=2038, canCompete=true
 * 
 * WORKED EXAMPLE B — Buyer-pays-shipping triggers cannotCompete:
 *   Input:  targetDeliveredCents=900 ($9.00), buyerShippingChargeCents=600, minItemCents=499
 *   Calc:   rawItem = 900 - 600 = 300 ($3.00)
 *   Check:  300 >= 499? NO → clamp to 499
 *   Total:  499 + 600 = 1099 > 900 → cannotCompete
 *   Output: finalItem=499, finalShip=600, total=1099, canCompete=false
 * 
 * WORKED EXAMPLE C — Auto free-shipping fallback fixes it:
 *   Input:  targetDeliveredCents=900, buyerShippingChargeCents=600, minItemCents=499,
 *           allowAutoFreeShippingOnLowPrice=true
 *   Calc:   rawItem = 900 - 600 = 300 < 499 → try free shipping
 *   Free:   finalItem = 900 (= targetDelivered), finalShip = 0
 *   Check:  900 >= 499? YES → canCompete=true
 *   Output: finalItem=900, finalShip=0, total=900, canCompete=true,
 *           warning='autoFreeShippingOnLowPrice'
 * 
 * @param targetDeliveredCents - What buyer pays TOTAL (item + buyerShippingCharge)
 * @param settings - Pricing settings including shippingEstimateCents (= buyerShippingChargeCents)
 * @param shippingEstimateSource - Source of the shipping estimate for logging
 */
export function splitDeliveredPrice(
  targetDeliveredCents: number,
  settings: DeliveredPricingSettings,
  shippingEstimateSource: 'default' | 'flat' | 'category' | 'size-heuristic' | 'comps' | 'comp-median' | 'fixed' = 'fixed'
): {
  itemCents: number;
  shipCents: number;
  subsidyCents: number;
  freeShipApplied: boolean;
  canCompete: boolean;
  skipListing: boolean;
  shippingEstimateSource: 'default' | 'flat' | 'category' | 'size-heuristic' | 'comps' | 'comp-median' | 'fixed';
  warnings: string[];
} {
  const warnings: string[] = [];
  
  // shippingChargeCents = what BUYER pays for shipping (NOT carrier cost)
  // This is the SAME value used to compute targetDelivered from comps
  const shippingChargeCents = settings.shippingEstimateCents;
  const minItemCents = settings.minItemCents;
  
  console.log(`[split-price] ── SPLIT CALCULATION ──`);
  console.log(`[split-price] Input: targetDelivered=$${(targetDeliveredCents / 100).toFixed(2)}, shippingCharge=$${(shippingChargeCents / 100).toFixed(2)}, minItem=$${(minItemCents / 100).toFixed(2)}`);
  
  // Calculate what item price would be with buyer-pays shipping
  const naiveItemCents = targetDeliveredCents - shippingChargeCents;
  console.log(`[split-price] Naive split: item=$${(naiveItemCents / 100).toFixed(2)} (targetDelivered - shippingCharge)`);
  
  // ========================================================================
  // Case 1: Normal split works (item >= min)
  // INVARIANT: naiveItemCents + shippingChargeCents === targetDeliveredCents ✓
  // ========================================================================
  if (naiveItemCents >= minItemCents) {
    console.log(`[split-price] ✅ Case 1: Normal split works (item $${(naiveItemCents / 100).toFixed(2)} >= min $${(minItemCents / 100).toFixed(2)})`);
    console.log(`[split-price] Result: item=$${(naiveItemCents / 100).toFixed(2)} + ship=$${(shippingChargeCents / 100).toFixed(2)} = $${((naiveItemCents + shippingChargeCents) / 100).toFixed(2)}`);
    return {
      itemCents: naiveItemCents,
      shipCents: shippingChargeCents,
      subsidyCents: 0,
      freeShipApplied: false,
      canCompete: true,
      skipListing: false,
      shippingEstimateSource,
      warnings,
    };
  }
  
  console.log(`[split-price] ⚠️ Item $${(naiveItemCents / 100).toFixed(2)} < min $${(minItemCents / 100).toFixed(2)} - trying free shipping fallback`);
  
  // ========================================================================
  // Case 2: Item price would be below min floor
  // Try switching to FREE_SHIPPING if allowed
  // ========================================================================
  if (settings.allowFreeShippingWhenNeeded) {
    const subsidyNeeded = shippingChargeCents; // Full shipping absorbed by seller
    console.log(`[split-price] Free shipping allowed, subsidy needed: $${(subsidyNeeded / 100).toFixed(2)} (max: $${(settings.freeShippingMaxSubsidyCents / 100).toFixed(2)})`);
    
    // With free shipping: shippingChargeCents = 0, itemCents = targetDelivered
    // INVARIANT: targetDeliveredCents + 0 === targetDeliveredCents ✓
    const freeShipItemCents = targetDeliveredCents;
    console.log(`[split-price] With free ship: item would be $${(freeShipItemCents / 100).toFixed(2)} (= targetDelivered)`);
    
    // Check: can we afford the subsidy AND is item price >= min floor?
    // AUTO-FREE-SHIPPING FALLBACK: When buyer-pays-shipping would push item
    // below minItemCents, switch to FREE_SHIPPING mode if allowed. This lets
    // us compete on low-price items without violating the min floor.
    if (subsidyNeeded <= settings.freeShippingMaxSubsidyCents && freeShipItemCents >= minItemCents) {
      console.log(`[split-price] ✅ Case 2: Free shipping works! item=$${(freeShipItemCents / 100).toFixed(2)} + ship=$0 = $${(freeShipItemCents / 100).toFixed(2)}`);
      warnings.push('autoFreeShippingOnLowPrice');
      return {
        itemCents: freeShipItemCents,
        shipCents: 0,  // FREE_SHIPPING mode
        subsidyCents: subsidyNeeded,
        freeShipApplied: true,
        canCompete: true,
        skipListing: false,
        shippingEstimateSource,
        warnings,
      };
    }
    
    // Free shipping would help but subsidy exceeds our cap
    if (freeShipItemCents >= minItemCents && subsidyNeeded > settings.freeShippingMaxSubsidyCents) {
      console.log(`[split-price] ❌ Subsidy $${(subsidyNeeded / 100).toFixed(2)} exceeds cap $${(settings.freeShippingMaxSubsidyCents / 100).toFixed(2)}`);
      warnings.push('subsidyExceedsCap');
      // Fall through to cannotCompete
    }
    
    // Item price still below min even with free shipping
    if (freeShipItemCents < minItemCents) {
      console.log(`[split-price] ❌ Even with free ship, item $${(freeShipItemCents / 100).toFixed(2)} < min $${(minItemCents / 100).toFixed(2)}`);
    }
  }
  
  // ========================================================================
  // Case 3: Cannot compete - target delivered is below our floor
  // DO NOT silently clamp. Return explicit cannotCompete.
  // ========================================================================
  // CLAMP TO MIN: rawItem was below minItemCents, and free-ship fallback
  // either wasn't allowed or subsidy exceeded cap. We must use minItemCents.
  // totalDelivered will now EXCEED targetDeliveredCents → cannotCompete.
  console.log(`[split-price] 🚫 Case 3: CANNOT COMPETE - market price too low`);
  warnings.push('minItemFloorHit');
  warnings.push('cannotCompete');
  
  // Determine skip behavior based on lowPriceMode
  const skipListing = settings.lowPriceMode === 'AUTO_SKIP';
  const canCompete = false;
  
  // Return our minimum viable price (will be overpriced vs market)
  // Use free shipping if enabled and within subsidy cap to get closer
  if (settings.allowFreeShippingWhenNeeded && shippingChargeCents <= settings.freeShippingMaxSubsidyCents) {
    console.log(`[split-price] Returning min price with free ship: item=$${(minItemCents / 100).toFixed(2)} + ship=$0`);
    // Even though we can't fully compete, free shipping gets us closer
    // INVARIANT: minItemCents + 0 !== targetDeliveredCents (but we're explicit about cannotCompete)
    return {
      itemCents: minItemCents,
      shipCents: 0,
      subsidyCents: shippingChargeCents,
      freeShipApplied: true,
      canCompete,
      skipListing,
      shippingEstimateSource,
      warnings,
    };
  }
  
  // No free shipping available - return min item + shipping (overpriced)
  console.log(`[split-price] Returning min price with shipping: item=$${(minItemCents / 100).toFixed(2)} + ship=$${(shippingChargeCents / 100).toFixed(2)}`);
  // INVARIANT: minItemCents + shippingChargeCents !== targetDeliveredCents (but we're explicit about cannotCompete)
  return {
    itemCents: minItemCents,
    shipCents: shippingChargeCents,
    subsidyCents: 0,
    freeShipApplied: false,
    canCompete,
    skipListing,
    shippingEstimateSource,
    warnings,
  };
}

// ============================================================================
// v2 Target Selection (percentile-based)
// ============================================================================

/**
 * v2 target price selection using robust percentile stats.
 * 
 * Pseudocode from plan:
 *   If soldStrong: base = soldStats.P35
 *   Else if activeStrong: base = activeStats.P20
 *   Else if retailAnchor: base = retailAnchor * 0.70
 *   Else: MANUAL_REVIEW_REQUIRED
 * 
 *   Caps: min(base, activeP65), min(base, 0.80 * lowestTrustedRetail)
 *   Floor guard: ignore single lowest active if it's an outlier
 */
export function calculateTargetDeliveredV2(
  mode: PricingMode,
  soldStats: RobustStats | null,
  activeStats: RobustStats | null,
  lowestTrustedRetailCents: number | null,
  undercutCents: number,
  minDeliveredCents: number,
): { targetCents: number; fallbackUsed: boolean; soldStrong: boolean; activeStrong: boolean; warnings: string[] } {
  const warnings: string[] = [];
  let fallbackUsed = false;

  const soldStrong = soldStats !== null && isSoldStrong(soldStats);
  const activeStrong = activeStats !== null && isActiveStrong(activeStats);

  let base: number;

  // === Primary target selection ===
  if (soldStrong) {
    switch (mode) {
      case 'market-match':
        base = soldStats!.p35;
        console.log(`[pricing-v2] SoldStrong → base = SoldP35 = $${(base / 100).toFixed(2)}`);
        break;
      case 'fast-sale': {
        const fastBase = activeStrong
          ? Math.min(activeStats!.p20, soldStats!.p35)
          : soldStats!.p35;
        base = Math.max(fastBase - undercutCents, minDeliveredCents);
        console.log(`[pricing-v2] Fast-sale → base = $${(base / 100).toFixed(2)}`);
        break;
      }
      case 'max-margin':
        base = activeStrong
          ? Math.min(soldStats!.p50, activeStats!.p35)
          : soldStats!.p50;
        console.log(`[pricing-v2] Max-margin → base = $${(base / 100).toFixed(2)}`);
        break;
    }
  } else if (activeStrong) {
    switch (mode) {
      case 'market-match':
        base = activeStats!.p20;
        console.log(`[pricing-v2] ActiveStrong (no sold) → base = ActiveP20 = $${(base / 100).toFixed(2)}`);
        break;
      case 'fast-sale':
        base = Math.max(activeStats!.p20 - undercutCents, minDeliveredCents);
        console.log(`[pricing-v2] Fast-sale (active only) → base = $${(base / 100).toFixed(2)}`);
        break;
      case 'max-margin':
        base = activeStats!.p35;
        console.log(`[pricing-v2] Max-margin (active only) → base = ActiveP35 = $${(base / 100).toFixed(2)}`);
        break;
    }
  } else if (lowestTrustedRetailCents !== null) {
    base = Math.round(lowestTrustedRetailCents * 0.70);
    fallbackUsed = true;
    warnings.push('usingRetailAnchorOnly');
    console.log(`[pricing-v2] No strong sold/active → retail anchor * 0.70 = $${(base / 100).toFixed(2)}`);
  } else {
    // No reliable signal
    base = 0;
    fallbackUsed = true;
    warnings.push('manualReviewRequired');
    warnings.push('noPricingData');
    console.log(`[pricing-v2] No pricing signal → MANUAL_REVIEW_REQUIRED`);
    return { targetCents: 0, fallbackUsed, soldStrong, activeStrong, warnings };
  }

  // === Caps ===
  // Active cap: don't exceed ActiveP65 unless sold data justifies it
  if (activeStrong) {
    const activeCap = activeStats!.p65;
    if (base > activeCap && !(soldStrong && sellThrough(soldStats!.count, activeStats!.count)! > 0.40)) {
      console.log(`[pricing-v2] Active cap: $${(base / 100).toFixed(2)} → $${(activeCap / 100).toFixed(2)} (ActiveP65)`);
      warnings.push('activeCapApplied');
      base = activeCap;
    }
  }

  // Retail cap: 80% of lowest trusted retail
  if (lowestTrustedRetailCents !== null) {
    const retailCap = Math.round(lowestTrustedRetailCents * RETAIL_CAP_RATIO);
    if (base > retailCap) {
      console.log(`[pricing-v2] Retail cap: $${(base / 100).toFixed(2)} → $${(retailCap / 100).toFixed(2)} (80% of $${(lowestTrustedRetailCents / 100).toFixed(2)})`);
      warnings.push('retailCapApplied');
      base = retailCap;
    }
  }

  // Floor guard: if single lowest active is an outlier, flag it
  if (activeStrong && isFloorOutlier(activeStats!)) {
    warnings.push('floorOutlierIgnored');
    console.log(`[pricing-v2] Floor outlier detected: active min $${(activeStats!.min / 100).toFixed(2)} < 80% of P20 $${(activeStats!.p20 / 100).toFixed(2)}`);
  }

  // Uplift guard: sold vs active mismatch
  if (soldStrong && activeStrong) {
    const soldP35 = soldStats!.p35;
    const activeP35 = activeStats!.p35;
    if (activeP35 > 0 && soldP35 > activeP35 * 1.25) {
      warnings.push('soldActiveMismatch');
      console.log(`[pricing-v2] ⚠️ SoldP35 ($${(soldP35 / 100).toFixed(2)}) > 1.25x ActiveP35 ($${(activeP35 / 100).toFixed(2)}) — possible sold contamination`);
    }
  }

  // Enforce minimum
  base = Math.max(base, minDeliveredCents);

  return { targetCents: base, fallbackUsed, soldStrong, activeStrong, warnings };
}

// ============================================================================
// v2 Comp Conversion Helpers
// ============================================================================

/**
 * Convert CompetitorPrice[] to CompSample[] for robust stats.
 */
function toCompSamples(comps: CompetitorPrice[]): CompSample[] {
  return comps
    .filter(c => c.inStock && c.deliveredCents > 0)
    .map(c => ({
      itemCents: c.itemCents,
      shipCents: c.shipCents,
      deliveredCents: c.deliveredCents,
    }));
}

/**
 * Convert EbayCompetitor[] (from Browse API) to CompCandidate[] for matcher.
 */
function browseToCompCandidates(comps: EbayCompetitor[]): CompCandidate[] {
  return comps.map(c => ({
    id: c.itemId,
    title: c.title,
    condition: c.condition,
    priceCents: c.itemPriceCents,
    shippingCents: c.shippingCents,
    deliveredCents: c.deliveredCents,
    url: c.url,
  }));
}

/**
 * Convert CompetitorPrice[] to CompCandidate[] for matcher.
 */
function competitorToCompCandidates(comps: CompetitorPrice[]): CompCandidate[] {
  return comps.map((c, i) => ({
    id: `comp-${i}`,
    title: c.title,
    condition: 'New', // Google Shopping comps are generally new
    priceCents: c.itemCents,
    shippingCents: c.shipCents,
    deliveredCents: c.deliveredCents,
    url: c.url ?? undefined,
  }));
}

/**
 * Convert MatchResult[] back to CompetitorPrice[] (for downstream compatibility).
 */
function matchResultsToCompetitors(results: MatchResult[], source: CompetitorPrice['source'] = 'ebay'): CompetitorPrice[] {
  return results.map(r => ({
    source,
    itemCents: r.candidate.priceCents,
    shipCents: r.candidate.shippingCents,
    deliveredCents: r.candidate.deliveredCents,
    title: r.candidate.title,
    url: r.candidate.url ?? null,
    inStock: true,
    seller: 'ebay',
  }));
}

// ============================================================================
// Main Function
// ============================================================================

/**
 * Get delivered-price-first competitive pricing for a product
 * 
 * This is the main entry point for the pricing engine.
 * 
 * When DP_PRICING_V2=true:
 *   - Uses percentile-based targeting (P35/P20) with IQR outlier rejection
 *   - Identity-based comp filtering (when DP_IDENTITY_FILTER=true)
 *   - eBay Browse API for active comps (when DP_EBAY_BROWSE_ACTIVE=true)
 *   - Safety floor enforcement (when DP_SAFETY_FLOOR=true)
 *   - Confidence scoring with review triggers (when DP_CONFIDENCE_SCORING=true)
 * 
 * When DP_PRICING_V2=false (default):
 *   - Legacy floor/median targeting via calculateTargetDelivered()
 *   - Google Shopping for comps
 * 
 * @param brand - Product brand
 * @param productName - Product name with size/count
 * @param settings - Pricing settings (optional, uses defaults)
 * @param additionalContext - Optional SEO terms or category context to improve search matching
 * @returns DeliveredPricingDecision with final item/ship prices and evidence
 */
export async function getDeliveredPricing(
  brand: string,
  productName: string,
  settings: Partial<DeliveredPricingSettings> = {},
  additionalContext?: string
): Promise<DeliveredPricingDecision> {
  const fullSettings: DeliveredPricingSettings = { ...DEFAULT_PRICING_SETTINGS, ...settings };
  const warnings: string[] = [];
  const flags = pricingFlags();

  const searchTerms = additionalContext 
    ? `${brand} ${productName} + context: ${additionalContext}` 
    : `${brand} ${productName}`;
  console.log(`[delivered-pricing] Pricing "${searchTerms}" in ${fullSettings.mode} mode${flags.v2Enabled ? ' [v2]' : ''}`);

  // ========================================================================
  // v2 PIPELINE — percentile-based with identity filtering
  // ========================================================================
  if (flags.v2Enabled) {
    return getDeliveredPricingV2(brand, productName, fullSettings, additionalContext, flags);
  }

  // ========================================================================
  // LEGACY PIPELINE — floor/median targeting via Google Shopping
  // ========================================================================

  // === Step 1: Search Google Shopping for all comps ===
  // Note: eBay Browse API is unreliable/deprecated, so we use Google Shopping
  // which indexes eBay listings along with Amazon, Walmart, etc.
  const searchResult = await searchGoogleShopping(brand, productName, additionalContext);
  
  // Convert to CompetitorPrice format
  const googleComps = searchResult.allResults.map(googleResultToCompetitor);
  
  // Separate eBay comps from retail comps
  const ebayComps = googleComps.filter(c => c.source === 'ebay');
  const retailComps = googleComps.filter(c => c.source !== 'ebay');
  const compsSource: 'ebay' | 'ebay-browse' | 'google-shopping' | 'fallback' = 'google-shopping';
  
  console.log(`[delivered-pricing] Google Shopping: ${ebayComps.length} eBay comps, ${retailComps.length} retail comps`);

  // Calculate metrics using eBay comps
  const allComps = [...ebayComps, ...retailComps];
  const activeFloor = ebayComps.length > 0 
    ? Math.min(...ebayComps.map(c => c.deliveredCents))
    : null;
  const activeMedian = ebayComps.length > 0
    ? median(ebayComps.map(c => c.deliveredCents))
    : null;
  
  if (activeFloor !== null) {
    console.log(`[delivered-pricing] eBay floor: $${(activeFloor / 100).toFixed(2)}, median: $${(activeMedian! / 100).toFixed(2)}`);
  }

  // Get trusted retail prices (Amazon, Walmart, Target, Brand Site)
  // Brand site is MOST authoritative - it's the official MSRP
  const amazonComp = allComps.find(c => c.source === 'amazon');
  const walmartComp = allComps.find(c => c.source === 'walmart');
  const targetComp = allComps.find(c => c.source === 'target');
  const amazonPriceCents = amazonComp?.deliveredCents ?? null;
  const walmartPriceCents = walmartComp?.deliveredCents ?? null;
  const targetPriceCents = targetComp?.deliveredCents ?? null;
  
  // Brand site price from Google Shopping (most authoritative retail price)
  const brandSitePriceCents = searchResult.brandSitePrice 
    ? Math.round(searchResult.brandSitePrice * 100) 
    : null;
  
  if (brandSitePriceCents) {
    console.log(`[delivered-pricing] 🏪 Brand site: $${(brandSitePriceCents / 100).toFixed(2)} from ${searchResult.brandSiteSeller}`);
  }
  
  // Get the LOWEST trusted retail price (Brand Site > Amazon > Walmart > Target)
  // Brand site is included because it's the most authoritative source
  const trustedRetailPrices = [brandSitePriceCents, amazonPriceCents, walmartPriceCents, targetPriceCents].filter(p => p !== null) as number[];
  const lowestTrustedRetailCents = trustedRetailPrices.length > 0 ? Math.min(...trustedRetailPrices) : null;

  if (amazonPriceCents) {
    console.log(`[delivered-pricing] Amazon: $${(amazonPriceCents / 100).toFixed(2)} delivered`);
  }
  if (walmartPriceCents) {
    console.log(`[delivered-pricing] Walmart: $${(walmartPriceCents / 100).toFixed(2)} delivered`);
  }
  if (targetPriceCents) {
    console.log(`[delivered-pricing] Target: $${(targetPriceCents / 100).toFixed(2)} delivered`);
  }
  if (lowestTrustedRetailCents) {
    console.log(`[delivered-pricing] Lowest trusted retail: $${(lowestTrustedRetailCents / 100).toFixed(2)}`);
  }

  // === Step 3: Fetch sold comps (Phase 3) ===
  let soldMedianCents: number | null = null;
  let soldCount = 0;
  
  try {
    const soldResult = await fetchSoldPriceStats({
      title: productName,
      brand: brand,
      condition: 'NEW',
    });
    
    if (soldResult.ok && soldResult.samplesCount && soldResult.deliveredMedian) {
      // Use TRUE delivered median (item + actual shipping) - no more guessing!
      soldMedianCents = Math.round(soldResult.deliveredMedian * 100);
      soldCount = soldResult.samplesCount;
      const avgShip = soldResult.avgShipping ? `$${soldResult.avgShipping.toFixed(2)}` : 'n/a';
      console.log(`[delivered-pricing] Sold comps: ${soldCount} samples, delivered median $${(soldMedianCents / 100).toFixed(2)} (avg shipping ${avgShip})`);
    } else if (soldResult.ok && soldResult.samplesCount && soldResult.median) {
      // Fallback: old-style data without shipping - estimate
      soldMedianCents = Math.round(soldResult.median * 100) + fullSettings.shippingEstimateCents;
      soldCount = soldResult.samplesCount;
      console.log(`[delivered-pricing] Sold comps: ${soldCount} samples, item median $${soldResult.median.toFixed(2)} + est shipping = $${(soldMedianCents / 100).toFixed(2)}`);
      warnings.push('soldShippingEstimated');
    } else {
      console.log(`[delivered-pricing] No sold comps found`);
    }
  } catch (err) {
    console.log(`[delivered-pricing] Sold comps error: ${err}`);
    warnings.push('soldCompsError');
  }

  // === Step 4: Brave Amazon Fallback for Niche Brands ===
  // When Google Shopping doesn't find brand-matched retail AND no trusted retailers,
  // try Brave to find the Amazon product page directly
  let braveAmazonPrice: number | null = null;
  let effectiveAmazonPriceCents = amazonPriceCents;
  
  const hasTrustedRetail = amazonPriceCents !== null || walmartPriceCents !== null || targetPriceCents !== null;
  const retailHasBrand = retailCompsIncludeBrand(retailComps, brand);
  const soldStrong = soldMedianCents !== null && soldCount >= 5;
  
  // Try Brave for Amazon when we have NO retail reference at all.
  // Previously gated by !soldStrong, but soldStrong doesn't mean the data is CORRECT:
  // sold comps can be contaminated with multi-packs/bundles, and without a retail
  // reference there's no safety net to catch inflated prices.
  // We still skip if we already have Amazon/Walmart/Target or brand site pricing.
  const hasAnyRetailRef = hasTrustedRetail || brandSitePriceCents !== null;
  
  if (!amazonPriceCents && !hasAnyRetailRef) {
    console.log(`[delivered-pricing] 🔍 No Amazon and no retail reference - trying Brave Amazon fallback for "${brand} ${productName}"`);
    
    const braveResult = await braveAmazonFallback(brand, productName);
    if (braveResult.priceCents) {
      braveAmazonPrice = braveResult.priceCents;
      effectiveAmazonPriceCents = braveAmazonPrice;
      warnings.push('usedBraveAmazonFallback');
      console.log(`[delivered-pricing] ✓ Brave Amazon fallback: $${(braveAmazonPrice / 100).toFixed(2)}`);
    } else if (braveResult.url) {
      // Found Amazon page but couldn't extract price (likely JS-rendered)
      warnings.push('braveAmazonNoPriceExtract');
      if (!retailHasBrand) {
        warnings.push('nicheBrandNeedsReview');
      }
      console.log(`[delivered-pricing] ⚠️ Brave found Amazon page but price extraction failed`);
    } else if (!hasTrustedRetail && !retailHasBrand) {
      // Brave didn't find anything AND no trusted retail - niche brand
      warnings.push('nicheBrandNeedsReview');
      console.log(`[delivered-pricing] ⚠️ NICHE BRAND: "${brand}" has no reliable pricing data - manual review required`);
    }
  }

  // === Step 5: Direct Amazon/Walmart API Fallback ===
  // If we still don't have a trusted retail price, try SearchAPI direct endpoints
  // This catches products that aren't indexed in Google Shopping.
  // Previously gated by !soldStrong, but we need retail as a safety net even WITH
  // strong sold data — sold comps can be contaminated with multi-packs/bundles.
  let effectiveWalmartPriceCents = walmartPriceCents;
  
  if (!effectiveAmazonPriceCents && !effectiveWalmartPriceCents && !hasAnyRetailRef) {
    console.log(`[delivered-pricing] 🔍 No retail prices found - trying direct Amazon/Walmart API fallback`);
    
    try {
      // Try Amazon direct search with brand-only fallback
      const amazonResult = await searchAmazonWithFallback(brand, productName, true);
      if (amazonResult.price !== null && amazonResult.confidence !== 'low') {
        effectiveAmazonPriceCents = Math.round(amazonResult.price * 100);
        warnings.push('usedDirectAmazonAPI');
        console.log(`[delivered-pricing] ✓ Direct Amazon API: $${amazonResult.price.toFixed(2)}`);
      }
    } catch (err) {
      console.log(`[delivered-pricing] Direct Amazon API error: ${err}`);
    }
    
    // Also try Walmart if Amazon didn't work
    if (!effectiveAmazonPriceCents) {
      try {
        const walmartResult = await searchWalmart(brand, productName);
        if (walmartResult.price !== null && walmartResult.confidence !== 'low') {
          effectiveWalmartPriceCents = Math.round(walmartResult.price * 100);
          warnings.push('usedDirectWalmartAPI');
          console.log(`[delivered-pricing] ✓ Direct Walmart API: $${walmartResult.price.toFixed(2)}`);
        }
      } catch (err) {
        console.log(`[delivered-pricing] Direct Walmart API error: ${err}`);
      }
    }
  }

  // Calculate target delivered price
  const minDeliveredCents = fullSettings.minItemCents + fullSettings.shippingEstimateCents;
  const targetResult = calculateTargetDelivered(
    fullSettings.mode,
    activeFloor,
    activeMedian,
    soldMedianCents,
    soldCount,
    effectiveAmazonPriceCents, // Use Brave/Direct API Amazon price if available
    effectiveWalmartPriceCents, // Use Direct API Walmart price if available
    fullSettings.undercutCents,
    minDeliveredCents,
    retailComps,
    targetPriceCents,  // Pass Target.com price
    brandSitePriceCents  // Pass brand's official website price (most authoritative)
  );
  warnings.push(...targetResult.warnings);

  // Handle no pricing data
  if (targetResult.targetCents === 0) {
    console.log(`[delivered-pricing] No pricing data found, using minimum prices`);
    const skipListing = fullSettings.lowPriceMode === 'AUTO_SKIP';
    return {
      brand,
      productName,
      ebayComps,
      retailComps,
      activeFloorDeliveredCents: activeFloor,
      activeMedianDeliveredCents: activeMedian,
      amazonPriceCents: effectiveAmazonPriceCents,
      walmartPriceCents: effectiveWalmartPriceCents,
      soldMedianDeliveredCents: soldMedianCents,
      soldCount,
      soldStrong: targetResult.soldStrong,
      mode: fullSettings.mode,
      targetDeliveredCents: 0,
      finalItemCents: fullSettings.minItemCents,
      finalShipCents: fullSettings.shippingEstimateCents,
      freeShipApplied: false,
      subsidyCents: 0,
      shippingEstimateSource: 'fixed',
      skipListing,
      canCompete: false,
      matchConfidence: 'low',
      fallbackUsed: true,
      compsSource: 'fallback',
      warnings,
    };
  }

  console.log(`[delivered-pricing] Target delivered: $${(targetResult.targetCents / 100).toFixed(2)}`);

  // === Phase 4: Smart Shipping ===
  let effectiveShippingCents = fullSettings.shippingEstimateCents;
  let shippingEstimateSource: 'default' | 'flat' | 'category' | 'size-heuristic' | 'comps' | 'comp-median' | 'fixed' = 'fixed';
  
  if (fullSettings.useSmartShipping) {
    // Get smart shipping estimate
    const shippingEstimate = getShippingEstimate(
      brand,
      productName,
      ebayComps,
      fullSettings.shippingSettings || DEFAULT_SHIPPING_SETTINGS
    );
    
    effectiveShippingCents = shippingEstimate.cents;
    shippingEstimateSource = shippingEstimate.source;
    
    console.log(`[delivered-pricing] Smart shipping: $${(effectiveShippingCents / 100).toFixed(2)} (source: ${shippingEstimateSource}, confidence: ${shippingEstimate.confidence})`);
  }

  // Update settings with smart shipping
  const effectiveSettings: DeliveredPricingSettings = {
    ...fullSettings,
    shippingEstimateCents: effectiveShippingCents,
  };

  // Split into item + shipping
  const splitResult = splitDeliveredPrice(targetResult.targetCents, effectiveSettings, shippingEstimateSource);
  warnings.push(...splitResult.warnings);

  console.log(`[delivered-pricing] Final: item $${(splitResult.itemCents / 100).toFixed(2)} + ship $${(splitResult.shipCents / 100).toFixed(2)}`);

  // Determine confidence based on comp count (active eBay + sold data)
  // Strong sold data (5+ samples) is reliable market data
  let matchConfidence: 'high' | 'medium' | 'low' = 'low';
  if (ebayComps.length >= 5 || targetResult.soldStrong) {
    matchConfidence = 'high';
  } else if (ebayComps.length >= 3 || (ebayComps.length >= 1 && retailComps.length >= 2)) {
    matchConfidence = 'medium';
  } else if (retailComps.length >= 3) {
    // Multiple retail sources without eBay data is at least medium confidence
    matchConfidence = 'medium';
  }

  // Determine final comps source
  let finalCompsSource: 'ebay' | 'ebay-browse' | 'google-shopping' | 'fallback' = compsSource;
  if (targetResult.fallbackUsed && ebayComps.length === 0) {
    finalCompsSource = 'fallback';
  }

  // Log compete status
  if (!splitResult.canCompete) {
    console.log(`[delivered-pricing] ⚠️ Cannot compete: market $${(targetResult.targetCents / 100).toFixed(2)} vs our min $${((splitResult.itemCents + splitResult.shipCents) / 100).toFixed(2)}`);
    if (splitResult.skipListing) {
      console.log(`[delivered-pricing] 🚫 Skipping listing (lowPriceMode: AUTO_SKIP)`);
    }
  }

  if (warnings.length > 0) {
    console.log(`[delivered-pricing] Warnings: ${warnings.join(', ')}`);
  }

  // ========================================================================
  // STRUCTURED LOG LINE (required by pricing fix spec)
  // Shows buyer-facing split, cost estimate separately, and warnings
  // ========================================================================
  console.log(`[delivered-pricing] decision`, JSON.stringify({
    targetDeliveredTotalCents: targetResult.targetCents,
    mode: fullSettings.mode,
    shippingChargeCents: splitResult.shipCents,
    itemPriceCents: splitResult.itemCents,
    shippingCostEstimateCents: effectiveShippingCents, // carrier cost (NOT buyer-facing)
    freeShipApplied: splitResult.freeShipApplied,
    canCompete: splitResult.canCompete,
    warnings,
  }));

  return {
    brand,
    productName,
    ebayComps,
    retailComps,
    activeFloorDeliveredCents: activeFloor,
    activeMedianDeliveredCents: activeMedian,
    amazonPriceCents: effectiveAmazonPriceCents,
    walmartPriceCents: effectiveWalmartPriceCents,
    soldMedianDeliveredCents: soldMedianCents,
    soldCount,
    soldStrong: targetResult.soldStrong,
    mode: fullSettings.mode,
    targetDeliveredCents: targetResult.targetCents,
    finalItemCents: splitResult.itemCents,
    finalShipCents: splitResult.shipCents,
    freeShipApplied: splitResult.freeShipApplied,
    subsidyCents: splitResult.subsidyCents,
    shippingEstimateSource: splitResult.shippingEstimateSource,
    skipListing: splitResult.skipListing,
    canCompete: splitResult.canCompete,
    matchConfidence,
    fallbackUsed: targetResult.fallbackUsed,
    compsSource: finalCompsSource,
    warnings,
  };
}

// ============================================================================
// v2 Pipeline Implementation
// ============================================================================

/**
 * v2 pricing pipeline: percentile-based with identity filtering, safety floors,
 * confidence scoring, and optional eBay Browse API for active comps.
 * 
 * This is called when DP_PRICING_V2=true.
 */
async function getDeliveredPricingV2(
  brand: string,
  productName: string,
  fullSettings: DeliveredPricingSettings,
  additionalContext: string | undefined,
  flags: ReturnType<typeof pricingFlags>
): Promise<DeliveredPricingDecision> {
  const warnings: string[] = [];

  // --- Build product identity ---
  const identity = buildIdentity({ brand, productName });
  console.log(`[pricing-v2] Identity: ${identity.brand} | ${identity.productLine} | size=${identity.size ? `${identity.size.value}${identity.size.unit}` : 'none'} | pack=${identity.packCount}`);

  // === Step 1: Fetch comps from all sources ===

  // 1a. Google Shopping (always — provides retail anchors + eBay comps as fallback)
  const searchResult = await searchGoogleShopping(brand, productName, additionalContext);
  const googleComps = searchResult.allResults.map(googleResultToCompetitor);
  const retailComps = googleComps.filter(c => c.source !== 'ebay');
  let ebayComps = googleComps.filter(c => c.source === 'ebay');

  console.log(`[pricing-v2] Google Shopping: ${ebayComps.length} eBay, ${retailComps.length} retail`);

  // 1b. eBay Browse API for active comps (replaces Google Shopping eBay comps)
  let compsSource: DeliveredPricingDecision['compsSource'] = 'google-shopping';
  let browseComps: EbayCompetitor[] = [];

  if (flags.ebayBrowseActiveEnabled) {
    try {
      const browseResult = await searchEbayComps(brand, productName);
      if (browseResult.ok && browseResult.competitors.length > 0) {
        browseComps = browseResult.competitors;
        compsSource = 'ebay-browse';
        console.log(`[pricing-v2] Browse API: ${browseComps.length} active comps`);
      } else {
        console.log(`[pricing-v2] Browse API: no results, falling back to Google Shopping eBay comps`);
      }
    } catch (err) {
      console.log(`[pricing-v2] Browse API error: ${err} — falling back to Google Shopping`);
      warnings.push('browseApiError');
    }
  }

  // 1c. Sold comps
  let soldSamples: CompSample[] = [];
  let soldMedianCents: number | null = null;
  let soldCount = 0;

  try {
    const soldResult = await fetchSoldPriceStats({ title: productName, brand, condition: 'NEW' });
    if (soldResult.ok && soldResult.samplesCount && soldResult.samples.length > 0) {
      soldSamples = soldResult.samples.map(s => ({
        itemCents: Math.round(s.price * 100),
        shipCents: Math.round(s.shipping * 100),
        deliveredCents: Math.round(s.deliveredPrice * 100),
      }));
      soldCount = soldResult.samplesCount;
      soldMedianCents = soldResult.deliveredMedian
        ? Math.round(soldResult.deliveredMedian * 100)
        : soldResult.median
          ? Math.round(soldResult.median * 100) + fullSettings.shippingEstimateCents
          : null;
      console.log(`[pricing-v2] Sold: ${soldCount} samples, delivered median $${soldMedianCents ? (soldMedianCents / 100).toFixed(2) : 'n/a'}`);
    }
  } catch (err) {
    console.log(`[pricing-v2] Sold comps error: ${err}`);
    warnings.push('soldCompsError');
  }

  // === Step 2: Identity-based comp filtering ===
  let activeCompSamples: CompSample[];

  if (flags.identityFilterEnabled) {
    if (compsSource === 'ebay-browse' && browseComps.length > 0) {
      const candidates = browseToCompCandidates(browseComps);
      const matchResults = matchComps(identity, candidates);
      const matched = filterMatches(matchResults);
      const ambiguous = matchResults.filter(r => r.verdict === 'ambiguous');
      const rejected = matchResults.filter(r => r.verdict === 'reject');
      
      console.log(`[pricing-v2] Active comp filter: ${matched.length} match, ${ambiguous.length} ambiguous, ${rejected.length} reject`);
      
      // Use matches; keep ambiguous for potential LLM disambiguation
      const validResults = flags.matchingLlmEnabled
        ? filterMatchesAndAmbiguous(matchResults) // TODO: actually run LLM on ambiguous
        : matched;
      
      activeCompSamples = validResults.map(r => ({
        itemCents: r.candidate.priceCents,
        shipCents: r.candidate.shippingCents,
        deliveredCents: r.candidate.deliveredCents,
      }));
      
      // Convert back to CompetitorPrice for the decision output
      ebayComps = matchResultsToCompetitors(validResults);
    } else {
      // Filter Google Shopping eBay comps through identity matcher
      const candidates = competitorToCompCandidates(ebayComps);
      const matchResults = matchComps(identity, candidates);
      const matched = flags.matchingLlmEnabled
        ? filterMatchesAndAmbiguous(matchResults)
        : filterMatches(matchResults);

      console.log(`[pricing-v2] GS eBay filter: ${matched.length} of ${ebayComps.length} passed identity filter`);
      
      activeCompSamples = matched.map(r => ({
        itemCents: r.candidate.priceCents,
        shipCents: r.candidate.shippingCents,
        deliveredCents: r.candidate.deliveredCents,
      }));
      ebayComps = matchResultsToCompetitors(matched);
    }

    // Filter sold comps too (if we have samples with titles — but sold samples don't have titles in current model)
    // For now, use all sold samples — identity filtering for sold is handled by ebay-sold-prices.ts title matching
  } else {
    // No identity filtering — use raw eBay comps
    activeCompSamples = toCompSamples(ebayComps);
  }

  // === Step 3: Compute robust stats ===
  const activeStats = activeCompSamples.length > 0
    ? computeRobustStats(activeCompSamples)
    : null;
  const soldStats = soldSamples.length > 0
    ? computeRobustStats(soldSamples)
    : null;

  if (activeStats) {
    console.log(`[pricing-v2] Active stats: ${activeStats.count}/${activeStats.rawCount} (after outlier removal), P20=$${(activeStats.p20 / 100).toFixed(2)}, P35=$${(activeStats.p35 / 100).toFixed(2)}, P50=$${(activeStats.p50 / 100).toFixed(2)}, IQR=$${(activeStats.iqr / 100).toFixed(2)}`);
  }
  if (soldStats) {
    console.log(`[pricing-v2] Sold stats: ${soldStats.count}/${soldStats.rawCount} (after outlier removal), P35=$${(soldStats.p35 / 100).toFixed(2)}, P50=$${(soldStats.p50 / 100).toFixed(2)}, IQR=$${(soldStats.iqr / 100).toFixed(2)}`);
  }

  // === Step 4: Retail anchors ===
  const amazonComp = googleComps.find(c => c.source === 'amazon');
  const walmartComp = googleComps.find(c => c.source === 'walmart');
  const targetComp = googleComps.find(c => c.source === 'target');
  const amazonPriceCents = amazonComp?.deliveredCents ?? null;
  const walmartPriceCents = walmartComp?.deliveredCents ?? null;
  const targetPriceCents = targetComp?.deliveredCents ?? null;
  const brandSitePriceCents = searchResult.brandSitePrice
    ? Math.round(searchResult.brandSitePrice * 100)
    : null;

  const trustedRetailPrices = [brandSitePriceCents, amazonPriceCents, walmartPriceCents, targetPriceCents]
    .filter((p): p is number => p !== null && p > 0);
  const lowestTrustedRetailCents = trustedRetailPrices.length > 0 ? Math.min(...trustedRetailPrices) : null;

  // Brave/API fallbacks for retail (same as legacy)
  let effectiveAmazonPriceCents = amazonPriceCents;
  let effectiveWalmartPriceCents = walmartPriceCents;
  const hasAnyRetailRef = trustedRetailPrices.length > 0 || brandSitePriceCents !== null;

  if (!effectiveAmazonPriceCents && !hasAnyRetailRef) {
    try {
      const braveResult = await braveAmazonFallback(brand, productName);
      if (braveResult.priceCents) {
        effectiveAmazonPriceCents = braveResult.priceCents;
        warnings.push('usedBraveAmazonFallback');
      }
    } catch { /* ignore */ }
  }

  if (!effectiveAmazonPriceCents && !effectiveWalmartPriceCents && !hasAnyRetailRef) {
    try {
      const amazonResult = await searchAmazonWithFallback(brand, productName, true);
      if (amazonResult.price !== null && amazonResult.confidence !== 'low') {
        effectiveAmazonPriceCents = Math.round(amazonResult.price * 100);
        warnings.push('usedDirectAmazonAPI');
      }
    } catch { /* ignore */ }

    if (!effectiveAmazonPriceCents) {
      try {
        const walmartResult = await searchWalmart(brand, productName);
        if (walmartResult.price !== null && walmartResult.confidence !== 'low') {
          effectiveWalmartPriceCents = Math.round(walmartResult.price * 100);
          warnings.push('usedDirectWalmartAPI');
        }
      } catch { /* ignore */ }
    }
  }

  const effectiveRetailPrices = [brandSitePriceCents, effectiveAmazonPriceCents, effectiveWalmartPriceCents, targetPriceCents]
    .filter((p): p is number => p !== null && p > 0);
  const effectiveLowestRetail = effectiveRetailPrices.length > 0 ? Math.min(...effectiveRetailPrices) : null;

  // === Step 5: v2 target selection ===
  const minDeliveredCents = fullSettings.minItemCents + fullSettings.shippingEstimateCents;
  const targetResult = calculateTargetDeliveredV2(
    fullSettings.mode,
    soldStats,
    activeStats,
    effectiveLowestRetail,
    fullSettings.undercutCents,
    minDeliveredCents,
  );
  warnings.push(...targetResult.warnings);

  // Handle no pricing data
  if (targetResult.targetCents === 0) {
    console.log(`[pricing-v2] No pricing data — returning minimum prices`);
    return {
      brand, productName, ebayComps, retailComps,
      activeFloorDeliveredCents: activeStats?.min ?? null,
      activeMedianDeliveredCents: activeStats?.p50 ?? null,
      amazonPriceCents: effectiveAmazonPriceCents,
      walmartPriceCents: effectiveWalmartPriceCents,
      soldMedianDeliveredCents: soldMedianCents,
      soldCount,
      soldStrong: targetResult.soldStrong,
      mode: fullSettings.mode,
      targetDeliveredCents: 0,
      finalItemCents: fullSettings.minItemCents,
      finalShipCents: fullSettings.shippingEstimateCents,
      freeShipApplied: false, subsidyCents: 0,
      shippingEstimateSource: 'fixed',
      skipListing: fullSettings.lowPriceMode === 'AUTO_SKIP',
      canCompete: false,
      matchConfidence: 'low',
      fallbackUsed: true, compsSource: 'fallback',
      warnings,
    };
  }

  // === Step 6: Safety floor enforcement ===
  let finalTargetCents = targetResult.targetCents;

  if (flags.safetyFloorEnabled) {
    const safetyInputs: SafetyFloorInputs = {
      ...DEFAULT_SAFETY_INPUTS,
      shippingCostEstimateCents: fullSettings.shippingEstimateCents,
    };
    const safetyResult = enforceSafetyFloor(finalTargetCents, safetyInputs);

    if (safetyResult.floorWasBinding) {
      console.log(`[pricing-v2] Safety floor: $${(finalTargetCents / 100).toFixed(2)} → $${(safetyResult.minDeliveredCents / 100).toFixed(2)} (uplift ${safetyResult.upliftPercent.toFixed(1)}%)`);
      warnings.push('safetyFloorApplied');
      finalTargetCents = safetyResult.minDeliveredCents;
    }
  }

  console.log(`[pricing-v2] Target delivered: $${(finalTargetCents / 100).toFixed(2)}`);

  // === Step 7: Smart shipping ===
  let effectiveShippingCents = fullSettings.shippingEstimateCents;
  let shippingEstimateSource: DeliveredPricingDecision['shippingEstimateSource'] = 'fixed';

  if (fullSettings.useSmartShipping) {
    const shippingEstimate = getShippingEstimate(
      brand, productName, ebayComps,
      fullSettings.shippingSettings || DEFAULT_SHIPPING_SETTINGS
    );
    effectiveShippingCents = shippingEstimate.cents;
    shippingEstimateSource = shippingEstimate.source;
    console.log(`[pricing-v2] Smart shipping: $${(effectiveShippingCents / 100).toFixed(2)} (${shippingEstimateSource})`);
  }

  const effectiveSettings: DeliveredPricingSettings = { ...fullSettings, shippingEstimateCents: effectiveShippingCents };

  // === Step 8: Split into item + shipping ===
  const splitResult = splitDeliveredPrice(finalTargetCents, effectiveSettings, shippingEstimateSource);
  warnings.push(...splitResult.warnings);

  console.log(`[pricing-v2] Final: item $${(splitResult.itemCents / 100).toFixed(2)} + ship $${(splitResult.shipCents / 100).toFixed(2)}`);

  // === Step 9: Confidence scoring ===
  let matchConfidence: DeliveredPricingDecision['matchConfidence'] = 'low';

  if (flags.confidenceScoringEnabled) {
    const crossSignal = checkCrossSignal(soldStats, activeStats);
    const safetyUplift = flags.safetyFloorEnabled
      ? Math.max(0, ((finalTargetCents - targetResult.targetCents) / Math.max(targetResult.targetCents, 1)) * 100)
      : 0;
    
    const confidenceResult = computeConfidence({
      upcMatch: identity.upc !== null,
      identitySource: identity.upc ? 'upc' : 'structured-attributes',
      soldStats,
      activeStats,
      crossSignalAgreement: crossSignal,
      hasRetailAnchor: effectiveLowestRetail !== null,
      llmConfidenceLow: false, // TODO: wire LLM confidence
      packSizeAmbiguous: false, // TODO: detect from matchResults
      safetyFloorUpliftPercent: safetyUplift,
      shippingGapCents: 0, // TODO: carrier cost - displayed charge
      shippingSubsidyCapCents: fullSettings.freeShippingMaxSubsidyCents,
    });

    console.log(`[pricing-v2] Confidence: ${confidenceResult.score}/100 | hard: [${confidenceResult.hardTriggers.join(', ')}] | soft: [${confidenceResult.softTriggers.join(', ')}]`);

    if (confidenceResult.score >= 60) matchConfidence = 'high';
    else if (confidenceResult.score >= 35) matchConfidence = 'medium';

    if (confidenceResult.requiresManualReview) {
      warnings.push('manualReviewRequired');
      warnings.push(...confidenceResult.hardTriggers);
    }
    if (confidenceResult.softTriggers.length > 0) {
      warnings.push(...confidenceResult.softTriggers);
    }
  } else {
    // Legacy confidence
    if (ebayComps.length >= 5 || targetResult.soldStrong) matchConfidence = 'high';
    else if (ebayComps.length >= 3) matchConfidence = 'medium';
  }

  // === Step 10: Structured log ===
  console.log(`[pricing-v2] decision`, JSON.stringify({
    version: 'v2',
    targetDeliveredTotalCents: finalTargetCents,
    mode: fullSettings.mode,
    shippingChargeCents: splitResult.shipCents,
    itemPriceCents: splitResult.itemCents,
    freeShipApplied: splitResult.freeShipApplied,
    canCompete: splitResult.canCompete,
    soldCount: soldStats?.count ?? 0,
    activeCount: activeStats?.count ?? 0,
    soldP35: soldStats?.p35 ?? null,
    activeP20: activeStats?.p20 ?? null,
    lowestRetail: effectiveLowestRetail,
    compsSource,
    matchConfidence,
    warnings,
  }));

  return {
    brand, productName,
    ebayComps, retailComps,
    activeFloorDeliveredCents: activeStats?.min ?? null,
    activeMedianDeliveredCents: activeStats?.p50 ?? null,
    amazonPriceCents: effectiveAmazonPriceCents,
    walmartPriceCents: effectiveWalmartPriceCents,
    soldMedianDeliveredCents: soldStats?.p50 ?? soldMedianCents,
    soldCount,
    soldStrong: targetResult.soldStrong,
    mode: fullSettings.mode,
    targetDeliveredCents: finalTargetCents,
    finalItemCents: splitResult.itemCents,
    finalShipCents: splitResult.shipCents,
    freeShipApplied: splitResult.freeShipApplied,
    subsidyCents: splitResult.subsidyCents,
    shippingEstimateSource: splitResult.shippingEstimateSource,
    skipListing: splitResult.skipListing,
    canCompete: splitResult.canCompete,
    matchConfidence,
    fallbackUsed: targetResult.fallbackUsed,
    compsSource,
    warnings,
  };
}

/**
 * Create a pricing log entry for storage in Redis
 */
export function createPricingLog(
  decision: DeliveredPricingDecision,
  meta?: { userId?: string; jobId?: string; groupId?: string }
): DeliveredPricingLog {
  return {
    version: '1.0',
    timestamp: new Date().toISOString(),
    userId: meta?.userId,
    jobId: meta?.jobId,
    groupId: meta?.groupId,
    decision,
  };
}

/**
 * Format price in cents to dollars for display
 */
export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Quick pricing for a product - returns just the essential values
 */
export async function quickPrice(
  brand: string,
  productName: string,
  mode: PricingMode = 'market-match'
): Promise<{
  itemPrice: number;      // In dollars
  shippingPrice: number;  // In dollars
  deliveredPrice: number; // In dollars
  confidence: string;
  canCompete: boolean;
  skipListing: boolean;
  freeShipApplied: boolean;
  warnings: string[];
}> {
  const decision = await getDeliveredPricing(brand, productName, { mode });
  
  return {
    itemPrice: decision.finalItemCents / 100,
    shippingPrice: decision.finalShipCents / 100,
    deliveredPrice: (decision.finalItemCents + decision.finalShipCents) / 100,
    confidence: decision.matchConfidence,
    canCompete: decision.canCompete,
    skipListing: decision.skipListing,
    freeShipApplied: decision.freeShipApplied,
    warnings: decision.warnings,
  };
}
