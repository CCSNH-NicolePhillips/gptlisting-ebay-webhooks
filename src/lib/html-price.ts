import * as cheerio from "cheerio";

function toNumber(value: unknown): number | null {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return +num.toFixed(2);
}

/**
 * Detect if the page is likely a bundle/subscription/multi-month pack page
 * These pages show bundled pricing (e.g., $225 for 3-month supply) instead of single-product prices
 * 
 * Note: This should NOT flag Amazon/eBay pages that offer "Subscribe & Save" as an OPTION.
 * Only flag pages that are PRIMARILY about bundles/multi-month kits.
 */
function isProbablyBundlePage(html: string): boolean {
  if (!html) return false;
  
  // Don't flag major retailers - they offer subscriptions as options, not as bundle pages
  if (html.includes('amazon.com') || html.includes('ebay.com') || html.includes('walmart.com')) {
    return false;
  }
  
  // STRONG signals: These almost always indicate bundle/multi-month pages
  const strongBundleIndicators: RegExp[] = [
    /\b\d+\s*-\s*month\s*(supply|pack|kit)\b/i,      // "3-month supply"
    /\b\d+\s*(month|mo)\s*(supply|pack|kit)\b/i,      // "3 month kit"
    /starter\s*(pack|kit|bundle)/i,                    // "Starter Pack"
    /\bvalue\s*pack\b/i,                               // "Value Pack"
    /\brefill\s*program\b/i,                           // "Refill Program"
  ];
  
  // Return true if ANY strong signal is found
  return strongBundleIndicators.some(pattern => pattern.test(html));
}

type ExtractedData = {
  price: number | null;
  productType?: string;
};

interface OfferCandidate {
  price: number;
  currency?: string;
  nameText?: string;
  descriptionText?: string;
  rawOffer: any;
  packQty: number;      // detected pack quantity, default 1
  unitPrice: number;    // price / packQty
  size?: string | null; // detected size (e.g., "8oz", "226.8g")
}

/**
 * Detect pack quantity from offer name/description text
 */
function detectPackQty(text: string | undefined): number {
  if (!text) return 1;
  const t = text.toLowerCase();

  // Strong signals: "pack of 2", "pk of 3"
  const m1 = t.match(/\b(?:pack|pk)\s*of\s*(\d+)\b/);
  if (m1) return parseInt(m1[1], 10);

  // "2 pack", "3 bottles", "4 count", "60 capsules"
  const m2 = t.match(/\b(\d+)\s*(?:pack|pk|count|ct|bottles?|capsules?|softgels?|units?)\b/);
  if (m2) {
    const qty = parseInt(m2[1], 10);
    // Ignore high counts that are likely product contents, not pack qty
    // e.g., "60 capsules" means 60 capsules per bottle, not 60-pack
    if (qty <= 10) return qty;
  }

  // Phrases like "2-pack", "3pk", "2x"
  const m3 = t.match(/\b(\d+)\s*-\s*pack\b|\b(\d+)\s*pk\b|\b(\d+)x\b/);
  const n = m3 && (m3[1] || m3[2] || m3[3]);
  if (n) {
    const qty = parseInt(n, 10);
    if (qty <= 10) return qty;
  }

  return 1;
}

/**
 * Extract size/volume from text (e.g., "8 oz", "226.8 g", "60 capsules")
 * Returns normalized string for matching (e.g., "8oz", "226.8g", "60cap")
 */
function detectSize(text: string | undefined): string | null {
  if (!text) return null;
  const t = text.toLowerCase();

  // Match: "8 oz", "8oz", "8 fl oz", "226.8 g", "60 capsules", "2 fl oz", etc.
  const sizePatterns = [
    /\b(\d+\.?\d*)\s*fl\s*oz\b/,           // "8 fl oz"
    /\b(\d+\.?\d*)\s*oz\b/,                // "8 oz"
    /\b(\d+\.?\d*)\s*g\b/,                 // "226.8 g"
    /\b(\d+\.?\d*)\s*mg\b/,                // "500 mg"
    /\b(\d+\.?\d*)\s*ml\b/,                // "30 ml"
    /\b(\d+)\s*capsules?\b/,                // "60 capsules"
    /\b(\d+)\s*softgels?\b/,                // "120 softgels"
    /\b(\d+)\s*tablets?\b/,                 // "90 tablets"
    /\b(\d+)\s*ct\b/,                       // "30 ct"
  ];

  for (const pattern of sizePatterns) {
    const match = t.match(pattern);
    if (match) {
      // Return normalized format: "8oz", "226.8g", "60cap"
      const value = match[1];
      if (pattern.source.includes('fl\\s*oz')) return `${value}floz`;
      if (pattern.source.includes('oz')) return `${value}oz`;
      if (pattern.source.includes('\\s*g')) return `${value}g`;
      if (pattern.source.includes('mg')) return `${value}mg`;
      if (pattern.source.includes('ml')) return `${value}ml`;
      if (pattern.source.includes('capsule')) return `${value}cap`;
      if (pattern.source.includes('softgel')) return `${value}cap`;
      if (pattern.source.includes('tablet')) return `${value}cap`;
      if (pattern.source.includes('ct')) return `${value}ct`;
    }
  }

  return null;
}

