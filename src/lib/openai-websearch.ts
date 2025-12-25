/**
 * OpenAI Responses API with web_search for brand website pricing
 * 
 * This module provides web search capabilities using OpenAI's Responses API
 * with the web_search tool. Used as Tier 2 fallback when Amazon doesn't have the product.
 * 
 * Usage:
 *   const result = await searchBrandWebsitePrice(imagePath, brand, productName);
 *   // or with just text (no image):
 *   const result = await searchBrandWebsitePriceText(brand, productName, keyText);
 */

import * as fs from 'fs';
import * as path from 'path';

export interface BrandWebsitePriceResult {
  brand: string;
  productName: string;
  officialWebsite: string | null;
  productUrl: string | null;
  amazonUrl: string | null;
  amazonReasoning: string | null;
  price: number | null;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  source: 'brand-website' | 'retailer' | 'not-found';
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

/**
 * Search for brand website price using image + web search
 * Best accuracy - can read the exact product from the label
 */
export async function searchBrandWebsitePrice(
  imagePath: string,
  brandHint?: string,
  productHint?: string
): Promise<BrandWebsitePriceResult> {
  if (!OPENAI_API_KEY) {
    console.log('[openai-websearch] OPENAI_API_KEY not set, skipping');
    return {
      brand: brandHint || 'unknown',
      productName: productHint || 'unknown',
      officialWebsite: null,
      productUrl: null,
      amazonUrl: null,
      amazonReasoning: null,
      price: null,
      confidence: 'low',
      reasoning: 'OpenAI API key not configured',
      source: 'not-found'
    };
  }

  // Read and base64 encode the image
  const imageBytes = fs.readFileSync(imagePath);
  const imageBase64 = imageBytes.toString('base64');
  
  // Detect MIME type
  const ext = path.extname(imagePath).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : 
               ext === '.webp' ? 'image/webp' : 'image/jpeg';
  
  const dataUrl = `data:${mime};base64,${imageBase64}`;
  
  const prompt = buildPrompt(brandHint, productHint);

  const body = {
    model: 'gpt-4.1',
    tools: [{ type: 'web_search' }],
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: prompt },
          { type: 'input_image', image_url: dataUrl }
        ]
      }
    ]
  };

  return await callOpenAIResponsesAPI(body, brandHint, productHint);
}

/**
 * Search for brand website price using text only (no image)
 * Use when image is not available but we have brand/product from vision
 */
export async function searchBrandWebsitePriceText(
  brand: string,
  productName: string,
  keyText?: string[],
  quantityInPhoto?: number
): Promise<BrandWebsitePriceResult> {
  if (!OPENAI_API_KEY) {
    console.log('[openai-websearch] OPENAI_API_KEY not set, skipping');
    return {
      brand,
      productName,
      officialWebsite: null,
      productUrl: null,
      amazonUrl: null,
      amazonReasoning: null,
      price: null,
      confidence: 'low',
      reasoning: 'OpenAI API key not configured',
      source: 'not-found'
    };
  }

  const keyTextStr = keyText?.length ? `\nKey details: ${keyText.join(', ')}` : '';
  const quantityNote = quantityInPhoto && quantityInPhoto > 1 
    ? `\n\nIMPORTANT: The photo shows ${quantityInPhoto} units of this product. Find the price for a ${quantityInPhoto}-pack or bundle if available.`
    : `\n\nIMPORTANT: The photo shows a SINGLE unit. Find the price for 1 single unit, NOT bundles or multi-packs. If the page has multiple variants, choose the single-unit option.`;
  
  const prompt = `Find the official brand website and current retail price for this product:

Brand: ${brand}
Product: ${productName}${keyTextStr}${quantityNote}

Instructions:
1. Search for the OFFICIAL BRAND WEBSITE (NOT Amazon, eBay, Walmart, or other retailers)
2. Find the specific product page URL on the brand's website
3. Get the current retail price from the brand's website
4. ALSO search Amazon.com for the EXACT SAME PRODUCT - Use the brand, product name, and be VERY CAREFUL to match the exact variant (size, count, strength like "50 Billion CFU" vs "1 Billion CFU")
5. Only return an Amazon URL if you are CERTAIN it is the exact same product variant

Return JSON:
{
  "brand": "${brand}",
  "productName": "${productName}",
  "officialWebsite": "https://brand.com",
  "productUrl": "https://brand.com/products/product-name",
  "amazonUrl": "https://amazon.com/dp/ASIN" or null,
  "amazonReasoning": "Explain why this Amazon product matches or why no match was found",
  "price": 49.99,
  "confidence": "high" | "medium" | "low",
  "reasoning": "brief explanation",
  "source": "brand-website" | "retailer" | "not-found"
}`;

  const body = {
    model: 'gpt-4.1',
    tools: [{ type: 'web_search' }],
    input: [
      {
        role: 'user',
        content: prompt
      }
    ]
  };

  return await callOpenAIResponsesAPI(body, brand, productName);
}

