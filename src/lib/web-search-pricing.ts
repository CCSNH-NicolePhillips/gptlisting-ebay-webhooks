import { perplexity, PERPLEXITY_MODELS } from "./perplexity.js";

export interface WebSearchPriceResult {
  price: number | null;
  url: string | null;
  brandDomain: string | null; // Brand website domain for fallback URL generation
  source: string; // "brand-website" | "amazon" | "retailer" | "not-found"
  confidence: "high" | "medium" | "low";
  reasoning: string;
  raw: string; // Full response for debugging
}

/**
 * Use web-search AI to find product pricing
 * Falls back when traditional scraping fails (not on Amazon, wrong URLs, etc.)
 * 
 * Uses Perplexity's sonar model which has real-time web search
 */
export async function searchWebForPrice(
  brand: string,
  productName: string,
  additionalContext?: string
): Promise<WebSearchPriceResult> {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  
  if (!apiKey) {
    console.log('[web-search] PERPLEXITY_API_KEY not set, skipping web search');
    return {
      price: null,
      url: null,
      brandDomain: null,
      source: 'not-found',
      confidence: 'low',
      reasoning: 'Web search disabled (no API key)',
      raw: '',
    };
  }

  const query = [
    `Find the official product webpage for: ${brand} ${productName}`,
    additionalContext ? `Context: ${additionalContext}` : '',
    '',
    'Instructions:',
    '1. Search the web for the OFFICIAL BRAND WEBSITE',
    '2. Find the brand\'s main website domain first',
    '3. Then find the specific product page URL (usually /products/product-name or /shop/product-name)',
    '4. If you cannot find the exact product page, still return the brand domain so we can try common URL patterns',
    '5. Also tell me what price you see on that page (for verification)',
    '',
    'Respond in JSON format:',
    '{',
    '  "price": <number or null>,',
    '  "url": "<product page URL or empty string>",',
    '  "brandDomain": "<brand website domain, e.g., thebetteralt.com>",',
    '  "source": "brand-website" | "amazon" | "retailer" | "not-found",',
    '  "confidence": "high" | "medium" | "low",',
    '  "reasoning": "<brief explanation>"',
    '}',
  ].filter(Boolean).join('\n');

  console.log('[web-search] Searching for:', brand, productName);

  try {
    const response = await perplexity.chat.completions.create({
      model: PERPLEXITY_MODELS.FAST, // Use fast model for price lookups
      messages: [
        {
          role: 'user',
          content: query,
        },
      ],
      temperature: 0.1, // Low temperature for factual responses
      max_tokens: 500,
    });

    const content = response.choices[0]?.message?.content?.trim() || '';
    console.log('[web-search] ===== FULL PERPLEXITY RESPONSE =====');
    console.log(content);
    console.log('[web-search] ===== END RESPONSE =====');

    // Try to extract JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('[web-search] No JSON found in response');
      return {
        price: null,
        url: null,
        brandDomain: null,
        source: 'not-found',
        confidence: 'low',
        reasoning: 'Failed to parse response',
        raw: content,
      };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    
    console.log('[web-search] Parsed result:', {
      price: parsed.price,
      url: parsed.url?.substring(0, 60),
      brandDomain: parsed.brandDomain,
      source: parsed.source,
      confidence: parsed.confidence,
    });

    return {
      price: typeof parsed.price === 'number' ? parsed.price : null,
      url: parsed.url || null,
      brandDomain: parsed.brandDomain || null,
      source: parsed.source || 'not-found',
      confidence: parsed.confidence || 'low',
      reasoning: parsed.reasoning || '',
      raw: content,
    };
  } catch (error: any) {
    console.error('[web-search] Error:', error.message);
    return {
      price: null,
      url: null,
      brandDomain: null,
      source: 'not-found',
      confidence: 'low',
      reasoning: `Search failed: ${error.message}`,
      raw: '',
    };
  }
}