/**
 * Pick best offer: prefer size match, then single-unit, else lowest unit price
 */
function pickBestOffer(candidates: OfferCandidate[], requestedSize?: string | null): OfferCandidate | null {
  if (!candidates.length) return null;

  // If we have a requested size, strongly prefer offers that match it
  if (requestedSize) {
    const sizeMatches = candidates.filter(c => c.size === requestedSize);
    if (sizeMatches.length) {
      console.log(`[HTML Parser] Found ${sizeMatches.length} offer(s) matching size "${requestedSize}"`);
      // Among size matches, prefer single-unit, then lowest price
      const singleSizeMatches = sizeMatches.filter(c => c.packQty === 1);
      if (singleSizeMatches.length) {
        return singleSizeMatches.reduce((best, c) => (c.price < best.price ? c : best), singleSizeMatches[0]);
      }
      return sizeMatches.reduce((best, c) => (c.unitPrice < best.unitPrice ? c : best), sizeMatches[0]);
    }
    console.log(`[HTML Parser] ⚠️  No offers match requested size "${requestedSize}", falling back to best available`);
  }

  const singles = candidates.filter(c => c.packQty === 1);
  if (singles.length) {
    // Among single-unit options, pick the lowest price
    return singles.reduce((best, c) => (c.price < best.price ? c : best), singles[0]);
  }

  // No clear single-unit: pick lowest *unit* price to avoid 2-pack inflation
  return candidates.reduce((best, c) => (c.unitPrice < best.unitPrice ? c : best), candidates[0]);
}

/**
 * Best-effort JSON-LD extraction for brand sites
 * No retailer-specific logic - just try to find Product schema and extract price
 */
