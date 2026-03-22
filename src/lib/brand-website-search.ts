/**
 * Brand Website Price Search — Perplexity AI web-search fallback.
 *
 * Step 5 in the Amazon pricing fallback chain: when Amazon, Rainforest,
 * keyword search, and Google Shopping all fail to find the correct retail
 * price (e.g. DTC-only brands like therootbrands.com that aren't on Amazon),
 * Perplexity's live web-search model finds the brand's official website and
 * extracts the current retail price.
 *
 * Uses `sonar` (fast, cheap) — not `sonar-reasoning` — since we only need
 * a single price lookup, not multi-step reasoning.
 */

import { perplexity, PERPLEXITY_MODELS } from './perplexity.js';
import type { AmazonPriceLookupResult } from './amazon-search.js';

const EMPTY: AmazonPriceLookupResult = {
  price: null,
  originalPrice: null,
  url: null,
  asin: null,
  title: null,
  brand: null,
  isPrime: false,
  rating: null,
  reviews: null,
  allResults: [],
  confidence: 'low',
  reasoning: 'brand-website-search-no-result',
};

/**
 * Ask Perplexity (sonar web-search) for the current retail price of a product
 * on the brand's official website.
 *
 * @param brand        Brand name (e.g. "Root")
 * @param productName  Product name (e.g. "Restore")
 * @param knownUrl     Optional URL hint from Vision API classification
 *                     (e.g. "https://therootbrands.com")
 */
export async function searchBrandWebsite(
  brand: string,
  productName: string,
  knownUrl?: string | null,
): Promise<AmazonPriceLookupResult> {
  if (!process.env.PERPLEXITY_API_KEY) {
    console.log('[brand-website] PERPLEXITY_API_KEY not set — skipping');
    return EMPTY;
  }

  const urlHint = knownUrl ? ` The brand website may be at ${knownUrl}.` : '';
  const prompt =
    `Find the current retail price of the product "${productName}" sold by the brand "${brand}" ` +
    `on their official brand website (not Amazon, not eBay, not a third-party retailer).${urlHint} ` +
    `Return ONLY a raw JSON object (no markdown, no code fences) with this exact shape: ` +
    `{"url":"https://...","priceDollars":74.00,"productTitle":"...","confidence":"high"}. ` +
    `Use confidence "high" if you directly saw the current price on the product page, ` +
    `"medium" if from a cached page or price aggregator, ` +
    `"low" if uncertain or estimated. ` +
    `If you cannot find a price on the official brand site, return: ` +
    `{"url":null,"priceDollars":null,"productTitle":null,"confidence":"low"}.`;

  try {
    console.log(
      `[brand-website] Searching Perplexity for "${brand} ${productName}"` +
      `${knownUrl ? ` (hint: ${knownUrl})` : ''}`,
    );

    const response = await perplexity.chat.completions.create({
      model: PERPLEXITY_MODELS.FAST, // sonar — live web search, fast + cheap
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 250,
    });

    const raw = (response.choices[0]?.message?.content ?? '').trim();
    console.log(`[brand-website] Raw response: ${raw.slice(0, 300)}`);

    // Perplexity sometimes wraps in ```json ... ``` — extract just the JSON object
    const jsonMatch = raw.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) {
      console.log('[brand-website] No JSON object in response — skipping');
      return EMPTY;
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      url: string | null;
      priceDollars: number | null;
      productTitle: string | null;
      confidence: string;
    };

    if (!parsed.priceDollars || parsed.priceDollars <= 0) {
      console.log('[brand-website] Response had no valid price — skipping');
      return EMPTY;
    }

    const confidence: AmazonPriceLookupResult['confidence'] =
      parsed.confidence === 'high' ? 'high' :
      parsed.confidence === 'medium' ? 'medium' :
      'low';

    if (confidence === 'low') {
      console.log(`[brand-website] Low confidence — skipping (url=${parsed.url})`);
      return EMPTY;
    }

    console.log(
      `[brand-website] ✅ Found: $${parsed.priceDollars.toFixed(2)} ` +
      `at ${parsed.url} (${confidence})`,
    );

    return {
      price: parsed.priceDollars,
      originalPrice: null,
      url: parsed.url,
      asin: null,
      title: parsed.productTitle,
      brand,
      isPrime: false,
      rating: null,
      reviews: null,
      allResults: [],
      confidence,
      reasoning: `brand-website-perplexity${parsed.url ? ` (${parsed.url})` : ''}`,
    };
  } catch (err) {
    console.warn(
      '[brand-website] Search error:',
      err instanceof Error ? err.message : String(err),
    );
    return EMPTY;
  }
}
