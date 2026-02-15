/**
 * Reprice endpoint - Get a fresh price for a product
 * 
 * POST /.netlify/functions/reprice
 * Body: { brand: string, productName: string }
 * 
 * Returns: {
 *   success: boolean,
 *   suggestedPrice: number,  // in dollars
 *   decision: DeliveredPricingDecision,
 *   debug: { ... }
 * }
 */

import type { Handler, HandlerEvent } from '../../src/types/api-handler.js';
import { getBearerToken, requireAuthVerified, getJwtSubUnverified } from '../../src/lib/_auth.js';
import { getDeliveredPricing, type DeliveredPricingDecision, type DeliveredPricingSettings } from '../../src/lib/delivered-pricing.js';

export const handler: Handler = async (event: HandlerEvent) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed. Use POST.' }),
    };
  }

  try {
    // Require authentication
    const bearer = getBearerToken(event);
    let sub = (await requireAuthVerified(event))?.sub || null;
    if (!sub) sub = getJwtSubUnverified(event);
    if (!bearer || !sub) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: 'Unauthorized' }),
      };
    }

    const userId = sub;
    console.log(`[reprice] User ${userId} requesting reprice`);

    // Parse request body
    let body: { brand?: string; productName?: string };
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid JSON body' }),
      };
    }

    const { brand, productName } = body;

    if (!brand && !productName) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ 
          error: 'Missing required fields: brand and/or productName',
          example: { brand: 'Jive', productName: 'Protein Hydrator Strawberry Acai Lemonade' },
        }),
      };
    }

    console.log(`[reprice] Looking up price for: brand="${brand || ''}", product="${productName || ''}"`);

    // Use the same settings as smartdrafts-create-drafts-background.ts
    const deliveredSettings: Partial<DeliveredPricingSettings> = {
      mode: 'market-match',
      shippingEstimateCents: 600, // $6.00 default
      minItemCents: 499, // $4.99 floor
      lowPriceMode: 'FLAG_ONLY',
      useSmartShipping: true,
    };

    const decision: DeliveredPricingDecision = await getDeliveredPricing(
      brand || '',
      productName || '',
      deliveredSettings
    );

    const suggestedPrice = decision.finalItemCents / 100;

    console.log(`[reprice] Result: $${suggestedPrice.toFixed(2)} (canCompete=${decision.canCompete}, confidence=${decision.matchConfidence})`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        suggestedPrice,
        shippingPrice: decision.finalShipCents / 100,
        freeShipping: decision.freeShipApplied,
        canCompete: decision.canCompete,
        matchConfidence: decision.matchConfidence,
        debug: {
          targetDeliveredCents: decision.targetDeliveredCents,
          finalItemCents: decision.finalItemCents,
          finalShipCents: decision.finalShipCents,
          ebayCompsCount: decision.ebayComps.length,
          retailCompsCount: decision.retailComps.length,
          amazonPriceCents: decision.amazonPriceCents,
          walmartPriceCents: decision.walmartPriceCents,
          soldMedianDeliveredCents: decision.soldMedianDeliveredCents,
          soldCount: decision.soldCount,
          shippingEstimateSource: decision.shippingEstimateSource,
          compsSource: decision.compsSource,
          warnings: decision.warnings,
        },
      }, null, 2),
    };

  } catch (error: unknown) {
    const err = error as Error;
    console.error('[reprice] Error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: err.message,
        stack: err.stack?.split('\n').slice(0, 5),
      }),
    };
  }
};