function extractFromJsonLd($: cheerio.CheerioAPI, requestedSize?: string | null): ExtractedData {
  const scripts = $('script[type="application/ld+json"]').toArray();
  
  if (scripts.length === 0) {
    console.log(`[HTML Parser] No JSON-LD scripts found`);
    return { price: null };
  }
  
  console.log(`[HTML Parser] Found ${scripts.length} JSON-LD script(s), attempting extraction...`);
  
  const allCandidates: OfferCandidate[] = [];
  
  for (const node of scripts) {
    try {
      const raw = $(node).text().trim();
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      
      // Handle both arrays and @graph wrappers
      let items: any[] = [];
      if (Array.isArray(parsed)) {
        items = parsed;
      } else if (parsed["@graph"] && Array.isArray(parsed["@graph"])) {
        items = parsed["@graph"];
      } else {
        items = [parsed];
      }
      
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const type = String((item as any)["@type"] || "").toLowerCase();
        
        console.log(`[HTML Parser] Processing @type: ${type}`);
        
        // Handle ProductGroup with hasVariant (e.g., Shopify multi-variant products)
        if (type.includes("productgroup")) {
          const productName = String((item as any).name || '');
          const variants = (item as any).hasVariant;
          
          if (Array.isArray(variants)) {
            console.log(`[HTML Parser] Found ProductGroup with ${variants.length} variants`);
            
            for (const variant of variants) {
              if (!variant || typeof variant !== "object") continue;
              const variantName = String(variant.name || productName);
              const offers = variant.offers;
              const offerList = Array.isArray(offers) ? offers : [offers];
              
              for (const offer of offerList) {
                if (!offer || typeof offer !== "object") continue;
                const priceValue = toNumber((offer as any).price);
                if (!priceValue) continue;
                
                const currency = String((offer as any).priceCurrency || 'USD');
                const packQty = detectPackQty(variantName) || 1;
                const size = detectSize(variantName);
                const unitPrice = priceValue / packQty;
                
                allCandidates.push({
                  price: priceValue,
                  currency,
                  nameText: variantName,
                  descriptionText: undefined,
                  rawOffer: offer,
                  packQty,
                  unitPrice,
                  size
                });
              }
            }
            continue; // Skip standard Product parsing for this item
          }
        }
        
        if (!type.includes("product")) continue;
        
        const productName = String((item as any).name || '');
        const productDescription = String((item as any).description || '');
        
        // Found a Product schema - try to extract price from offers
        const offers = (item as any).offers;
        if (!offers) continue;
        const offerList = Array.isArray(offers) ? offers : [offers];
        
        // Build candidates from all offers
        for (const offer of offerList) {
          if (!offer || typeof offer !== "object") continue;
          
          // Handle priceSpecification as array OR object (Root Brands uses array)
          const priceSpec = (offer as any).priceSpecification;
          
          // If priceSpec is an array, extract ALL prices (not just first)
          // Root Brands lists bulk/wholesale first, retail prices after
          const pricesFromSpec: number[] = [];
          if (Array.isArray(priceSpec)) {
            for (const spec of priceSpec) {
              const p = toNumber(spec?.price);
              if (p) pricesFromSpec.push(p);
            }
          } else if (priceSpec) {
            const p = toNumber(priceSpec?.price);
            if (p) pricesFromSpec.push(p);
          }
          
          // Also check top-level price fields
          const topPrice = toNumber((offer as any).price) ?? toNumber((offer as any).lowPrice);
          if (topPrice) pricesFromSpec.push(topPrice);
          
          // Create a candidate for EACH price found
          for (const priceValue of pricesFromSpec) {
            const nameText = String((offer as any).name || productName);
            const descText = String((offer as any).description || productDescription);
            const currency = String((offer as any).priceCurrency || 'USD');
            
            const packQty = detectPackQty(nameText) || detectPackQty(descText) || 1;
            const size = detectSize(nameText) || detectSize(descText) || detectSize(productName);
            const unitPrice = priceValue / packQty;
            
            allCandidates.push({
              price: priceValue,
              currency,
              nameText,
              descriptionText: descText,
              rawOffer: offer,
              packQty,
              unitPrice,
              size
            });
          }
        }
      }
    } catch (err) {
      // Invalid JSON - skip this script
      continue;
    }
  }
  
  if (allCandidates.length === 0) {
    console.log(`[HTML Parser] No price found in JSON-LD`);
    return { price: null };
  }
  
  // Log all candidates for debugging
  console.log('[HTML Parser] JSON-LD offers:', allCandidates.map(c => ({
    price: c.price,
    packQty: c.packQty,
    unitPrice: c.unitPrice,
    name: c.nameText?.slice(0, 80)
  })));
  
  // Filter out unrealistic bulk/wholesale prices (>$500 for supplements/beauty)
  const retailCandidates = allCandidates.filter(c => c.price <= 500);
  
  if (retailCandidates.length === 0) {
    const prices = allCandidates.map(c => c.price).join(', ');
    console.log(`[HTML Parser] All prices rejected as bulk/wholesale (>$500): ${prices}`);
    return { price: -1 }; // -1 signals rejection (don't fallback to other parsers)
  }
  
  // Pick the best offer (prefer size match, then single-unit, else lowest unit price)
  const best = pickBestOffer(retailCandidates, requestedSize);
  
  if (!best) {
    return { price: null };
  }
  
  console.log('[HTML Parser] Chosen offer:', {
    price: best.price,
    packQty: best.packQty,
    unitPrice: best.unitPrice,
    size: best.size,
    name: best.nameText?.slice(0, 80)
  });
  
  const sizeMsg = best.size ? ` size: ${best.size},` : '';
  console.log(`[HTML Parser] ✓ Extracted price $${best.price} from JSON-LD Product (${best.packQty}-pack,${sizeMsg} unit price: $${best.unitPrice.toFixed(2)})`);
  
  return { price: best.price };
}

function extractFromOpenGraph($: cheerio.CheerioAPI): number | null {
  const og =
    $(
      'meta[property="product:price:amount"], meta[property="og:price:amount"], meta[name="product:price:amount"], meta[name="og:price:amount"]'
    ).attr("content") || "";
  return og ? toNumber(og) : null;
}

