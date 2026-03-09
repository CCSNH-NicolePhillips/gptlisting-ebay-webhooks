/**
 * Legacy pricing compute helpers — config-dependent pricing functions.
 *
 * These functions depend on PricingSettings from pricing-config.ts and are
 * used by the taxonomy-map pipeline and the legacy retail-discount path in
 * pricing/index.ts.
 *
 * Previously these lived in src/lib/pricing-compute.ts (now a deprecated
 * re-export stub).  Prefer importing from here for new code that needs these
 * helpers directly.
 *
 * For the unified pricing entrypoint used by Netlify functions, see index.ts.
 */

import type { PricingSettings, ShippingStrategy, EbayShippingMode } from '../../../../src/lib/pricing-config.js';
import { getDefaultPricingSettings, normalizePricingSettings } from '../../../../src/lib/pricing-config.js';
import { computeEbayItemPrice } from './ebay-price-math.js';

// ── getCategoryCap ────────────────────────────────────────────────────────────

/**
 * Get category-specific price cap to prevent unrealistic pricing.
 * Returns undefined if no cap applies (most categories).
 */
export function getCategoryCap(categoryPath?: string): number | undefined {
  const lower = (categoryPath || '').toLowerCase();
  if (lower.includes('book')) return 35;
  if (lower.includes('dvd') || lower.includes('movie') || lower.includes('music')) return 25;
  return undefined;
}

// ── computeEbayItemPriceCents ─────────────────────────────────────────────────

export interface ComputeEbayItemPriceCentsEvidence {
  amazonDeliveredTotalCents: number;
  discountPercent: number;
  shippingStrategy: string;
  templateShippingEstimateCents: number;
  shippingSubsidyAppliedCents: number;
  minItemPriceCents: number;
}

export interface ComputeEbayItemPriceCentsResult {
  ebayItemPriceCents: number;
  targetDeliveredTotalCents: number;
  evidence: ComputeEbayItemPriceCentsEvidence;
}

/**
 * Compute eBay item price from Amazon pricing + PricingSettings.
 * Phase 2 variant — all values in cents.
 */
export function computeEbayItemPriceCents(args: {
  amazonItemPriceCents: number;
  amazonShippingCents: number;
  settings: PricingSettings;
}): ComputeEbayItemPriceCentsResult {
  const { amazonItemPriceCents, amazonShippingCents, settings: rawSettings } = args;
  const settings = normalizePricingSettings(rawSettings);

  const amazonDeliveredTotalCents = amazonItemPriceCents + amazonShippingCents;
  const discountMultiplier = 1 - settings.discountPercent / 100;
  const targetDeliveredTotalCents = Math.round(amazonDeliveredTotalCents * discountMultiplier);

  let ebayItemPriceCents: number;
  let shippingSubsidyAppliedCents: number;

  if (settings.shippingStrategy === 'ALGO_COMPETITIVE_TOTAL') {
    let subsidy = settings.templateShippingEstimateCents;
    if (settings.shippingSubsidyCapCents !== null) {
      subsidy = Math.min(subsidy, settings.shippingSubsidyCapCents);
    }
    shippingSubsidyAppliedCents = subsidy;
    ebayItemPriceCents = targetDeliveredTotalCents - subsidy;
  } else {
    ebayItemPriceCents = Math.round(amazonItemPriceCents * discountMultiplier);
    shippingSubsidyAppliedCents = 0;
  }

  if (ebayItemPriceCents < settings.minItemPriceCents) {
    ebayItemPriceCents = settings.minItemPriceCents;
  }

  return {
    ebayItemPriceCents,
    targetDeliveredTotalCents,
    evidence: {
      amazonDeliveredTotalCents,
      discountPercent: settings.discountPercent,
      shippingStrategy: settings.shippingStrategy,
      templateShippingEstimateCents: settings.templateShippingEstimateCents,
      shippingSubsidyAppliedCents,
      minItemPriceCents: settings.minItemPriceCents,
    },
  };
}

// ── getFinalEbayPrice ─────────────────────────────────────────────────────────

/**
 * Convert a retail/MSRP price (dollars) to a final eBay listing price (dollars).
 *
 * @deprecated Prefer {@link getPricingDecision} from `src/lib/pricing/index.ts`
 *             which handles DELIVERED_PRICING_V2 routing and fallback logic.
 *             This function is still used for the legacy path inside index.ts.
 */
export function getFinalEbayPrice(
  basePriceDollars: number,
  options?: {
    categoryCap?: number;
    settings?: PricingSettings;
  },
): number {
  if (!isFinite(basePriceDollars) || basePriceDollars <= 0) return 0;

  let cappedPrice = basePriceDollars;
  if (options?.categoryCap && basePriceDollars > options.categoryCap) {
    cappedPrice = options.categoryCap;
  }

  const settings = normalizePricingSettings(options?.settings ?? getDefaultPricingSettings());

  const result = computeEbayItemPrice({
    amazonItemPriceCents: Math.round(cappedPrice * 100),
    amazonShippingCents: 0,
    discountPercent: settings.discountPercent,
    shippingStrategy: settings.shippingStrategy,
    templateShippingEstimateCents: settings.templateShippingEstimateCents,
    shippingSubsidyCapCents: settings.shippingSubsidyCapCents,
    minItemPriceCents: settings.minItemPriceCents,
  });

  return result.ebayItemPriceCents / 100;
}