function buildPrompt(brandHint?: string, productHint?: string): string {
  const hints = brandHint || productHint 
    ? `\nHints: Brand="${brandHint || 'unknown'}", Product="${productHint || 'unknown'}"`
    : '';

  return `Look at this product image and find its price on the official brand website.

STEP 1: Identify the brand and exact product name from the image.${hints}

STEP 2: Search the web for the OFFICIAL BRAND WEBSITE.
- Do NOT use Amazon, eBay, Walmart, or other retailers
- Find the brand's own website (e.g., performbettr.com, thisisneeded.com)

STEP 3: Find the specific product page URL on the brand's website.

STEP 4: Get the current retail price from the brand's website.

STEP 5: ALSO search Amazon.com for the EXACT SAME PRODUCT.
- Be VERY CAREFUL to match the exact variant (size, count, strength like "50 Billion CFU" vs "1 Billion CFU")
- Only return an Amazon URL if you are CERTAIN it is the exact same product variant
- Explain your reasoning for why this Amazon product matches or doesn't

Return JSON only:
{
  "brand": "brand name",
  "productName": "product name",
  "officialWebsite": "https://brand.com",
  "productUrl": "https://brand.com/products/product-name",
  "amazonUrl": "https://amazon.com/dp/ASIN" or null,
  "amazonReasoning": "Explain why this Amazon product matches or why no match was found",
  "price": 49.99,
  "confidence": "high" | "medium" | "low",
  "reasoning": "brief explanation",
  "source": "brand-website" | "retailer" | "not-found"
}`;
}

async function callOpenAIResponsesAPI(
  body: any,
  brandFallback?: string,
  productFallback?: string
): Promise<BrandWebsitePriceResult> {
  console.log('[openai-websearch] Calling OpenAI Responses API with web_search...');
  
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const error = await response.text();
    console.error(`[openai-websearch] API error: ${response.status} ${error}`);
    return {
      brand: brandFallback || 'unknown',
      productName: productFallback || 'unknown',
      officialWebsite: null,
      productUrl: null,
      amazonUrl: null,
      amazonReasoning: null,
      price: null,
      confidence: 'low',
      reasoning: `API error: ${response.status}`,
      source: 'not-found'
    };
  }

  const data = await response.json() as any;
  
  // Extract the text response from Responses API structure
  let outputText = '';
  if (data.output && Array.isArray(data.output)) {
    for (const item of data.output) {
      if (item.type === 'message' && item.content && Array.isArray(item.content)) {
        for (const content of item.content) {
          if (content.type === 'output_text' && content.text) {
            outputText = content.text;
            break;
          }
        }
      }
    }
  }
  
  console.log('[openai-websearch] Response received, parsing...');
  
  // Parse JSON from response
  const jsonMatch = outputText.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      console.log(`[openai-websearch] ✓ Found: ${parsed.brand} - $${parsed.price} (${parsed.confidence})`);
      if (parsed.amazonUrl) {
        console.log(`[openai-websearch] ✓ Amazon URL: ${parsed.amazonUrl}`);
        console.log(`[openai-websearch]   Reason: ${parsed.amazonReasoning}`);
      }
      return {
        brand: parsed.brand || brandFallback || 'unknown',
        productName: parsed.productName || productFallback || 'unknown',
        officialWebsite: parsed.officialWebsite || null,
        productUrl: parsed.productUrl || null,
        amazonUrl: parsed.amazonUrl || null,
        amazonReasoning: parsed.amazonReasoning || null,
        price: typeof parsed.price === 'number' ? parsed.price : null,
        confidence: parsed.confidence || 'low',
        reasoning: parsed.reasoning || '',
        source: parsed.source || 'brand-website'
      };
    } catch (e) {
      console.error('[openai-websearch] Failed to parse JSON:', e);
    }
  }
  
  return {
    brand: brandFallback || 'unknown',
    productName: productFallback || 'unknown',
    officialWebsite: null,
    productUrl: null,
    amazonUrl: null,
    amazonReasoning: null,
    price: null,
    confidence: 'low',
    reasoning: outputText || 'Failed to parse response',
    source: 'not-found'
  };
}
