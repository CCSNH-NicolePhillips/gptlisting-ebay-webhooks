/**
 * eBay Price Splitting Strategy - Phase 4
 * 
 * PURPOSE: Pure function to split eBay target total into item price and shipping cost
 * based on Amazon shipping and configured strategy
 * 
 * DESIGN PRINCIPLES:
 * - Pure function (no network, no env vars, no side effects)
 * - Never returns negative item price
 * - Evidence explains what happened (debugging/transparency)
 * - Not wired into production pipeline yet (Phase 4 is logic only)
 */

import type { CompetitivePricingRules } from './pricing-config.js';

/**
 * Result of splitting eBay target total into item and shipping components
 */
export interface EbayPriceSplit {
  /**
   * eBay item price (before shipping)
   * Guaranteed to be >= 0
   */
  ebayItemPrice: number;
  
  /**
   * eBay shipping cost charged to buyer
   * May be 0 (free shipping) or positive
   */
  ebayShippingPrice: number;
  
  /**
   * Evidence array explaining how the split was calculated
   * Useful for debugging and transparency
   */
  evidence: string[];
}

/**
 * Split eBay target total into item price and shipping cost
 * 
 * STRATEGIES:
 * 
 * FREE_IF_AMAZON_FREE:
 * - If Amazon has free shipping → eBay has free shipping
 * - If Amazon charges shipping → eBay matches that shipping cost
 * 
 * MATCH_AMAZON:
 * - Always match Amazon's shipping cost exactly
 * - Item price adjusted to hit target total
 * 
 * SELLER_PAYS_UP_TO:
 * - Seller absorbs shipping up to threshold (sellerPaysUpTo)
 * - Buyer pays remainder if shipping exceeds threshold
 * 
 * GUARDRAIL:
 * - If neverExceedAmazonTotal = true, ensures eBay total <= Amazon total
 * 
 * @param input - Pricing split input parameters
 * @param input.ebayTargetTotal - Target total price for eBay (item + shipping)
 * @param input.amazonShippingPrice - Amazon's shipping cost (0 if free)
 * @param input.rules - Competitive pricing configuration
 * @param input.amazonTotal - Optional Amazon total for neverExceedAmazonTotal validation
 * @returns Object with ebayItemPrice, ebayShippingPrice, and evidence
 * 
 * @example
 * // FREE_IF_AMAZON_FREE with free shipping
 * splitEbayPrice({
 *   ebayTargetTotal: 15.29,
 *   amazonShippingPrice: 0,
 *   rules: { shippingStrategy: 'FREE_IF_AMAZON_FREE', discountPercent: 10, neverExceedAmazonTotal: true }
 * })
 * // Returns: { ebayItemPrice: 15.29, ebayShippingPrice: 0, evidence: [...] }
 * 
 * @example
 * // FREE_IF_AMAZON_FREE with paid shipping
 * splitEbayPrice({
 *   ebayTargetTotal: 20.68,
 *   amazonShippingPrice: 5.99,
 *   rules: { shippingStrategy: 'FREE_IF_AMAZON_FREE', discountPercent: 10, neverExceedAmazonTotal: true }
 * })
 * // Returns: { ebayItemPrice: 14.69, ebayShippingPrice: 5.99, evidence: [...] }
 */
