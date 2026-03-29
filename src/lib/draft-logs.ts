/**
 * Draft Logs Storage
 * 
 * Stores pricing decisions, AI reasoning, and calculation breakdowns
 * with each draft for debugging and transparency.
 * 
 * Logs are stored in Redis with 7-day TTL.
 */

import { redisCall } from './job-store.js';

// TTL for draft logs - 7 days
const DRAFT_LOGS_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface VisionAnalysisLog {
  timestamp: string;
  model: string;
  brand?: string;
  productName?: string;
  reasoning: string;
  confidence?: number;
  rawResponse?: string;
}

/**
 * Full vision classification result stored per draft.
 * Captures everything Vision API extracted from the product images.
 */
export interface VisionClassificationLog {
  brand: string;
  productName: string;
  variant?: string | null;
  size?: string | null;
  packageType?: string | null;
  keyText?: string[];
  netWeight?: { value: number; unit: string } | null;
  categoryPath?: string;
  photoQuantity?: number;
  bundleInfo?: {
    isBundle: boolean;
    bundleType: string | null;
    bundleProducts: string[];
  } | null;
  servingCount?: number | null;
}

export interface PricingSourceLog {
  source: string;
  query: string;
  results: Array<{
    title: string;
    price: number;
    shipping: number;
    total: number;
    url?: string;
    seller?: string;
    matchConfidence?: string;
  }>;
  selectedResult?: {
    title: string;
    price: number;
    reason: string;
  };
}

export interface PricingCalculationLog {
  step: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  formula?: string;
  notes?: string;
}

export interface PricingDecisionLog {
  timestamp: string;
  brand: string;
  productName: string;
  
  // Sources searched
  sources: PricingSourceLog[];
  
  // Final decision
  finalPrice: number;
  finalShipping: number;
  freeShippingApplied: boolean;
  
  // Calculation breakdown
  calculations: PricingCalculationLog[];
  
  // Decision reasoning
  reasoning: string;
  confidence: 'high' | 'medium' | 'low';
  warnings: string[];
  
  // Competitor summary
  competitorSummary: {
    lowestDeliveredPrice?: number;
    medianDeliveredPrice?: number;
    amazonPrice?: number;
    walmartPrice?: number;
    ebayActiveCount?: number;
    ebaySoldCount?: number;
  };

  /** The exact search strings sent to eBay Browse and Google Shopping. */
  searchQuery?: {
    /** e.g. "Mary Ruth Organics Liquid Probiotic 15.22 fl oz" */
    ebayQuery: string;
    /** Full "brand + productName" query sent to Amazon Search API. */
    amazonQuery?: string;
    /** Same string sent to Google Shopping SERP. */
    googleQuery: string;
    /** SEO context appended (categoryPath + keyText + size). */
    seoContext?: string;
    /** The productName actually used for the price lookup (may differ from vision product name for bundles). */
    priceLookupTitle: string;
  };
}

export interface DraftLogs {
  sku: string;
  offerId?: string;
  createdAt: string;
  vision?: VisionAnalysisLog;
  /**
   * Full vision classification data — product attributes extracted from images.
   * More detailed than `vision` (which was for the older GPT-4o reasoning log).
   */
  classification?: VisionClassificationLog;
  pricing?: PricingDecisionLog;
  promotion?: {
    enabled: boolean;
    rate: number;
    reason: string;
  };
  autoPriceReduction?: {
    enabled: boolean;
    reduceBy: number;
    everyDays: number;
    minPrice: number;
    reason: string;
  };
  /**
   * Pricing gate status — enriched back onto offer.merchantData so the UI
   * can show a red "NEEDS REVIEW" badge without relying on eBay returning merchantData.
   * 'MANUAL_CONFIRMED' means the user has verified the price and cleared the gate.
   */
  pricingStatus?: 'OK' | 'ESTIMATED' | 'NEEDS_REVIEW' | 'MANUAL_CONFIRMED';
  /** Convenience flag: true when pricingStatus !== 'OK' */
  needsPriceReview?: boolean;
  /** Reasons why manual review is required (surfaced in edit-draft UI). */
  attentionReasons?: Array<{ code: string; message: string; severity?: string }>;
}

