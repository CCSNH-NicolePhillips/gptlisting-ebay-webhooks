import * as cheerio from "cheerio";

// Currency conversion rates (approximate, updated periodically)
const CURRENCY_TO_USD: Record<string, number> = {
  USD: 1.0,
  AUD: 0.65,  // Australian Dollar
  CAD: 0.74,  // Canadian Dollar
  EUR: 1.08,  // Euro
  GBP: 1.27,  // British Pound
  NZD: 0.60,  // New Zealand Dollar
};

/**
 * Convert a price from one currency to USD
 */
function convertToUSD(price: number, currency: string): number {
  const curr = currency.toUpperCase();
  const rate = CURRENCY_TO_USD[curr];
  
  if (!rate) {
    console.warn(`[HTML Parser] Unknown currency: ${currency}, assuming USD`);
    return price;
  }
  
  if (curr === 'USD') {
    return price;
  }
  
  const converted = price * rate;
  console.log(`[HTML Parser] Currency conversion: ${currency} ${price.toFixed(2)} → USD ${converted.toFixed(2)} (rate: ${rate})`);
  return converted;
}

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
 * Detect units sold (pack quantity) from product title/h1 ONLY.
 * This is separate from "contents" (60 capsules, 8 oz, etc.)
 * 
 * ONLY matches explicit pack language:
 * - "2-pack", "2 pack", "pack of 2"
 * - "bundle of 2", "set of 2"
 * - "2 bottles" (when selling multiple bottles together)
 * 
 * Does NOT match:
 * - Product contents: "60 capsules", "90 count", "120 softgels"
 * - Size specifications: "8 oz", "1.3 lb", "30 ml"
 * - Serving counts: "30 servings"
 * 
 * @param titleOrH1 - Product title or H1 text from webpage
 * @returns Object with unitsSold (1 for single unit, 2+ for multi-packs) and evidence array
 */
