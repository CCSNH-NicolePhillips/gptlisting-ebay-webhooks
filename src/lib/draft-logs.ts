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
}

export interface DraftLogs {
  sku: string;
  offerId?: string;
  createdAt: string;
  vision?: VisionAnalysisLog;
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
  },
  settings: {
    discountPercent?: number;
    shippingEstimateCents?: number;
  }
): PricingCalculationLog[] {
  const logs: PricingCalculationLog[] = [];

  // Step 1: Find competitor prices
  if (decision.ebayComps?.length || decision.retailComps?.length) {
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
  if (decision.targetDeliveredCents) {
    // Show the actual pricing method used, not a generic formula
    const soldMedianStr = decision.soldMedianDeliveredCents
      ? `$${(decision.soldMedianDeliveredCents / 100).toFixed(2)}`
      : 'N/A';
    const soldCountStr = decision.soldCount ?? 0;
    const isSoldBased = decision.soldStrong && decision.soldMedianDeliveredCents;
    const isRetailFallback = decision.fallbackUsed;

    let formula: string;
    let notes: string;
    if (isSoldBased) {
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
  if (decision.finalItemCents !== undefined) {
    const shippingEstimate = decision.shippingEstimateCents || settings.shippingEstimateCents || 600;
    logs.push({
      step: '3. Split Into Item + Shipping',
      input: {
        targetDelivered: `$${((decision.targetDeliveredCents || 0) / 100).toFixed(2)}`,
        shippingEstimate: `$${(shippingEstimate / 100).toFixed(2)}`,
        freeShippingApplied: decision.freeShipApplied || false,
      },
      output: {
        itemPrice: `$${(decision.finalItemCents / 100).toFixed(2)}`,
        shippingCharge: `$${((decision.finalShipCents || 0) / 100).toFixed(2)}`,
        subsidyAmount: decision.subsidyCents 
          ? `$${(decision.subsidyCents / 100).toFixed(2)}`
          : '$0.00',
      },
      formula: decision.freeShipApplied 
        ? 'ItemPrice = TargetDelivered (free shipping, seller absorbs cost)'
        : 'ItemPrice = TargetDelivered - ShippingCharge',
      notes: decision.freeShipApplied 
        ? 'Free shipping enabled to compete with market'
        : 'Buyer pays shipping separately',
    });
  }

  // Step 4: Final verification
  logs.push({
    step: '4. Final Price Verification',
    input: {
      itemPrice: `$${((decision.finalItemCents || 0) / 100).toFixed(2)}`,
      shippingCharge: `$${((decision.finalShipCents || 0) / 100).toFixed(2)}`,
    },
    output: {
      buyerTotalCost: `$${(((decision.finalItemCents || 0) + (decision.finalShipCents || 0)) / 100).toFixed(2)}`,
    },
    formula: 'BuyerTotal = ItemPrice + ShippingCharge',
    notes: 'This is what the buyer pays at checkout',
  });

  return logs;
}
