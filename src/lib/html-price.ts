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
 * Best-effort JSON-LD extraction for brand sites
 * No retailer-specific logic - just try to find Product schema and extract price
 */
function extractFromJsonLd($: cheerio.CheerioAPI): ExtractedData {
  const scripts = $('script[type="application/ld+json"]').toArray();
  
  if (scripts.length === 0) {
    console.log(`[HTML Parser] No JSON-LD scripts found`);
    return { price: null };
  }
  
  console.log(`[HTML Parser] Found ${scripts.length} JSON-LD script(s), attempting extraction...`);
  
  const allPrices: number[] = [];
  
  for (const node of scripts) {
    try {
      const raw = $(node).text().trim();
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const type = String((item as any)["@type"] || "").toLowerCase();
        if (!type.includes("product")) continue;
        
        // Found a Product schema - try to extract price from offers
        const offers = (item as any).offers;
        if (!offers) continue;
        const offerList = Array.isArray(offers) ? offers : [offers];
        
        // Collect all prices from all offers
        for (const offer of offerList) {
          if (!offer || typeof offer !== "object") continue;
          
          // Handle priceSpecification as array OR object (Root Brands uses array)
          const priceSpec = (offer as any).priceSpecification;
          const priceFromSpec = Array.isArray(priceSpec)
            ? toNumber(priceSpec[0]?.price)
            : toNumber(priceSpec?.price);
          
          const priceFromOffer =
            toNumber((offer as any).price) ??
            priceFromSpec ??
            toNumber((offer as any).lowPrice);
          
          if (priceFromOffer) {
            allPrices.push(priceFromOffer);
          }
        }
      }
    } catch (err) {
      // Invalid JSON - skip this script
      continue;
    }
  }
  
  if (allPrices.length === 0) {
    console.log(`[HTML Parser] No price found in JSON-LD`);
    return { price: null };
  }
  
  // Filter out unrealistic bulk/wholesale prices (>$500 for supplements/beauty)
  const retailPrices = allPrices.filter(p => p <= 500);
  
  if (retailPrices.length === 0) {
    console.log(`[HTML Parser] All prices rejected as bulk/wholesale (>${500}): ${allPrices.join(', ')}`);
    return { price: null };
  }
  
  // Return the lowest retail price (excludes subscriptions which are often discounted)
  const minRetailPrice = Math.min(...retailPrices);
  console.log(`[HTML Parser] ✓ Extracted price $${minRetailPrice} from JSON-LD Product (found ${allPrices.length} price(s): ${allPrices.join(', ')}, using lowest retail)`);
  return { price: minRetailPrice };
}

function extractFromOpenGraph($: cheerio.CheerioAPI): number | null {
  const og =
    $(
      'meta[property="product:price:amount"], meta[property="og:price:amount"], meta[name="product:price:amount"], meta[name="og:price:amount"]'
    ).attr("content") || "";
  return og ? toNumber(og) : null;
}

function extractFromBody($: cheerio.CheerioAPI): number | null {
  const bodyText = $.root().text().replace(/\s+/g, " ");
  const targeted = bodyText.match(/(?:price|buy|order|sale)[^$]{0,60}\$\s?(\d{1,4}(?:\.\d{2})?)/i);
  if (targeted) {
    return toNumber(targeted[1]);
  }
  const match = bodyText.match(/\$\s?(\d{1,4}(?:\.\d{2})?)/);
  return match ? toNumber(match[1]) : null;
}

export function extractPriceFromHtml(html: string): number | null {
  try {
    const $ = cheerio.load(html);
    const data = extractFromJsonLd($);
    return data.price ?? extractFromOpenGraph($) ?? extractFromBody($);
  } catch {
    return null;
  }
}

/**
 * @deprecated Use extractPriceFromHtml instead - productType extraction removed
 */
export function extractPriceAndTypeFromHtml(html: string): ExtractedData {
  console.warn('[HTML Parser] extractPriceAndTypeFromHtml is deprecated, use extractPriceFromHtml');
  try {
    const $ = cheerio.load(html);
    const data = extractFromJsonLd($);
    if (data.price) return data;
    const price = extractFromOpenGraph($) ?? extractFromBody($);
    return { price };
  } catch {
    return { price: null };
  }
}
