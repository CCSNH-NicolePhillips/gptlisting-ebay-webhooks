/**
 * Competitive Pricing Integration - Phase 5
 * 
 * PURPOSE: Wire Phase 1-4 components into production pipeline behind feature flag
 * 
 * DESIGN PRINCIPLES:
 * - Feature flag controls old vs new behavior
 * - With flag OFF: baseline regression tests unchanged
 * - With flag ON: new competitive pricing applies
 * - Evidence logged (but not spammy)
 * - Clean integration point for existing code
 */

import { extractPriceWithShipping } from './html-price.js';
import { computeAmazonTotals } from './pricing-compute.js';
import { splitEbayPrice } from './pricing-split.js';
import { getDefaultCompetitivePricingRules } from './pricing-config.js';
import type { CompetitivePricingRules } from './pricing-config.js';

/**
 * Feature flag for competitive pricing v2
 * Set DP_COMPETITIVE_PRICING_V2=true to enable new pricing logic
 */
export function isCompetitivePricingEnabled(): boolean {
  return process.env.DP_COMPETITIVE_PRICING_V2 === 'true';
}

/**
 * Result from competitive pricing calculation
 */
export interface CompetitivePricingResult {
  /**
   * eBay item price (before shipping)
   */
  ebayItemPrice: number;

  /**
   * eBay shipping cost (0 for free shipping)
   */
  ebayShippingPrice: number;

  /**
   * Evidence array explaining pricing decisions
   */
  evidence: string[];

  /**
   * Amazon data used in calculation
   */
  amazonData: {
    itemPrice: number;
    shippingPrice: number;
    totalPrice: number;
    shippingEvidence: 'free' | 'paid' | 'unknown';
  };
}

/**
 * Calculate competitive eBay pricing from Amazon HTML
 * 
 * This is the main integration point for the competitive pricing feature.
 * 
 * @param amazonHtml - HTML content from Amazon product page
 * @param productTitle - Product title for price extraction
 * @param rules - Optional pricing rules (uses defaults if not provided)
 * @returns Competitive pricing result with item price, shipping, and evidence
 * 
 * @example
 * const result = calculateCompetitivePricing(html, 'Nature Made Vitamin D3');
 * console.log(`Item: $${result.ebayItemPrice}, Shipping: $${result.ebayShippingPrice}`);
 * console.log('Evidence:', result.evidence);
 */
export function calculateCompetitivePricing(
  amazonHtml: string,
  productTitle?: string,
  rules?: CompetitivePricingRules
): CompetitivePricingResult | null {
  // Use default rules if not provided
  const pricingRules = rules || getDefaultCompetitivePricingRules();

  // Step 1: Extract Amazon price and shipping from HTML
  const priceData = extractPriceWithShipping(amazonHtml, productTitle);
  
  if (priceData.amazonItemPrice === null) {
    // Could not extract price from HTML
    return null;
  }

  // Step 2: Compute Amazon total and eBay target total
  const { amazonTotal, ebayTargetTotal } = computeAmazonTotals({
    amazonItemPrice: priceData.amazonItemPrice,
    amazonShippingPrice: priceData.amazonShippingPrice,
    discountPercent: pricingRules.discountPercent,
  });

  // Step 3: Split eBay target into item price and shipping
  const splitResult = splitEbayPrice({
    ebayTargetTotal,
    amazonShippingPrice: priceData.amazonShippingPrice,
    rules: pricingRules,
    amazonTotal,
  });

  // Combine evidence
  const evidence: string[] = [
    `Amazon: $${priceData.amazonItemPrice.toFixed(2)} + $${priceData.amazonShippingPrice.toFixed(2)} shipping (${priceData.shippingEvidence})`,
    `Amazon total: $${amazonTotal.toFixed(2)}`,
    `eBay target (${pricingRules.discountPercent}% discount): $${ebayTargetTotal.toFixed(2)}`,
    ...splitResult.evidence,
  ];

  return {
    ebayItemPrice: splitResult.ebayItemPrice,
    ebayShippingPrice: splitResult.ebayShippingPrice,
    evidence,
    amazonData: {
      itemPrice: priceData.amazonItemPrice,
      shippingPrice: priceData.amazonShippingPrice,
      totalPrice: amazonTotal,
      shippingEvidence: priceData.shippingEvidence,
    },
  };
}

/**
 * Calculate eBay price with feature flag support
 * 
 * - With flag OFF: Uses legacy computeEbayPrice formula (base × 0.9 - $5 if > $30)
 * - With flag ON: Uses new competitive pricing from Amazon HTML
 * 
 * This function provides a clean migration path from old to new pricing.
 * 
 * @param basePrice - Amazon item price (legacy mode only)
 * @param amazonHtml - Amazon HTML (competitive mode only)
 * @param productTitle - Product title (competitive mode only)
 * @param rules - Pricing rules (competitive mode only)
 * @returns eBay item price (legacy returns single price, competitive returns object)
 */
export function calculateEbayPriceWithFlag(input: {
  basePrice?: number;
  amazonHtml?: string;
  productTitle?: string;
  rules?: CompetitivePricingRules;
}): CompetitivePricingResult | { ebayItemPrice: number; ebayShippingPrice: number } {
  if (isCompetitivePricingEnabled() && input.amazonHtml) {
    // New competitive pricing mode
    const result = calculateCompetitivePricing(
      input.amazonHtml,
      input.productTitle,
      input.rules
    );
    
    if (result) {
      // Log evidence once at info level (not spammy)
      if (result.evidence.length > 0) {
        console.log('[competitive-pricing] Evidence:', result.evidence.slice(0, 3).join('; '));
      }
      return result;
    }
    
    // Fallback to legacy if competitive pricing fails
    console.log('[competitive-pricing] Failed to extract competitive pricing, falling back to legacy');
  }

  // Legacy pricing mode (or fallback)
  const base = input.basePrice || 0;
  if (!isFinite(base) || base <= 0) {
    return { ebayItemPrice: 0, ebayShippingPrice: 0 };
  }
  
  let price = base * 0.9; // 10% off
  if (base > 30) price -= 5;
  const ebayItemPrice = Math.round(price * 100) / 100;
  
  return { ebayItemPrice, ebayShippingPrice: 0 };
}