// ── computeEbayOfferPricingCents ──────────────────────────────────────────────

export interface EbayOfferPricingResult {
  targetDeliveredTotalCents: number;
  itemPriceCents: number;
  shippingChargeCents: number;
  shippingCostEstimateCents: number;
  effectiveShippingMode: EbayShippingMode;
  warnings: string[];
  evidence: EbayOfferPricingEvidence;
}

export interface EbayOfferPricingEvidence {
  baseDeliveredTargetCents: number;
  shippingCostEstimateCents: number;
  requestedShippingMode: EbayShippingMode;
  effectiveShippingMode: EbayShippingMode;
  buyerShippingChargeCents: number;
  itemPriceCents: number;
  targetDeliveredTotalCents: number;
  minItemPriceCents: number;
  autoFreeShippingTriggered: boolean;
  warnings: string[];
}

/**
 * Compute final eBay offer pricing (item price + shipping charge split).
 *
 * INVARIANT: itemPriceCents + shippingChargeCents === targetDeliveredTotalCents
 */
export function computeEbayOfferPricingCents(input: {
  baseDeliveredTargetCents: number;
  shippingCostEstimateCents: number;
  settings: PricingSettings;
}): EbayOfferPricingResult {
  const { baseDeliveredTargetCents, shippingCostEstimateCents, settings: rawSettings } = input;
  const settings = normalizePricingSettings(rawSettings);
  const warnings: string[] = [];

  let targetDeliveredTotalCents = baseDeliveredTargetCents;
  let itemPriceCents: number;
  let shippingChargeCents: number;
  let effectiveShippingMode: EbayShippingMode = settings.ebayShippingMode;
  let autoFreeShippingTriggered = false;

  if (effectiveShippingMode === 'FREE_SHIPPING') {
    shippingChargeCents = 0;
    itemPriceCents = targetDeliveredTotalCents;
  } else {
    shippingChargeCents = settings.buyerShippingChargeCents;
    itemPriceCents = targetDeliveredTotalCents - shippingChargeCents;
  }

  if (itemPriceCents < settings.minItemPriceCents) {
    if (settings.allowAutoFreeShippingOnLowPrice && effectiveShippingMode === 'BUYER_PAYS_SHIPPING') {
      effectiveShippingMode = 'FREE_SHIPPING';
      shippingChargeCents = 0;
      itemPriceCents = baseDeliveredTargetCents;
      autoFreeShippingTriggered = true;
      warnings.push('autoSwitchedToFreeShipping');
      if (itemPriceCents < settings.minItemPriceCents) {
        itemPriceCents = settings.minItemPriceCents;
        warnings.push('minItemFloorHit');
      }
      targetDeliveredTotalCents = itemPriceCents + shippingChargeCents;
    } else {
      itemPriceCents = settings.minItemPriceCents;
      warnings.push('minItemFloorHit');
      warnings.push('cannotCompete');
      targetDeliveredTotalCents = itemPriceCents + shippingChargeCents;
    }
  }

  if (itemPriceCents < 0) { itemPriceCents = 0; warnings.push('negativePriceClamped'); }
  if (shippingChargeCents < 0) { shippingChargeCents = 0; warnings.push('negativeShippingClamped'); }

  const evidence: EbayOfferPricingEvidence = {
    baseDeliveredTargetCents,
    shippingCostEstimateCents,
    requestedShippingMode: settings.ebayShippingMode,
    effectiveShippingMode,
    buyerShippingChargeCents: settings.buyerShippingChargeCents,
    itemPriceCents,
    targetDeliveredTotalCents,
    minItemPriceCents: settings.minItemPriceCents,
    autoFreeShippingTriggered,
    warnings: [...warnings],
  };

  return {
    targetDeliveredTotalCents,
    itemPriceCents,
    shippingChargeCents,
    shippingCostEstimateCents,
    effectiveShippingMode,
    warnings,
    evidence,
  };
}

// ── formatPricingLogLine ──────────────────────────────────────────────────────

/**
 * Format an EbayOfferPricingResult as a single log line for debugging.
 */
export function formatPricingLogLine(result: EbayOfferPricingResult): string {
  const mode = result.effectiveShippingMode === 'FREE_SHIPPING' ? 'FREE' : 'BUYER_PAYS';
  const warnStr = result.warnings.length > 0 ? result.warnings.join(',') : 'none';
  return (
    `[pricing] deliveredTarget=$${(result.targetDeliveredTotalCents / 100).toFixed(2)} ` +
    `mode=${mode} ` +
    `shippingCharge=$${(result.shippingChargeCents / 100).toFixed(2)} ` +
    `item=$${(result.itemPriceCents / 100).toFixed(2)} ` +
    `shipCostEst=$${(result.shippingCostEstimateCents / 100).toFixed(2)} ` +
    `warnings=[${warnStr}]`
  );
}