export function detectUnitsSoldFromTitle(titleOrH1: string | undefined): { unitsSold: number; evidence: string[] } {
  if (!titleOrH1) return { unitsSold: 1, evidence: [] };
  
  const t = titleOrH1.toLowerCase();
  const evidence: string[] = [];
  
  // Pattern 1: "2-pack", "3-pack", etc.
  const dashPackMatch = t.match(/\b(\d+)\s*-\s*pack\b/);
  if (dashPackMatch) {
    const qty = parseInt(dashPackMatch[1], 10);
    if (qty >= 2 && qty <= 10) {
      const matched = dashPackMatch[0];
      evidence.push(`matched phrase: "${matched}"`);
      console.log(`[HTML Parser] detectUnitsSoldFromTitle: Found "${matched}" → ${qty} units`);
      return { unitsSold: qty, evidence };
    }
  }
  
  // Pattern 2: "pack of 2", "pack of 3", etc.
  const packOfMatch = t.match(/\bpack\s+of\s+(\d+)\b/);
  if (packOfMatch) {
    const qty = parseInt(packOfMatch[1], 10);
    if (qty >= 2 && qty <= 10) {
      const matched = packOfMatch[0];
      evidence.push(`matched phrase: "${matched}"`);
      console.log(`[HTML Parser] detectUnitsSoldFromTitle: Found "${matched}" → ${qty} units`);
      return { unitsSold: qty, evidence };
    }
  }
  
  // Pattern 3: "bundle of 2", "bundle of 3", etc.
  const bundleOfMatch = t.match(/\bbundle\s+of\s+(\d+)\b/);
  if (bundleOfMatch) {
    const qty = parseInt(bundleOfMatch[1], 10);
    if (qty >= 2 && qty <= 10) {
      const matched = bundleOfMatch[0];
      evidence.push(`matched phrase: "${matched}"`);
      console.log(`[HTML Parser] detectUnitsSoldFromTitle: Found "${matched}" → ${qty} units`);
      return { unitsSold: qty, evidence };
    }
  }
  
  // Pattern 4: "set of 2", "set of 3", etc.
  const setOfMatch = t.match(/\bset\s+of\s+(\d+)\b/);
  if (setOfMatch) {
    const qty = parseInt(setOfMatch[1], 10);
    if (qty >= 2 && qty <= 10) {
      const matched = setOfMatch[0];
      evidence.push(`matched phrase: "${matched}"`);
      console.log(`[HTML Parser] detectUnitsSoldFromTitle: Found "${matched}" → ${qty} units`);
      return { unitsSold: qty, evidence };
    }
  }
  
  // Pattern 5: "2 bottles", "3 bottles", etc. (when selling multiple bottles together)
  const bottlesMatch = t.match(/\b(\d+)\s+bottles?\b/);
  if (bottlesMatch) {
    const qty = parseInt(bottlesMatch[1], 10);
    if (qty >= 2 && qty <= 10) {
      const matched = bottlesMatch[0];
      evidence.push(`matched phrase: "${matched}"`);
      console.log(`[HTML Parser] detectUnitsSoldFromTitle: Found "${matched}" → ${qty} units`);
      return { unitsSold: qty, evidence };
    }
  }
  
  // Pattern 6: "2 pack" (with space)
  const spacePackMatch = t.match(/\b(\d+)\s+pack\b/);
  if (spacePackMatch) {
    const qty = parseInt(spacePackMatch[1], 10);
    if (qty >= 2 && qty <= 10) {
      const matched = spacePackMatch[0];
      evidence.push(`matched phrase: "${matched}"`);
      console.log(`[HTML Parser] detectUnitsSoldFromTitle: Found "${matched}" → ${qty} units`);
      return { unitsSold: qty, evidence };
    }
  }
  
  // Pattern 7: "(2 Pack)", "(4 Pack)" - parentheses format
  const parenPackMatch = t.match(/\((\d+)\s+pack\)/);
  if (parenPackMatch) {
    const qty = parseInt(parenPackMatch[1], 10);
    if (qty >= 2 && qty <= 10) {
      const matched = parenPackMatch[0];
      evidence.push(`matched phrase: "${matched}"`);
      console.log(`[HTML Parser] detectUnitsSoldFromTitle: Found "${matched}" → ${qty} units`);
      return { unitsSold: qty, evidence };
    }
  }
  
  // Pattern 8: "2pk", "4pk", "2pk Each", etc. (compact format)
  const compactPkMatch = t.match(/\b(\d+)pk\b/);
  if (compactPkMatch) {
    const qty = parseInt(compactPkMatch[1], 10);
    if (qty >= 2 && qty <= 10) {
      const matched = compactPkMatch[0];
      evidence.push(`matched phrase: "${matched}"`);
      console.log(`[HTML Parser] detectUnitsSoldFromTitle: Found "${matched}" → ${qty} units`);
      return { unitsSold: qty, evidence };
    }
  }
  
  console.log(`[HTML Parser] detectUnitsSoldFromTitle: No pack indicators found → 1 unit`);
  console.log(`[HTML Parser] detectUnitsSoldFromTitle: DEBUG - First 300 chars of input: "${titleOrH1?.slice(0, 300)}"`);
  return { unitsSold: 1, evidence: [] };
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
 * 
 * Returns:
 * - { price: number } if valid price found
 * - { price: -1, skipOpenGraph: true } if all prices rejected (bulk/subscription only)
 * - { price: null } if no prices found
 */
function extractFromJsonLd($: cheerio.CheerioAPI, requestedSize?: string | null): ExtractedData & { skipOpenGraph?: boolean } {
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
                
                // Convert to USD if necessary
                const priceUSD = convertToUSD(priceValue, currency);
                
                const packQty = detectPackQty(variantName) || 1;
                const size = detectSize(variantName);
                const unitPrice = priceUSD / packQty;
                
                allCandidates.push({
                  price: priceUSD,
                  currency: 'USD', // Always store as USD after conversion
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
            
            // Convert to USD if necessary
            const priceUSD = convertToUSD(priceValue, currency);
            
            const packQty = detectPackQty(nameText) || detectPackQty(descText) || 1;
            const size = detectSize(nameText) || detectSize(descText) || detectSize(productName);
            const unitPrice = priceUSD / packQty;
            
            allCandidates.push({
              price: priceUSD,
              currency: 'USD', // Always store as USD after conversion
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
  
  // Filter out subscription offers (we want one-time purchase prices)
  const nonSubscriptionCandidates = allCandidates.filter(c => {
    const nameText = (c.nameText || '').toLowerCase();
    const descText = (c.descriptionText || '').toLowerCase();
    const isSubscription = nameText.includes('subscription') || 
                          nameText.includes('subscribe') || 
                          descText.includes('subscription') || 
                          descText.includes('subscribe');
    return !isSubscription;
  });
  
  if (allCandidates.length > 0 && nonSubscriptionCandidates.length === 0) {
    console.log(`[HTML Parser] All ${allCandidates.length} offer(s) are subscription-only, falling back to other methods`);
    return { price: null, skipOpenGraph: true }; // Skip OpenGraph (likely has subscription price) and go to body parsing
  }
  
  if (nonSubscriptionCandidates.length > 0 && nonSubscriptionCandidates.length < allCandidates.length) {
    console.log(`[HTML Parser] Filtered out ${allCandidates.length - nonSubscriptionCandidates.length} subscription offer(s)`);
  }
  
  // Use non-subscription candidates
  const candidatesToUse = nonSubscriptionCandidates.length > 0 ? nonSubscriptionCandidates : allCandidates;
  
  // Filter out unrealistic bulk/wholesale prices (>$500 for supplements/beauty)
  const retailCandidates = candidatesToUse.filter(c => c.price <= 500);
  
  if (retailCandidates.length === 0) {
    const prices = allCandidates.map(c => c.price).join(', ');
    console.log(`[HTML Parser] All prices rejected as bulk/wholesale (>$500): ${prices}`);
    return { price: -1, skipOpenGraph: true }; // -1 signals rejection (don't fallback)
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
  const price = og ? toNumber(og) : null;
  if (price) {
    console.log(`[HTML Parser] Found OpenGraph price: $${price}`);
  } else {
    console.log(`[HTML Parser] No OpenGraph price found`);
  }
  return price;
}

function extractFromBody($: cheerio.CheerioAPI, packInfo?: { isMultiPack: boolean; packSize?: number }, productTitle?: string): number | null {
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
    const price = toNumber(targeted[1]);
    console.log(`[HTML Parser] Targeted match found: $${price} (full match: "${targeted[0].slice(0, 80)}...")`);
    if (price && price >= 15) {
      // CHUNK 3: No division here - normalization happens in extractPriceFromHtml
      return price;
    }
  }
  
  // Try to find JSON-style price attributes (common in Shopify/e-commerce sites)
  // Look for patterns like: "price":"39.95" or price:39.95 or "price":39.95
  const jsonPricePattern = /"price"\s*:\s*"?(\d+\.\d{2})"?/gi;
  const jsonMatches = [...bodyText.matchAll(jsonPricePattern)];
  if (jsonMatches.length > 0) {
    const jsonPrices = jsonMatches
      .map(m => toNumber(m[1]))
      .filter((p): p is number => p !== null && p >= 15 && p <= 500);
    
    if (jsonPrices.length > 0) {
      console.log(`[HTML Parser] Found ${jsonPrices.length} JSON-style prices: [${jsonPrices.slice(0, 10).join(', ')}]`);
      
      // Prefer retail-formatted prices (.95 or .99)
      const retailJsonPrices = jsonPrices.filter(p => {
        const cents = Math.round((p % 1) * 100);
        return cents === 95 || cents === 99;
      });
      
      if (retailJsonPrices.length > 0) {
        // Deduplicate and sort
        const uniquePrices = [...new Set(retailJsonPrices)].sort((a, b) => a - b);
        console.log(`[HTML Parser] Unique retail-formatted JSON prices: [${uniquePrices.join(', ')}]`);
        
        // Try to find price near the product title if provided
        if (productTitle) {
          // Look for product title in context of price
          const titleWords = productTitle.toLowerCase().split(/\s+/).filter(w => w.length > 3);
          for (const price of uniquePrices) {
            const pricePattern = new RegExp(`"price"\\s*:\\s*"?${price.toFixed(2)}"?`, 'gi');
            const matches = [...bodyText.matchAll(pricePattern)];
            for (const match of matches) {
              const contextStart = Math.max(0, match.index! - 300);
              const contextEnd = Math.min(bodyText.length, match.index! + 100);
              const context = bodyText.substring(contextStart, contextEnd).toLowerCase();
              
              // Check if product title words appear near this price
              const matchCount = titleWords.filter(word => context.includes(word)).length;
              if (matchCount >= 2) {
                console.log(`[HTML Parser] Found price $${price} near product title (${matchCount} words matched)`);
                return price;
              }
            }
          }
          console.log(`[HTML Parser] No JSON price found near product title, using highest (likely main product)`);
        }
        
        // If no product title or no match, use highest price (often the main product, subscriptions are discounted)
        const chosen = uniquePrices[uniquePrices.length - 1];
        console.log(`[HTML Parser] Using JSON-style price: $${chosen} (from ${uniquePrices.length} retail-formatted options)`);
        return chosen;
      }
    }
  }
  
  // Second try: Extract all dollar amounts and filter
  const allMatches = bodyText.match(/\$\s?(\d{1,4}(?:\.\d{2})?)/g);
  console.log(`[HTML Parser] Looking for all $ amounts in body text...`);
  if (allMatches) {
    console.log(`[HTML Parser] Found ${allMatches.length} $-prefixed prices in body`);
    const allPrices = allMatches
      .map(m => m.replace(/\$/g, '').trim())
      .map(m => toNumber(m))
      .filter((p): p is number => p !== null && p >= 15 && p <= 500); // Filter out discounts/fees (<$15)
    
    console.log(`[HTML Parser] After filtering (>=$15, <=$500): ${allPrices.length} prices - [${allPrices.slice(0, 10).join(', ')}${allPrices.length > 10 ? '...' : ''}]`);
    
    if (allPrices.length > 0) {
      // Prefer retail-formatted prices (.95 or .99) over round numbers
      const retailPrices = allPrices.filter(p => {
        const cents = Math.round((p % 1) * 100);
        return cents === 95 || cents === 99;
      });
      
      console.log(`[HTML Parser] Retail-formatted (.95/.99) prices: ${retailPrices.length} - [${retailPrices.slice(0, 10).join(', ')}${retailPrices.length > 10 ? '...' : ''}]`);
      
      const extractedPrice: number = retailPrices.length > 0 
        ? Math.min(...retailPrices)
        : Math.min(...allPrices);
      
      if (retailPrices.length > 0) {
        console.log(`[HTML Parser] Found ${allPrices.length} prices (>=$15), using lowest retail-formatted (.95/.99): $${extractedPrice}`);
      } else {
        console.log(`[HTML Parser] Found ${allPrices.length} prices (>=$15), no retail formatting found, using lowest: $${extractedPrice}`);
      }
      
      // CHUNK 3: No division here - normalization happens in extractPriceFromHtml
      return extractedPrice;
    }
  }
  
  return null;
}

/**
 * Detect if the product is a multi-pack/bundle based on title and text
 */
function detectMultiPack($: cheerio.CheerioAPI): { isMultiPack: boolean; packSize?: number } {
  const title = $('title').text();
  const h1 = $('h1').first().text();
  const productText = `${title} ${h1}`;
  
  console.log(`[HTML Parser] detectMultiPack - title: "${title.slice(0, 200)}"`);
  console.log(`[HTML Parser] detectMultiPack - h1: "${h1.slice(0, 200)}"`);
  
  // Common multi-pack indicators (case-insensitive)
  const packPatterns = [
    /\((\d+)\s*pack\)/i,   // "(2 Pack)" or "(4 Pack)" - Amazon format
    /\b(\d+)pk\b/i,        // "2pk", "4pk" - compact format
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
      console.log(`[HTML Parser] detectMultiPack - matched pattern: ${pattern} → "${match[0]}"`);
      
      // Extract pack size if available
      const packSize = match[1] ? parseInt(match[1], 10) : undefined;
      
      // Special cases
      if (/twin|double/i.test(match[0])) return { isMultiPack: true, packSize: 2 };
      if (/triple/i.test(match[0])) return { isMultiPack: true, packSize: 3 };
      
      console.log(`[HTML Parser] detectMultiPack - result: isMultiPack=true, packSize=${packSize}`);
      return { isMultiPack: true, packSize };
    }
  }
  
  console.log(`[HTML Parser] detectMultiPack - no pack indicators found`);
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
    
    // Extract title/h1 text for unitsSold detection
    const pageTitle = $('title').text();
    const h1Text = $('h1').first().text();
    const titleForUnitsSold = pageTitle || h1Text || productTitle;
    
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
    
    // If JSON-LD says to skip OpenGraph (e.g., subscription-only), skip it
    const openGraphPrice = data.skipOpenGraph ? null : extractFromOpenGraph($);
    
    // Pass pack info and product title to body extraction
    const rawPrice = data.price ?? openGraphPrice ?? extractFromBody($, packInfo, productTitle);
    
    // If no price found, return null
    if (rawPrice === null) return null;
    
    // CHUNK 2 & 4: Calculate unitsSold and normalize price
    const { unitsSold, evidence } = detectUnitsSoldFromTitle(titleForUnitsSold);
    
    let normalizedPrice = rawPrice;
    if (unitsSold > 1) {
      normalizedPrice = rawPrice / unitsSold;
      const evidenceStr = evidence.length > 0 ? ` | Evidence: [${evidence.join(', ')}]` : '';
      console.log(`[HTML Parser] 📦 Raw price: $${rawPrice.toFixed(2)} | Units sold: ${unitsSold} | Normalized price: $${normalizedPrice.toFixed(2)}${evidenceStr}`);
    } else {
      console.log(`[HTML Parser] 📦 Raw price: $${rawPrice.toFixed(2)} | Units sold: 1 | Normalized price: $${normalizedPrice.toFixed(2)} (no adjustment)`);
    }
    
    return normalizedPrice;
  } catch {
    return null;
  }
}

/**
 * @deprecated Use extractPriceFromHtml instead - productType extraction removed
 * COMMENTED OUT - Not used anywhere in codebase (verified Dec 2025)
 */
/* istanbul ignore next */
// export function extractPriceAndTypeFromHtml(html: string): ExtractedData {
//   console.warn('[HTML Parser] extractPriceAndTypeFromHtml is deprecated, use extractPriceFromHtml');
//   try {
//     const $ = cheerio.load(html);
//     const data = extractFromJsonLd($);
//     if (data.price) return data;
//     const price = extractFromOpenGraph($) ?? extractFromBody($);
//     return { price };
//   } catch {
//     return { price: null };
//   }
// }
