/**
 * Google Lens Visual Product Search via SearchAPI.io
 * 
 * Uses visual search to identify products when text-based search fails.
 * Particularly useful for niche/MLM products where brand names don't match well.
 * 
 * Pricing: ~$0.01/search (same as Google Shopping)
 */

const SEARCHAPI_KEY = process.env.SEARCHAPI_KEY;
const SEARCHAPI_BASE = "https://www.searchapi.io/api/v1/search";

export interface LensVisualMatch {
  position: number;
  title: string;
  link: string;
  source: string;
  price?: string;
  extracted_price?: number;
  currency?: string;
  stock_information?: string;
  thumbnail?: string;
}

export interface LensSearchResult {
  ok: boolean;
  visual_matches: LensVisualMatch[];
  bestMatch?: LensVisualMatch;
  bestPrice?: number;
  bestPriceSource?: string;
  reasoning: string;
}

/**
 * Search Google Lens for a product image and return visual matches with prices
 * 
 * @param imageUrl - Public URL of the product image to search
 * @param searchHint - Optional text query to refine results (e.g., brand name)
 */
export async function searchGoogleLens(
  imageUrl: string,
  searchHint?: string
): Promise<LensSearchResult> {
  const empty: LensSearchResult = {
    ok: false,
    visual_matches: [],
    reasoning: 'No results',
  };

  if (!SEARCHAPI_KEY) {
    console.log('[google-lens] No SEARCHAPI_KEY configured, skipping');
    return { ...empty, reasoning: 'SEARCHAPI_KEY not configured' };
  }

  if (!imageUrl) {
    console.log('[google-lens] No image URL provided');
    return { ...empty, reasoning: 'No image URL provided' };
  }

  console.log(`[google-lens] Searching for product: ${imageUrl.slice(0, 80)}...`);
  if (searchHint) {
    console.log(`[google-lens] Search hint: "${searchHint}"`);
  }

  try {
    const url = new URL(SEARCHAPI_BASE);
    url.searchParams.set('engine', 'google_lens');
    url.searchParams.set('search_type', 'products'); // Focus on shopping results
    url.searchParams.set('url', imageUrl);
    url.searchParams.set('api_key', SEARCHAPI_KEY);
    
    if (searchHint) {
      url.searchParams.set('q', searchHint);
    }

    const response = await fetch(url.toString());

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[google-lens] API Error ${response.status}: ${errorText}`);
      return { ...empty, reasoning: `API error: ${response.status}` };
    }

    const data = await response.json();

    // Extract visual matches
    const matches: LensVisualMatch[] = data.visual_matches || [];
    
    if (matches.length === 0) {
      console.log('[google-lens] No visual matches found');
      return { ...empty, reasoning: 'No visual matches found' };
    }

    console.log(`[google-lens] Found ${matches.length} visual matches`);

    // Log top results
    console.log('[google-lens] Top results:');
    matches.slice(0, 5).forEach((m, i) => {
      const price = m.extracted_price ? `$${m.extracted_price}` : 'no price';
      console.log(`  ${i + 1}. ${price} - ${m.source} - ${m.title?.slice(0, 50)}`);
    });

    // Find best match with a price (prioritize major retailers)
    const MAJOR_RETAILERS = ['amazon', 'walmart', 'target', 'cvs', 'walgreens', 'ulta', 'ebay'];
    
    // First try to find a major retailer match
    let bestMatch = matches.find(m => 
      m.extracted_price && 
      m.extracted_price > 0 &&
      MAJOR_RETAILERS.some(r => m.source?.toLowerCase().includes(r))
    );

    // If no major retailer, take the first match with a price
    if (!bestMatch) {
      bestMatch = matches.find(m => m.extracted_price && m.extracted_price > 0);
    }

    const result: LensSearchResult = {
      ok: true,
      visual_matches: matches,
      bestMatch,
      bestPrice: bestMatch?.extracted_price,
      bestPriceSource: bestMatch?.source,
      reasoning: bestMatch 
        ? `Found ${matches.length} matches. Best: $${bestMatch.extracted_price} from ${bestMatch.source}`
        : `Found ${matches.length} matches but none with prices`,
    };

    console.log(`[google-lens] ${result.reasoning}`);

    return result;

  } catch (error) {
    console.error('[google-lens] Error:', error);
    return {
      ...empty,
      reasoning: `Error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Use Gemini vision to identify a product from an image
 * Returns product name, brand, and any identifying information
 * 
 * @param imageUrl - Public URL or base64 data URL of the product image
 */
export async function identifyProductWithGemini(
  imageUrl: string
): Promise<{
  ok: boolean;
  brand?: string;
  productName?: string;
  fullName?: string;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
}> {
  const apiKey = process.env.GEMINI_API_KEY;
  
  if (!apiKey) {
    console.log('[gemini-identify] No GEMINI_API_KEY configured');
    return {
      ok: false,
      confidence: 'low',
      reasoning: 'GEMINI_API_KEY not configured',
    };
  }

  console.log('[gemini-identify] Identifying product from image...');

  try {
    // Use the @google/generative-ai SDK
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    // Prepare the image part
    const parts: any[] = [];
    
    if (imageUrl.startsWith('data:')) {
      // Base64 data URL
      const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        parts.push({
          inlineData: {
            mimeType: match[1],
            data: match[2],
          },
        });
      }
    } else {
      // Regular URL - Gemini can fetch it
      parts.push({
        fileData: {
          mimeType: 'image/jpeg',
          fileUri: imageUrl,
        },
      });
    }

    parts.push({
      text: `Identify this product. Look for brand name, product name, and any text on the packaging.

Return a JSON object with these fields:
- brand: The brand/manufacturer name (e.g., "Root", "NOW Foods", "Snap")
- productName: The specific product name including size/count (e.g., "Sculpt Dietary Supplement 60 Capsules")
- fullName: Complete product name as it would appear in a search (e.g., "Root Sculpt Dietary Supplement 60 Capsules")
- confidence: "high" if you can clearly read the text, "medium" if partially visible, "low" if guessing
- reasoning: Brief explanation of what you identified

Return ONLY valid JSON, no markdown or explanation.`,
    });

    const response = await model.generateContent({
      contents: [{ role: 'user', parts }],
    });

    const text = response.response.text() || '{}';
    const jsonLike = text.trim().replace(/```json|```/g, '');
    
    // Parse JSON from response
    const parsed = JSON.parse(jsonLike);
    
    console.log(`[gemini-identify] Identified: ${parsed.fullName || parsed.productName} (${parsed.confidence})`);

    return {
      ok: true,
      brand: parsed.brand,
      productName: parsed.productName,
      fullName: parsed.fullName,
      confidence: parsed.confidence || 'medium',
      reasoning: parsed.reasoning || 'Product identified',
    };

  } catch (error) {
    console.error('[gemini-identify] Error:', error);
    return {
      ok: false,
      confidence: 'low',
      reasoning: `Error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
