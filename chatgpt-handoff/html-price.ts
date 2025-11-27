import * as cheerio from "cheerio";

function toNumber(value: unknown): number | null {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return +num.toFixed(2);
}

type ExtractedData = {
  price: number | null;
  productType?: string;
};

/**
 * Detect if the product is a multi-pack/bundle based on title and text
 */
function detectMultiPack($: cheerio.CheerioAPI): { isMultiPack: boolean; packSize?: number } {
  const title = $('title').text().toLowerCase();
  const h1 = $('h1').first().text().toLowerCase();
  const productText = `${title} ${h1}`;
  
  // Common multi-pack indicators
  const packPatterns = [
    /\b(\d+)\s*pack\b/i,
    /\b(\d+)\s*count\s*pack\b/i,
    /\bpack\s*of\s*(\d+)\b/i,
    /\btwin\s*pack\b/i,    // twin = 2
    /\bdouble\s*pack\b/i,  // double = 2
    /\btriple\s*pack\b/i,  // triple = 3
    /\b(\d+)\s*bottles?\b/i,
    /\b(\d+)\s*units?\b/i,
    /\bbundle/i,
  ];
  
  for (const pattern of packPatterns) {
    const match = productText.match(pattern);
    if (match) {
      // Extract pack size if available
      const packSize = match[1] ? parseInt(match[1], 10) : undefined;
      
      // Special cases
      if (/twin|double/i.test(match[0])) return { isMultiPack: true, packSize: 2 };
      if (/triple/i.test(match[0])) return { isMultiPack: true, packSize: 3 };
      
      return { isMultiPack: true, packSize };
    }
  }
  
  return { isMultiPack: false };
}

export function extractPriceFromHtml(html: string): number | null {
  try {
    const $ = cheerio.load(html);
    
    // Check for multi-pack products
    const packInfo = detectMultiPack($);
    if (packInfo.isMultiPack) {
      const packMsg = packInfo.packSize 
        ? `${packInfo.packSize}-pack`
        : 'multi-pack';
      console.log(`[HTML Parser] ⚠️ WARNING: Detected ${packMsg} product - price may not be for single unit!`);
    }
    
    const data = extractFromJsonLd($);
    
    // If JSON-LD explicitly rejected prices (returned -1), don't fallback
    if (data.price === -1) return null;
    
    return data.price ?? extractFromOpenGraph($) ?? extractFromBody($);
  } catch {
    return null;
  }
}

// ... rest of the file continues (see actual file for full implementation)
// This is a COPY for ChatGPT reference - see README.md for problem description
