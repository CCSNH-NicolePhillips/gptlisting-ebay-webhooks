/**
 * Debug pricing lookup for specific products
 * 
 * GET /.netlify/functions/debug-price?brand=X&title=Y&skipCache=true
 */

import type { Handler, HandlerEvent } from '@netlify/functions';
import { lookupPrice } from '../../src/lib/price-lookup.js';
import { deleteCachedPrice, makePriceSig } from '../../src/lib/price-cache.js';

export const handler: Handler = async (event: HandlerEvent) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  try {
    const params = event.queryStringParameters || {};
    const brand = params.brand;
    const title = params.title;
    const skipCache = params.skipCache === 'true';
    const clearCache = params.clearCache === 'true';
    const netWeightValue = params.netWeightValue ? parseFloat(params.netWeightValue) : undefined;
    const netWeightUnit = params.netWeightUnit;

    if (!brand || !title) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ 
          error: 'Missing required params: brand and title',
          example: '?brand=Cymbiotika&title=Liposomal%20Magnesium%20Complex&skipCache=true'
        }),
      };
    }

    // Build cache signature
    const sig = makePriceSig(brand, title);

    // Clear cache if requested
    if (clearCache) {
      const deleted = await deleteCachedPrice(sig);
      console.log(`[debug-price] Cache clear for "${sig}": ${deleted}`);
    }

    // Build netWeight if provided
    const netWeight = netWeightValue && netWeightUnit 
      ? { value: netWeightValue, unit: netWeightUnit }
      : undefined;

    console.log(`[debug-price] Looking up: brand="${brand}", title="${title}", skipCache=${skipCache}`);

    const result = await lookupPrice({
      brand,
      title,
      skipCache,
      netWeight: netWeight as any,
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        input: { brand, title, skipCache, netWeight },
        cacheSig: sig,
        result: {
          ok: result.ok,
          chosen: result.chosen,
          recommendedListingPrice: result.recommendedListingPrice,
          candidates: result.candidates,
          reason: result.reason,
          needsManualReview: result.needsManualReview,
          manualReviewReason: result.manualReviewReason,
        },
      }, null, 2),
    };

  } catch (error: any) {
    console.error('[debug-price] Error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: error.message,
        stack: error.stack?.split('\n').slice(0, 5),
      }),
    };
  }
};