/**
 * Store draft logs in Redis.
 * Called during draft creation to persist AI reasoning and pricing decisions.
 */
export async function storeDraftLogs(
  userId: string,
  sku: string,
  logs: Partial<DraftLogs>
): Promise<void> {
  const key = `draft-logs:${userId}:${sku}`;
  
  const fullLogs: DraftLogs = {
    sku,
    createdAt: new Date().toISOString(),
    ...logs,
  };

  try {
    await redisCall('SET', key, JSON.stringify(fullLogs), 'EX', DRAFT_LOGS_TTL_SECONDS.toString());
    console.log(`[draft-logs] ✓ Stored logs for SKU ${sku}`);
  } catch (err) {
    console.error(`[draft-logs] ⚠️ Failed to store logs for SKU ${sku}:`, err);
    // Non-fatal - don't break draft creation
  }
}

/**
 * Update draft logs with offer ID after offer is created.
 */
export async function updateDraftLogsOfferId(
  userId: string,
  sku: string,
  offerId: string
): Promise<void> {
  const key = `draft-logs:${userId}:${sku}`;
  
  try {
    const existing = await redisCall('GET', key);
    if (existing.result && typeof existing.result === 'string') {
      const logs = JSON.parse(existing.result) as DraftLogs;
      logs.offerId = offerId;
      await redisCall('SET', key, JSON.stringify(logs), 'EX', DRAFT_LOGS_TTL_SECONDS.toString());
      
      // Also create an offerId-indexed key for lookup by offerId
      const offerKey = `draft-logs-offer:${userId}:${offerId}`;
      await redisCall('SET', offerKey, JSON.stringify(logs), 'EX', DRAFT_LOGS_TTL_SECONDS.toString());
      
      console.log(`[draft-logs] ✓ Updated logs for SKU ${sku} with offerId ${offerId}`);
    }
  } catch (err) {
    console.error(`[draft-logs] ⚠️ Failed to update logs with offerId:`, err);
  }
}

/**
 * Get draft logs by SKU.
 */
export async function getDraftLogs(
  userId: string,
  sku: string
): Promise<DraftLogs | null> {
  const key = `draft-logs:${userId}:${sku}`;
  
  try {
    const result = await redisCall('GET', key);
    if (result.result && typeof result.result === 'string') {
      return JSON.parse(result.result);
    }
  } catch (err) {
    console.error(`[draft-logs] Failed to get logs for SKU ${sku}:`, err);
  }
  
  return null;
}

/**
 * Confirm that the user has manually reviewed and approved the price for a
 * NEEDS_REVIEW draft. Updates both the offer-keyed and SKU-keyed Redis entries
 * to pricingStatus='MANUAL_CONFIRMED' so that enrichWithDraftLogsMeta no
 * longer re-applies the NEEDS_REVIEW gate on subsequent list loads.
 */
export async function confirmDraftPriceReview(
  userId: string,
  offerId: string,
): Promise<void> {
  const offerKey = `draft-logs-offer:${userId}:${offerId}`;
  try {
    const result = await redisCall('GET', offerKey);
    if (result.result && typeof result.result === 'string') {
      const logs = JSON.parse(result.result) as DraftLogs;
      logs.pricingStatus = 'MANUAL_CONFIRMED';
      logs.needsPriceReview = false;
      await redisCall('SET', offerKey, JSON.stringify(logs), 'EX', DRAFT_LOGS_TTL_SECONDS.toString());

      // Also patch the SKU-keyed entry if we know the SKU
      if (logs.sku) {
        const skuKey = `draft-logs:${userId}:${logs.sku}`;
        await redisCall('SET', skuKey, JSON.stringify(logs), 'EX', DRAFT_LOGS_TTL_SECONDS.toString());
      }
      console.log(`[draft-logs] ✓ Confirmed price review for offerId ${offerId}`);
    }
  } catch (err) {
    console.error(`[draft-logs] ⚠️ Failed to confirm price review for offerId ${offerId}:`, err);
    // Non-fatal
  }
}

/**
 * Get draft logs by offer ID.
 */
