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
  retailComps: CompetitorPrice[] = []
): { targetCents: number; fallbackUsed: boolean; soldStrong: boolean; warnings: string[] } {
  const warnings: string[] = [];
  let fallbackUsed = false;
  let targetCents: number;
  
  // Sold data is "strong" if we have 5+ samples
  const soldStrong = soldMedian !== null && soldCount >= 5;
  
  if (soldStrong) {
    console.log(`[delivered-pricing] Sold data is STRONG (${soldCount} samples, median $${(soldMedian! / 100).toFixed(2)})`);
  } else if (soldMedian !== null) {
    console.log(`[delivered-pricing] Sold data is weak (${soldCount} samples) - ignoring`);
  }
  
  // Calculate the retail cap - never price above 80% of best retail
  const retailPrices = [
    amazonPrice,
    walmartPrice,
    ...retailComps.filter(c => c.inStock).map(c => c.deliveredCents)
  ].filter((p): p is number => p !== null && p > 0);
  
  const lowestRetailCents = retailPrices.length > 0 ? Math.min(...retailPrices) : null;
  const retailCapCents = lowestRetailCents !== null 
    ? Math.round(lowestRetailCents * RETAIL_CAP_RATIO)
    : null;
  
  if (retailCapCents !== null) {
    console.log(`[delivered-pricing] Retail cap: $${(retailCapCents / 100).toFixed(2)} (80% of lowest retail $${(lowestRetailCents! / 100).toFixed(2)})`);
  }

  // Try eBay comps first
  if (activeFloor !== null) {
    switch (mode) {
      case 'market-match':
        // Phase 3: Use min(soldMedian, activeFloor) when sold data is strong
        if (soldStrong) {
          targetCents = Math.min(soldMedian!, activeFloor);
          if (soldMedian! < activeFloor) {
            console.log(`[delivered-pricing] Sold median ($${(soldMedian! / 100).toFixed(2)}) < active floor ($${(activeFloor / 100).toFixed(2)}) - using sold`);
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
      // Price at 60% of retail (competitive with eBay sellers)
      targetCents = Math.round(retailPrice * 0.60);
      warnings.push('usingRetailFallback');
      console.log(`[delivered-pricing] Using retail fallback: $${(retailPrice / 100).toFixed(2)} → target $${(targetCents / 100).toFixed(2)} (60%)`);
    } else {
      // No pricing data at all
      targetCents = 0;
      warnings.push('noPricingData');
    }
  }
  
  // Apply retail cap - never price above 80% of best retail price
  // This ensures we stay competitive with Amazon/Walmart/brand sites
  // Note: This was previously disabled due to title matching issues, but those are now fixed
  if (retailCapCents !== null && targetCents > retailCapCents) {
    console.log(`[delivered-pricing] Applying retail cap: $${(targetCents / 100).toFixed(2)} → $${(retailCapCents / 100).toFixed(2)}`);
    warnings.push('retailCapApplied');
    targetCents = retailCapCents;
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
// Main Function
// ============================================================================

/**
 * Get delivered-price-first competitive pricing for a product
 * 
 * This is the main entry point for the v2 pricing engine.
 * Uses Google Shopping to find eBay and retail comps, then calculates
 * the optimal price based on the selected mode.
 * 
 * @param brand - Product brand
 * @param productName - Product name with size/count
 * @param settings - Pricing settings (optional, uses defaults)
 * @returns DeliveredPricingDecision with final item/ship prices and evidence
 */
export async function getDeliveredPricing(
  brand: string,
  productName: string,
  settings: Partial<DeliveredPricingSettings> = {}
): Promise<DeliveredPricingDecision> {
  const fullSettings: DeliveredPricingSettings = { ...DEFAULT_PRICING_SETTINGS, ...settings };
  const warnings: string[] = [];

  console.log(`[delivered-pricing] Pricing "${brand} ${productName}" in ${fullSettings.mode} mode`);

  // === Step 1: Search Google Shopping for all comps ===
  // Note: eBay Browse API is unreliable/deprecated, so we use Google Shopping
  // which indexes eBay listings along with Amazon, Walmart, etc.
  const searchResult = await searchGoogleShopping(brand, productName);
  
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

  // Get retail prices
  const amazonComp = allComps.find(c => c.source === 'amazon');
  const walmartComp = allComps.find(c => c.source === 'walmart');
  const amazonPriceCents = amazonComp?.deliveredCents ?? null;
  const walmartPriceCents = walmartComp?.deliveredCents ?? null;

  if (amazonPriceCents) {
    console.log(`[delivered-pricing] Amazon: $${(amazonPriceCents / 100).toFixed(2)} delivered`);
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

  // Calculate target delivered price
  const minDeliveredCents = fullSettings.minItemCents + fullSettings.shippingEstimateCents;
  const targetResult = calculateTargetDelivered(
    fullSettings.mode,
    activeFloor,
    activeMedian,
    soldMedianCents,
    soldCount,
    amazonPriceCents,
    walmartPriceCents,
    fullSettings.undercutCents,
    minDeliveredCents,
    retailComps
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
      amazonPriceCents,
      walmartPriceCents,
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

  // Determine confidence based on comp count
  let matchConfidence: 'high' | 'medium' | 'low' = 'low';
  if (ebayComps.length >= 5) {
    matchConfidence = 'high';
  } else if (ebayComps.length >= 3 || (ebayComps.length >= 1 && retailComps.length >= 2)) {
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
    amazonPriceCents,
    walmartPriceCents,
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