export function splitEbayPrice(input: {
  ebayTargetTotal: number;
  amazonShippingPrice: number;
  rules: CompetitivePricingRules;
  amazonTotal?: number;
}): EbayPriceSplit {
  const { ebayTargetTotal, amazonShippingPrice, rules, amazonTotal } = input;
  const evidence: string[] = [];
  
  let ebayShippingPrice: number;
  let ebayItemPrice: number;
  
  // Apply strategy
  switch (rules.shippingStrategy) {
    case 'FREE_IF_AMAZON_FREE': {
      if (amazonShippingPrice === 0) {
        // Amazon has free shipping → eBay has free shipping
        ebayShippingPrice = 0;
        ebayItemPrice = ebayTargetTotal;
        evidence.push('Strategy: FREE_IF_AMAZON_FREE');
        evidence.push('Amazon has free shipping → eBay offers free shipping');
        evidence.push(`eBay item price = target total ($${ebayTargetTotal.toFixed(2)})`);
      } else {
        // Amazon charges shipping → eBay matches that shipping
        ebayShippingPrice = amazonShippingPrice;
        ebayItemPrice = Math.max(0, ebayTargetTotal - ebayShippingPrice);
        evidence.push('Strategy: FREE_IF_AMAZON_FREE');
        evidence.push(`Amazon charges $${amazonShippingPrice.toFixed(2)} shipping → eBay matches`);
        evidence.push(`eBay item price = $${ebayTargetTotal.toFixed(2)} - $${ebayShippingPrice.toFixed(2)} = $${ebayItemPrice.toFixed(2)}`);
      }
      break;
    }
    
    case 'MATCH_AMAZON': {
      // Always match Amazon's shipping cost
      ebayShippingPrice = amazonShippingPrice;
      ebayItemPrice = Math.max(0, ebayTargetTotal - ebayShippingPrice);
      evidence.push('Strategy: MATCH_AMAZON');
      evidence.push(`eBay shipping = Amazon shipping ($${amazonShippingPrice.toFixed(2)})`);
      evidence.push(`eBay item price = $${ebayTargetTotal.toFixed(2)} - $${ebayShippingPrice.toFixed(2)} = $${ebayItemPrice.toFixed(2)}`);
      break;
    }
    
    case 'SELLER_PAYS_UP_TO': {
      // Seller absorbs shipping up to threshold (threshold is in cents)
      const thresholdCents = rules.sellerPaysUpTo || 0;
      const thresholdDollars = thresholdCents / 100;
      ebayShippingPrice = Math.max(0, amazonShippingPrice - thresholdDollars);
      ebayItemPrice = Math.max(0, ebayTargetTotal - ebayShippingPrice);
      evidence.push('Strategy: SELLER_PAYS_UP_TO');
      evidence.push(`Seller absorbs up to $${thresholdDollars.toFixed(2)} of shipping`);
      evidence.push(`Amazon shipping: $${amazonShippingPrice.toFixed(2)}, Threshold: $${thresholdDollars.toFixed(2)}`);
      evidence.push(`eBay shipping = max(0, $${amazonShippingPrice.toFixed(2)} - $${thresholdDollars.toFixed(2)}) = $${ebayShippingPrice.toFixed(2)}`);
      evidence.push(`eBay item price = $${ebayTargetTotal.toFixed(2)} - $${ebayShippingPrice.toFixed(2)} = $${ebayItemPrice.toFixed(2)}`);
      break;
    }
    
    default: {
      // Should never happen due to TypeScript type checking, but provide fallback
      evidence.push(`Unknown strategy: ${rules.shippingStrategy as string}`);
      ebayShippingPrice = 0;
      ebayItemPrice = ebayTargetTotal;
    }
  }
  
  // Apply guardrail: neverExceedAmazonTotal
  if (rules.neverExceedAmazonTotal && amazonTotal !== undefined) {
    const ebayTotal = ebayItemPrice + ebayShippingPrice;
    
    if (ebayTotal > amazonTotal) {
      const excess = ebayTotal - amazonTotal;
      evidence.push(`⚠️  Guardrail: eBay total ($${ebayTotal.toFixed(2)}) exceeds Amazon total ($${amazonTotal.toFixed(2)}) by $${excess.toFixed(2)}`);
      
      // Adjust to not exceed Amazon total
      // Reduce item price first, keeping shipping as-is
      const maxItemPrice = Math.max(0, amazonTotal - ebayShippingPrice);
      if (maxItemPrice !== ebayItemPrice) {
        evidence.push(`Reducing eBay item price from $${ebayItemPrice.toFixed(2)} to $${maxItemPrice.toFixed(2)}`);
        ebayItemPrice = maxItemPrice;
      }
      
      // If still exceeds (shipping alone > amazonTotal), reduce shipping too
      const newTotal = ebayItemPrice + ebayShippingPrice;
      if (newTotal > amazonTotal) {
        const maxShipping = Math.max(0, amazonTotal - ebayItemPrice);
        evidence.push(`Reducing eBay shipping from $${ebayShippingPrice.toFixed(2)} to $${maxShipping.toFixed(2)}`);
        ebayShippingPrice = maxShipping;
      }
      
      evidence.push(`Final eBay total: $${(ebayItemPrice + ebayShippingPrice).toFixed(2)} (within Amazon total)`);
    } else {
      evidence.push(`✓ Guardrail passed: eBay total ($${ebayTotal.toFixed(2)}) <= Amazon total ($${amazonTotal.toFixed(2)})`);
    }
  }
  
  // Final safety check: ensure item price is non-negative
  if (ebayItemPrice < 0) {
    evidence.push(`⚠️  Safety check: Item price was negative ($${ebayItemPrice.toFixed(2)}), clamping to $0.00`);
    ebayItemPrice = 0;
  }
  
  // Round to cents for final output
  ebayItemPrice = Math.round(ebayItemPrice * 100) / 100;
  ebayShippingPrice = Math.round(ebayShippingPrice * 100) / 100;
  
  return {
    ebayItemPrice,
    ebayShippingPrice,
    evidence,
  };
}