function extractFromBody($: cheerio.CheerioAPI, packInfo?: { isMultiPack: boolean; packSize?: number }): number | null {
  const bodyText = $.root().text().replace(/\s+/g, " ");
  
  // Use passed pack info or detect locally if not provided
  const multiPackInfo = packInfo || detectMultiPack($);
  const packSize = multiPackInfo.packSize || 1;
  
  if (multiPackInfo.isMultiPack) {
    console.log(`[HTML Parser] ⚠️ Multi-pack detected (${packSize}-pack). Will divide extracted price by pack quantity.`);
  }
  
  // First try: Look for price in context of common keywords
  const targeted = bodyText.match(/(?:price|buy|order)[^$]{0,60}\$\s?(\d{1,4}(?:\.\d{2})?)/i);
  if (targeted) {
    let price = toNumber(targeted[1]);
    if (price && price >= 15) {
      // Divide by pack size if multi-pack
      if (multiPackInfo.isMultiPack && packSize > 1) {
        const originalPrice = price;
        price = price / packSize;
        console.log(`[HTML Parser] Adjusted multi-pack price: $${originalPrice} / ${packSize} = $${price.toFixed(2)} per unit`);
      }
      return price;
    }
  }
  
  // Second try: Extract all dollar amounts and filter
  const allMatches = bodyText.match(/\$\s?(\d{1,4}(?:\.\d{2})?)/g);
  if (allMatches) {
    const allPrices = allMatches
      .map(m => m.replace(/\$/g, '').trim())
      .map(m => toNumber(m))
      .filter((p): p is number => p !== null && p >= 15 && p <= 500); // Filter out discounts/fees (<$15)
    
    if (allPrices.length > 0) {
      // Prefer retail-formatted prices (.95 or .99) over round numbers
      const retailPrices = allPrices.filter(p => {
        const cents = Math.round((p % 1) * 100);
        return cents === 95 || cents === 99;
      });
      
      let extractedPrice: number;
      if (retailPrices.length > 0) {
        console.log(`[HTML Parser] Found ${allPrices.length} prices (>=$15), using lowest retail-formatted (.95/.99): $${Math.min(...retailPrices)}`);
        extractedPrice = Math.min(...retailPrices);
      } else {
        // Fallback: Return lowest price if no retail formatting found
        console.log(`[HTML Parser] Found ${allPrices.length} prices (>=$15), no retail formatting found, using lowest: $${Math.min(...allPrices)}`);
        extractedPrice = Math.min(...allPrices);
      }
      
      // Divide by pack size if multi-pack
      if (multiPackInfo.isMultiPack && packSize > 1) {
        const originalPrice = extractedPrice;
        extractedPrice = extractedPrice / packSize;
        console.log(`[HTML Parser] Adjusted multi-pack price: $${originalPrice} / ${packSize} = $${extractedPrice.toFixed(2)} per unit`);
      }
      
      return extractedPrice;
    }
  }
  
  return null;
}

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

export function extractPriceFromHtml(html: string, productTitle?: string): number | null {
  try {
    // Check for bundle/subscription page FIRST before parsing
    if (isProbablyBundlePage(html)) {
      console.log('[HTML Parser] ⚠️ Bundle/subscription indicators found, skipping this URL as price source');
      return null;
    }
    
    const $ = cheerio.load(html);
    
    // Extract requested size from product title if provided
    const requestedSize = productTitle ? detectSize(productTitle) : null;
    if (requestedSize) {
      console.log(`[HTML Parser] Looking for variant with size: ${requestedSize}`);
    }
    
    // Check for multi-pack products
    const packInfo = detectMultiPack($);
    if (packInfo.isMultiPack) {
      const packMsg = packInfo.packSize 
        ? `${packInfo.packSize}-pack`
        : 'multi-pack';
      console.log(`[HTML Parser] ⚠️ WARNING: Detected ${packMsg} product - price may not be for single unit!`);
    }
    
    const data = extractFromJsonLd($, requestedSize);
    
    // If JSON-LD explicitly rejected prices (returned -1), don't fallback
    if (data.price === -1) return null;
    
    // Pass pack info to body extraction
    return data.price ?? extractFromOpenGraph($) ?? extractFromBody($, packInfo);
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
