import { perplexity, PERPLEXITY_MODELS } from "./perplexity.js";

export interface WebSearchPriceResult {
  price: number | null;
  url: string | null;
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
    '1. Search the web for the OFFICIAL BRAND WEBSITE product page',
    '2. Find the specific product page URL (e.g., example.com/products/product-name)',
    '3. Prefer the brand\'s official website over third-party retailers',
    '4. Also tell me what price you see on that page (for verification)',
    '',
    'Respond in JSON format:',
    '{',
    '  "price": <number or null>,',
    '  "url": "<official brand product page URL>",',
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
      source: parsed.source,
      confidence: parsed.confidence,
    });

    return {
      price: typeof parsed.price === 'number' ? parsed.price : null,
      url: parsed.url || null,
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
      source: 'not-found',
      confidence: 'low',
      reasoning: `Search failed: ${error.message}`,
      raw: '',
    };
  }
}
