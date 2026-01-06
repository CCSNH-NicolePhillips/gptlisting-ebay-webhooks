/**
 * Delivered-Price-First Pricing Engine (v2)
 * 
 * Prices to delivered-to-door, then backs into item + shipping.
 * Uses Google Shopping for comps (eBay + retail), falls back to sold prices.
 * 
 * IMPORTANT: Shipping Handling
 * ============================
 * This engine calculates a TARGET DELIVERED PRICE (what buyer pays total).
 * 
 * How shipping is handled depends on your eBay fulfillment policy:
 * 
 * 1. FREE SHIPPING POLICY (ebayHandlesShipping: false, freeShipApplied: true)
 *    - Item price = full delivered price (shipping baked into item)
 *    - eBay shows $0 shipping to buyer
 *    - Seller absorbs shipping cost
 * 
 * 2. CALCULATED/FLAT SHIPPING POLICY (ebayHandlesShipping: true)
 *    - Item price = delivered price - estimated shipping
 *    - eBay adds shipping on top based on buyer location/weight
 *    - ⚠️ Risk: If our shipping estimate doesn't match eBay's, total may differ
 * 
 * 3. SIMPLE MODE (ebayHandlesShipping: true, skipShippingSplit: true) - RECOMMENDED
 *    - Item price = target delivered price (no split)
 *    - eBay adds shipping on top
 *    - Total to buyer = itemPrice + eBay shipping
 *    - This is the simplest and most predictable mode
 * 
 * Set ebayHandlesShipping: true in settings if your fulfillment policy charges
 * shipping separately (calculated or flat rate). This avoids double-charging.
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
  
  // DISABLED: Retail cap was causing bad prices when Google Shopping returned wrong products
  // TODO: Re-enable once title matching is improved
  // if (retailCapCents !== null && targetCents > retailCapCents) {
  //   console.log(`[delivered-pricing] Applying retail cap: $${(targetCents / 100).toFixed(2)} → $${(retailCapCents / 100).toFixed(2)}`);
  //   warnings.push('retailCapApplied');
  //   targetCents = retailCapCents;
  // }

  return { targetCents, fallbackUsed, soldStrong, warnings };
}

/**
 * Split delivered price into item + shipping
 * 
 * Core logic:
 * 1. Try normal split: target - shipping = item
 * 2. If item < min, try free shipping (if enabled and within subsidy cap)
 * 3. If still can't compete, flag or skip based on lowPriceMode
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
  const shipping = settings.shippingEstimateCents;
  const minItem = settings.minItemCents;
  
  // Calculate what item price would be with normal shipping
  const naiveItemCents = targetDeliveredCents - shipping;
  
  // Case 1: Normal split works (item >= min)
  if (naiveItemCents >= minItem) {
    return {
      itemCents: naiveItemCents,
      shipCents: shipping,
      subsidyCents: 0,
      freeShipApplied: false,
      canCompete: true,
      skipListing: false,
      shippingEstimateSource,
      warnings,
    };
  }
  
  // Case 2: Need free shipping to hit target
  // Can we absorb shipping cost and still have item >= min?
  if (settings.allowFreeShippingWhenNeeded) {
    const subsidyNeeded = shipping; // Full shipping absorbed
    
    // With free shipping, item price = target delivered
    const freeShipItemCents = targetDeliveredCents;
    
    // Check: can we afford the subsidy AND is item price valid?
    if (subsidyNeeded <= settings.freeShippingMaxSubsidyCents && freeShipItemCents >= minItem) {
      return {
        itemCents: freeShipItemCents,
        shipCents: 0,
        subsidyCents: subsidyNeeded,
        freeShipApplied: true,
        canCompete: true,
        skipListing: false,
        shippingEstimateSource,
        warnings,
      };
    }
    
    // Free shipping helps but subsidy exceeds cap
    if (freeShipItemCents >= minItem && subsidyNeeded > settings.freeShippingMaxSubsidyCents) {
      warnings.push('subsidyExceedsCap');
      // Fall through to cannot compete
    }
  }
  
  // Case 3: Cannot compete - market price is below our floor
  warnings.push('cannotCompete');
  
  // Determine skip behavior based on lowPriceMode
  const skipListing = settings.lowPriceMode === 'AUTO_SKIP';
  const canCompete = false;
  
  // Return our minimum viable price (will be overpriced vs market)
  // Use free shipping if enabled to at least get closer
  if (settings.allowFreeShippingWhenNeeded && shipping <= settings.freeShippingMaxSubsidyCents) {
    return {
      itemCents: minItem,
      shipCents: 0,
      subsidyCents: shipping,
      freeShipApplied: true,
      canCompete,
      skipListing,
      shippingEstimateSource,
      warnings,
    };
  }
  
  // No free shipping - return min item + shipping (overpriced)
  return {
    itemCents: minItem,
    shipCents: shipping,
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