export async function getDraftLogsByOfferId(
  userId: string,
  offerId: string
): Promise<DraftLogs | null> {
  const key = `draft-logs-offer:${userId}:${offerId}`;
  
  try {
    const result = await redisCall('GET', key);
    if (result.result && typeof result.result === 'string') {
      return JSON.parse(result.result);
    }
  } catch (err) {
    console.error(`[draft-logs] Failed to get logs for offerId ${offerId}:`, err);
  }
  
  return null;
}

/**
 * Build pricing calculation log entries from a pricing decision.
 * This shows the step-by-step math.
 */
export function buildPricingCalculations(
  decision: {
    targetDeliveredCents?: number;
    finalItemCents?: number;
    finalShipCents?: number;
    freeShipApplied?: boolean;
    subsidyCents?: number;
    shippingEstimateCents?: number;
    ebayComps?: Array<{ deliveredCents: number; source: string }>;
    retailComps?: Array<{ deliveredCents: number; source: string }>;
    activeFloorDeliveredCents?: number | null;
    amazonPriceCents?: number | null;
    walmartPriceCents?: number | null;
    soldMedianDeliveredCents?: number | null;
    soldCount?: number;
    soldStrong?: boolean;
    fallbackUsed?: boolean;
    /** Actual draft price in cents — used when the pricing engine returned 0 (e.g. legacy path). */
    draftPriceCents?: number;
    /** Pricing source — 'amazon-direct' for amazon_anchored mode. */
    compsSource?: string;
  },
  settings: {
    discountPercent?: number;
    shippingEstimateCents?: number;
  }
): PricingCalculationLog[] {
  const logs: PricingCalculationLog[] = [];

  // Use draftPriceCents as fallback when the pricing engine produced 0
  // (e.g. legacy path called without retailPriceDollars, or PRICING_MODE not set)
  const effectiveFinalItemCents = (decision.finalItemCents && decision.finalItemCents > 0)
    ? decision.finalItemCents
    : (decision.draftPriceCents ?? 0);
  const noMarketData = !decision.targetDeliveredCents &&
    !decision.ebayComps?.length && !decision.retailComps?.length;

  // Step 1: Find competitor prices
  if (noMarketData) {
    // Always show step 1 — even when empty — so the developer knows why pricing fell back.
    const isPricingModeIssue = !decision.fallbackUsed && !decision.amazonPriceCents;
    logs.push({
      step: '1. Gather Competitor Prices',
      input: { ebayCompsCount: 0, retailCompsCount: 0 },
      output: {
        lowestEbayDelivered: 'N/A',
        amazonPrice: 'N/A',
        walmartPrice: 'N/A',
      },
      notes: isPricingModeIssue
        ? 'No market data fetched — PRICING_MODE may be set to legacy. Enable delivered_v2 in Settings/env for live price lookups.'
        : 'No competitor prices found for this product. Price shown is AI-estimated.',
    });
  } else if (decision.ebayComps?.length || decision.retailComps?.length) {
    logs.push({
      step: '1. Gather Competitor Prices',
      input: {
        ebayCompsCount: decision.ebayComps?.length || 0,
        retailCompsCount: decision.retailComps?.length || 0,
      },
      output: {
        lowestEbayDelivered: decision.activeFloorDeliveredCents 
          ? `$${(decision.activeFloorDeliveredCents / 100).toFixed(2)}`
          : 'N/A',
        amazonPrice: decision.amazonPriceCents 
          ? `$${(decision.amazonPriceCents / 100).toFixed(2)}`
          : 'N/A',
        walmartPrice: decision.walmartPriceCents 
          ? `$${(decision.walmartPriceCents / 100).toFixed(2)}`
          : 'N/A',
      },
      notes: 'Search eBay active listings, Amazon, Walmart, Google Shopping for competitor prices',
    });
  }

  // Step 2: Calculate target delivered price
  if (decision.targetDeliveredCents) {  // eslint-disable-line @typescript-eslint/no-extra-parens
    // Show the actual pricing method used, not a generic formula
    const soldMedianStr = decision.soldMedianDeliveredCents
      ? `$${(decision.soldMedianDeliveredCents / 100).toFixed(2)}`
      : 'N/A';
    const soldCountStr = decision.soldCount ?? 0;
    const isSoldBased = decision.soldStrong && decision.soldMedianDeliveredCents;
    const isRetailFallback = decision.fallbackUsed;

    let formula: string;
    let notes: string;
    const isAmazonAnchored = decision.compsSource === 'amazon-direct';
    if (isAmazonAnchored && decision.amazonPriceCents) {
      const ratioApplied = effectiveFinalItemCents > 0 && decision.amazonPriceCents > 0
        ? (effectiveFinalItemCents / decision.amazonPriceCents).toFixed(2)
        : '0.85';
      formula = `Target = Amazon $${(decision.amazonPriceCents / 100).toFixed(2)} × ${ratioApplied}`;
      notes = 'Price based on Amazon listing. Buyer pays item + shipping separately.';
    } else if (isSoldBased) {
      formula = `Target = Sold market data (${soldCountStr} recent sales, median ${soldMedianStr})`;
      notes = 'Price based on actual eBay sold data — what buyers are paying';
    } else if (decision.activeFloorDeliveredCents) {
      formula = `Target = Lowest active eBay listing ($${(decision.activeFloorDeliveredCents / 100).toFixed(2)})`;
      notes = 'No strong sold data — matching lowest active competitor';
    } else if (isRetailFallback) {
      formula = `Target = Retail price × 70% (no eBay sold/active data)`;
      notes = 'No eBay data available — using discounted retail as fallback';
    } else {
      formula = `Target = Market-based pricing`;
      notes = 'Price determined from available market data';
    }

    logs.push({
      step: '2. Calculate Target Delivered Price',
      input: {
        soldCount: soldCountStr,
        soldMedian: soldMedianStr,
        soldStrong: decision.soldStrong ?? false,
        competitorFloor: decision.activeFloorDeliveredCents 
          ? `$${(decision.activeFloorDeliveredCents / 100).toFixed(2)}`
          : 'N/A',
      },
      output: {
        targetDeliveredPrice: `$${(decision.targetDeliveredCents / 100).toFixed(2)}`,
      },
      formula,
      notes,
    });
  }

  // Step 3: Split into item + shipping
  if (decision.finalItemCents !== undefined || effectiveFinalItemCents > 0) {
    const shippingEstimate = decision.shippingEstimateCents || settings.shippingEstimateCents || 600;
    const displayItemCents = effectiveFinalItemCents;
    const displayShipCents = decision.finalShipCents ?? 0;
    const isAiPrice = noMarketData && decision.draftPriceCents && decision.draftPriceCents > 0;
    logs.push({
      step: '3. Split Into Item + Shipping',
      input: {
        targetDelivered: `$${((decision.targetDeliveredCents || 0) / 100).toFixed(2)}`,
        shippingEstimate: `$${(shippingEstimate / 100).toFixed(2)}`,
        freeShippingApplied: decision.freeShipApplied || false,
      },
      output: {
        itemPrice: `$${(displayItemCents / 100).toFixed(2)}`,
        shippingCharge: `$${(displayShipCents / 100).toFixed(2)}`,
        subsidyAmount: decision.subsidyCents 
          ? `$${(decision.subsidyCents / 100).toFixed(2)}`
          : '$0.00',
      },
      formula: decision.freeShipApplied 
        ? 'ItemPrice = TargetDelivered (free shipping, seller absorbs cost)'
        : 'ItemPrice = TargetDelivered - ShippingCharge',
      notes: isAiPrice
        ? '⚠️ Price is AI-estimated (no market data) — verify manually before listing'
        : decision.freeShipApplied 
          ? 'Free shipping enabled to compete with market'
          : 'Buyer pays shipping separately',
    });
  }

  // Step 4: Final verification
  logs.push({
    step: '4. Final Price Verification',
    input: {
      itemPrice: `$${(effectiveFinalItemCents / 100).toFixed(2)}`,
      shippingCharge: `$${((decision.finalShipCents || 0) / 100).toFixed(2)}`,
    },
    output: {
      buyerTotalCost: `$${((effectiveFinalItemCents + (decision.finalShipCents || 0)) / 100).toFixed(2)}`,
    },
    formula: 'BuyerTotal = ItemPrice + ShippingCharge',
    notes: noMarketData
      ? '⚠️ AI-estimated price — enable PRICING_MODE=delivered_v2 for real market data'
      : 'This is what the buyer pays at checkout',
  });

  return logs;
}
