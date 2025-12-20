import { extractPriceFromHtml, extractPriceWithShipping } from "./html-price.js";
import { braveFirstUrlForBrandSite, braveFirstUrl } from "./search.js";
import { getBrandUrls, setBrandUrls } from "./brand-map.js";
import { fetchSoldPriceStats, type SoldPriceStats } from "./pricing/ebay-sold-prices.js";
import { openai } from "./openai.js";
import { getCachedPrice, setCachedPrice, makePriceSig } from "./price-cache.js";
import { computeEbayItemPrice } from "./pricing-compute.js";
import { getDefaultPricingSettings, type PricingSettings } from "./pricing-config.js";

// ============================================================================
// URL VARIATION HELPERS
// ============================================================================

/**
 * Generate common URL variations for a product page
 * Handles different URL patterns:
 * - /zero-in.html → /product/zero-in/, /products/zero-in/, /zero-in-supplement.html, etc.
 * - /product-name/ → /product-name.html, /products/product-name/, etc.
 */
function generateUrlVariations(url: string): string[] {
  try {
    const urlObj = new URL(url);
    const path = urlObj.pathname;
    const variations: string[] = [];
    
    // Extract base path and filename
    const lastSlash = path.lastIndexOf('/');
    const basePath = path.substring(0, lastSlash + 1);
    const filename = path.substring(lastSlash + 1);
    const dotIndex = filename.lastIndexOf('.');
    const ext = dotIndex > 0 ? filename.substring(dotIndex) : '';
    const base = dotIndex > 0 ? filename.substring(0, dotIndex) : filename;
    
    // Pattern 1: If URL is /product-name.html, try /product/product-name/ and /products/product-name/
    if (ext === '.html') {
      variations.push(`${urlObj.origin}/product/${base}/`);
      variations.push(`${urlObj.origin}/products/${base}/`);
      variations.push(`${urlObj.origin}/shop/${base}/`);
    }
    
    // Pattern 2: If URL is /product-name/, try /product-name.html
    if (!ext && base) {
      variations.push(`${urlObj.origin}${basePath}${base}.html`);
      variations.push(`${urlObj.origin}${basePath}${base}.php`);
    }
    
    // Pattern 3: Try common suffix variations
    const suffixes = ['-supplement', '-sports-drink', '-product', '-capsules', '-formula'];
    for (const suffix of suffixes) {
      if (ext) {
        variations.push(`${urlObj.origin}${basePath}${base}${suffix}${ext}`);
      } else {
        variations.push(`${urlObj.origin}${basePath}${base}${suffix}/`);
      }
    }
    
    // Pattern 4: Try common path prefixes
    if (!path.startsWith('/product/') && !path.startsWith('/products/') && !path.startsWith('/shop/')) {
      if (ext) {
        variations.push(`${urlObj.origin}/product/${filename}`);
        variations.push(`${urlObj.origin}/products/${filename}`);
      } else if (base) {
        variations.push(`${urlObj.origin}/product/${base}/`);
        variations.push(`${urlObj.origin}/products/${base}/`);
      }
    }
    
    return variations;
  } catch {
    return [];
  }
}

// ============================================================================
// NEW TIERED PRICING ENGINE
// ============================================================================

export interface PriceLookupInput {
  title: string;
  brand?: string;
  brandWebsite?: string; // Official brand website URL from Vision API
  upc?: string;
  condition?: 'NEW' | 'USED' | 'OTHER';
  quantity?: number;
  keyText?: string[]; // Text extracted from packaging (helps refine searches)
  categoryPath?: string; // Category from Vision API (e.g., "Dietary Supplement")
  photoQuantity?: number; // How many physical products visible in photo (from vision analysis)
  amazonPackSize?: number; // Pack size detected from Amazon product page (e.g., 2 for "2-pack")
  pricingSettings?: PricingSettings; // Phase 3: User-configurable pricing settings
}

export type PriceSource = 'ebay-sold' | 'brand-msrp' | 'brave-fallback' | 'estimate';

export interface PriceSourceDetail {
  source: PriceSource;
  price: number;
  currency: string;
  url?: string;
  notes?: string;
  shippingCents?: number; // Phase 3: Amazon shipping cost in cents (0 for free shipping)
  matchesBrand?: boolean; // Whether this price signal matches the requested brand (helps bundle checks)
}

export interface PriceDecision {
  ok: boolean;
  chosen?: PriceSourceDetail;
  candidates: PriceSourceDetail[];
  recommendedListingPrice?: number;
  reason?: string;
  // Cached MSRP data (not computed price)
  msrpCents?: number;
  cachedAt?: number;
}

// ============================================================================
// LEGACY SUPPORT (keep for backward compatibility)
// ============================================================================

export type MarketPrices = {
  amazon: number | null;
  walmart: number | null;
  brand: number | null;
  avg: number;
  productType?: string;
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Detect if a brand price is suspiciously high compared to marketplace price
 * This catches bundle pricing that slips past HTML text detection
 */
function isProbablyBundlePrice(brandPrice: number, comparisonPrice: number): boolean {
  if (!Number.isFinite(brandPrice) || !Number.isFinite(comparisonPrice)) return false;
  if (comparisonPrice <= 0) return false;

  const ratio = brandPrice / comparisonPrice;

  // Tunable: > 2.5x seems very likely to be a bundle or multi-pack
  // Lowered from 3.0x to catch MLM brands like Root (2.90x ratio)
  return ratio > 2.5;
}

function normalizeBrand(str?: string | null): string | null {
  if (!str) return null;
  const cleaned = str.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return cleaned || null;
}

/**
 * Helper: Fetch HTML with timeout
 * Returns { html, isDnsFailure } where isDnsFailure indicates the domain doesn't exist
 */
async function fetchHtml(url: string | null | undefined, timeoutMs = 10000): Promise<{ html: string | null; isDnsFailure: boolean }> {
  if (!url) return { html: null, isDnsFailure: false };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
      },
    });
    clearTimeout(timer);
    if (!res.ok) return { html: null, isDnsFailure: false };
    const html = await res.text();
    return { html, isDnsFailure: false };
  } catch (err: any) {
    const isDnsFailure = err?.cause?.code === 'ENOTFOUND';
    console.warn("fetchHtml failed", { url, err });
    return { html: null, isDnsFailure };
  }
}

/**
 * Helper: Extract price from URL
 * Returns { price, isDnsFailure } where isDnsFailure indicates the domain doesn't exist
 */
async function priceFrom(url: string | null | undefined): Promise<{ price: number | null; isDnsFailure: boolean }> {
  const { html, isDnsFailure } = await fetchHtml(url);
  if (!html) return { price: null, isDnsFailure };
  const price = extractPriceFromHtml(html);
  return { price, isDnsFailure };
}

/**
 * Detect if a webpage likely has JavaScript-rendered prices by checking for common JS frameworks
 * and price-related JS patterns while the HTML extraction failed
 */
function detectJsRenderedPrices(html: string): boolean {
  const htmlLower = html.toLowerCase();
  
  // Check for JS frameworks commonly used for dynamic pricing
  const jsFrameworks = [
    'react',
    'vue.js',
    'angular',
    'shopify',
    'woocommerce',
    'magento'
  ];
  
  // Check for price-related JS variables/functions
  const jsPricePatterns = [
    'price:',
    '"price"',
    'productprice',
    'itemprice',
    'window.price',
    'data-price'
  ];
  
  const hasJsFramework = jsFrameworks.some(fw => htmlLower.includes(fw));
  const hasJsPriceCode = jsPricePatterns.some(pattern => htmlLower.includes(pattern));
  
  return hasJsFramework && hasJsPriceCode;
}

/**
 * Extract price from brand URL with JS detection and metadata storage
 * If HTML extraction fails but page shows JS indicators, mark brand as requiresJs=true
 */
async function extractPriceFromBrand(
  url: string,
  brandName?: string,
  productTitle?: string
): Promise<number | null> {
  const { html, isDnsFailure } = await fetchHtml(url);
  
  if (!html) {
    if (isDnsFailure) {
      console.log(`[price] DNS lookup failed for ${url}`);
    }
    return null;
  }
  
  const price = extractPriceFromHtml(html, productTitle);
  
  // If extraction failed, check if prices are likely JS-rendered
  if (!price && detectJsRenderedPrices(html)) {
    console.log(`[price] ⚠️ Price extraction failed but detected JS-rendered prices on ${url}`);
    
    // Store this brand as requiring JS extraction in future
    if (brandName) {
      const signature = [brandName, productTitle].filter(Boolean).join(' ').trim();
      const existingUrls = await getBrandUrls(signature);
      
      await setBrandUrls(signature, {
        ...existingUrls,
        brand: url,
        requiresJs: true,
        lastChecked: Date.now()
      });
      
      console.log(`[price] ✓ Stored brand metadata: ${brandName} requires JS extraction`);
    }
    
    // TODO: Implement GPT-4 Vision or Playwright extraction for JS pages
    // For now, return null and let tiered system handle it
    return null;
  }
  
  return price;
}

/**
 * Helper: Check if URL is a retailer
 */
function isRetailerUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return /amazon\.com|walmart\.com/i.test(url);
}

// ============================================================================
// TIERED PRICING ENGINE - MAIN ENTRY POINT
// ============================================================================

/**
 * AI-powered price arbitration
 * Takes multiple price candidates and uses GPT-4o-mini to decide optimal listing price
 */
async function decideFinalPrice(
  input: PriceLookupInput,
  candidates: PriceSourceDetail[],
  soldStats?: SoldPriceStats
): Promise<PriceDecision> {
  if (candidates.length === 0) {
    return {
      ok: false,
      candidates: [],
      reason: 'no-price-signals'
    };
  }

  // Build structured prompt for AI
  const prompt = `You are a pricing expert for eBay listings. Analyze the following price data and recommend the optimal listing price.

PRODUCT INFORMATION:
- Title: ${input.title}
${input.brand ? `- Brand: ${input.brand}` : ''}
${input.upc ? `- UPC: ${input.upc}` : ''}
${input.condition ? `- Condition: ${input.condition}` : ''}
${input.quantity ? `- Quantity: ${input.quantity}` : ''}

AVAILABLE PRICE DATA:
${candidates.map((c, i) => `${i + 1}. ${c.source}: $${c.price.toFixed(2)} (${c.notes || 'no notes'})`).join('\n')}

${soldStats && soldStats.ok ? `
RECENT SOLD PRICES (last 30 days):
- Median: $${soldStats.median?.toFixed(2) || 'N/A'}
- 35th percentile: $${soldStats.p35?.toFixed(2) || 'N/A'}
- 10th percentile: $${soldStats.p10?.toFixed(2) || 'N/A'}
- 90th percentile: $${soldStats.p90?.toFixed(2) || 'N/A'}
- Sample count: ${soldStats.samples.length}
` : ''}

PRICING RULES:
1. **ALWAYS prefer brand MSRP if available** - this is the retail price we'll discount
2. Only use eBay sold prices if NO brand MSRP is available
3. If using eBay sold price, return it as basePrice (already competitive)
4. Never pick a price below 50% of brand MSRP (prevents undervaluing new products)
5. For used items, eBay sold data is more reliable than MSRP

IMPORTANT: Return the BASE/RETAIL price as both basePrice and recommendedListingPrice.
Do NOT apply discounts yourself - the system will apply competitive pricing automatically.

RESPONSE FORMAT (JSON only):
{
  "chosenSource": "ebay-sold" | "brand-msrp" | "brave-fallback",
  "basePrice": <number>,
  "recommendedListingPrice": <number>,
  "reasoning": "<brief explanation of pricing decision>"
}`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      max_tokens: 500,
      response_format: { type: "json_object" },
      messages: [
        { 
          role: "system", 
          content: "You are a pricing expert. Always respond with valid JSON matching the specified format." 
        },
        { 
          role: "user", 
          content: prompt 
        },
      ],
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      console.error('[price] AI returned empty response');
      return fallbackDecision(input, candidates);
    }

    const parsed = JSON.parse(content);
    const chosenSource = parsed.chosenSource as PriceSource;
    const basePrice = parseFloat(parsed.basePrice);
    const reasoning = parsed.reasoning || 'AI decision';

    // Find the chosen candidate
    const chosen = candidates.find(c => c.source === chosenSource) || candidates[0];

    // Phase 3: Use computeEbayItemPrice with user settings
    const settings = input.pricingSettings || {
      discountPercent: 10,
      shippingStrategy: 'DISCOUNT_ITEM_ONLY',
      templateShippingEstimateCents: 600,
      shippingSubsidyCapCents: null,
    };
    
    // CHUNK 4: Apply photoQuantity and amazonPackSize
    // Step 1: Calculate per-unit price if pack size detected
    const amazonPackSize = input.amazonPackSize || 1;
    const perUnitPrice = basePrice / amazonPackSize;
    
    // Step 2: Multiply by photoQuantity to get lot retail price
    const photoQty = input.photoQuantity || 1;
    const lotRetailPriceCents = Math.round(perUnitPrice * photoQty * 100);
    
    // Step 3: Apply competitive pricing via Phase 2 function
    const shippingCents = chosen.shippingCents || 0;
    
    const pricingResult = computeEbayItemPrice({
      amazonItemPriceCents: lotRetailPriceCents,
      amazonShippingCents: shippingCents,
      discountPercent: settings.discountPercent,
      shippingStrategy: settings.shippingStrategy,
      templateShippingEstimateCents: settings.templateShippingEstimateCents,
      shippingSubsidyCapCents: settings.shippingSubsidyCapCents,
    });
    
    const finalListingPrice = pricingResult.ebayItemPriceCents / 100;
    
    // CHUNK 5: Pricing evidence logging (always log, makes regressions obvious)
    const packEvidence = amazonPackSize > 1 
      ? `detected ${amazonPackSize}-pack` 
      : 'single unit';
    const photoEvidence = photoQty > 1 
      ? `photo shows ${photoQty} bottles` 
      : 'photo shows 1 bottle';
    
    console.log(
      `[price] 💰 PRICING EVIDENCE: ` +
      `retail=$${basePrice.toFixed(2)} | ` +
      `packSize=${amazonPackSize} (${packEvidence}) | ` +
      `photoQty=${photoQty} (${photoEvidence}) | ` +
      `perUnit=$${perUnitPrice.toFixed(2)} | ` +
      `lotRetail=$${(lotRetailPriceCents / 100).toFixed(2)} | ` +
      `shipping=$${(shippingCents / 100).toFixed(2)} | ` +
      `strategy=${settings.shippingStrategy} | ` +
      `discount=${settings.discountPercent}% | ` +
      `final=$${finalListingPrice.toFixed(2)} | ` +
      `source=${chosen.source}`
    );

    console.log(`[price] AI decision: source=${chosen.source} base=$${basePrice.toFixed(2)} final=$${finalListingPrice.toFixed(2)} | ${reasoning}`);

    return {
      ok: true,
      chosen,
      candidates,
      recommendedListingPrice: finalListingPrice,
      reason: reasoning
    };

  } catch (error) {
    console.error('[price] AI arbitration failed:', error);
    return fallbackDecision(input, candidates);
  }
}

/**
 * Fallback decision when AI fails: prefer ebay-sold p35, then brand MSRP with discount
 */
function fallbackDecision(input: PriceLookupInput, candidates: PriceSourceDetail[]): PriceDecision {
  // Prefer ebay-sold first
  const ebaySold = candidates.find(c => c.source === 'ebay-sold');
  if (ebaySold) {
    console.log(`[price] Fallback decision: using ebay-sold $${ebaySold.price.toFixed(2)}`);
    return {
      ok: true,
      chosen: ebaySold,
      candidates,
      recommendedListingPrice: ebaySold.price,
      reason: 'fallback-to-ebay-sold'
    };
  }

  // Then try brand MSRP with pricing settings (Phase 3)
  const brandMsrp = candidates.find(c => c.source === 'brand-msrp');
  if (brandMsrp) {
    // Phase 3: Use computeEbayItemPrice with user settings
    const settings = input.pricingSettings || {
      discountPercent: 10,
      shippingStrategy: 'DISCOUNT_ITEM_ONLY',
      templateShippingEstimateCents: 600,
      shippingSubsidyCapCents: null,
    };
    
    const priceCents = Math.round(brandMsrp.price * 100);
    const shippingCents = brandMsrp.shippingCents || 0;
    
    const result = computeEbayItemPrice({
      amazonItemPriceCents: priceCents,
      amazonShippingCents: shippingCents,
      discountPercent: settings.discountPercent,
      shippingStrategy: settings.shippingStrategy,
      templateShippingEstimateCents: settings.templateShippingEstimateCents,
      shippingSubsidyCapCents: settings.shippingSubsidyCapCents,
    });
    
    const finalPrice = result.ebayItemPriceCents / 100;
    
    console.log(`[price] Fallback decision: brand-msrp $${brandMsrp.price.toFixed(2)} → $${finalPrice.toFixed(2)} (${settings.shippingStrategy}, ${settings.discountPercent}% off)`);
    return {
      ok: true,
      chosen: brandMsrp,
      candidates,
      recommendedListingPrice: finalPrice,
      reason: 'fallback-to-brand-msrp-with-discount'
    };
  }

  // Last resort: use any available price
  const fallback = candidates[0];
  console.log(`[price] Fallback decision: using ${fallback.source} $${fallback.price.toFixed(2)}`);
  return {
    ok: true,
    chosen: fallback,
    candidates,
    recommendedListingPrice: fallback.price,
    reason: 'fallback-to-first-available'
  };
}

/**
 * MAIN ENTRY POINT: Tiered price lookup with AI arbitration
 * 
 * Tier 1: eBay sold/completed prices (most reliable)
 * Tier 2: Brand MSRP from official sites
 * Tier 3: AI arbitration to decide final listing price
 */
export async function lookupPrice(
  input: PriceLookupInput
): Promise<PriceDecision> {
  console.log(`[price] Starting lookup for: "${input.title}"${input.brand ? ` (${input.brand})` : ''}${input.upc ? ` [${input.upc}]` : ''}`);

  // Check cache first - cache stores MSRP data, we compute price with current user settings
  const cacheKey = makePriceSig(input.brand, input.title);
  
  try {
    const cached = await getCachedPrice(cacheKey);
    
    if (cached?.msrpCents && cached?.chosen) {
      console.log(`[price] ✓ Using cached MSRP: $${(cached.msrpCents / 100).toFixed(2)} (source: ${cached.chosen.source})`);
      
      // Compute final price using current user settings
      const settings = input.pricingSettings || getDefaultPricingSettings();
      const shippingCents = cached.chosen.shippingCents ?? settings.templateShippingEstimateCents ?? 600;
      
      const pricingResult = computeEbayItemPrice({
        amazonItemPriceCents: cached.msrpCents,
        amazonShippingCents: shippingCents,
        discountPercent: settings.discountPercent,
        shippingStrategy: settings.shippingStrategy,
        templateShippingEstimateCents: settings.templateShippingEstimateCents,
        shippingSubsidyCapCents: settings.shippingSubsidyCapCents,
      });
      
      const finalPrice = pricingResult.ebayItemPriceCents / 100;
      console.log(`[price] ✓ Computed from cached MSRP: $${finalPrice.toFixed(2)} with current user settings`);
      
      return {
        ok: true,
        chosen: cached.chosen,
        candidates: cached.candidates || [],
        recommendedListingPrice: finalPrice,
      } as PriceDecision;
    }
  } catch (error) {
    console.warn('[price] Cache read error, proceeding without cache:', error);
    // Continue with normal price lookup
  }

  const candidates: PriceSourceDetail[] = [];

  // ========================================
  // TIER 1: eBay Sold/Completed Prices
  // ========================================
  console.log('[price] Tier 1: Checking eBay sold prices...');
  
  const soldStats = await fetchSoldPriceStats({
    title: input.title,
    brand: input.brand,
    upc: input.upc,
    condition: input.condition,
    quantity: input.quantity,
  });

  if (soldStats.rateLimited) {
    console.warn('[price] ⚠️  eBay sold prices rate limited - skipping to brand MSRP');
  } else if (soldStats.ok && soldStats.p35) {
    candidates.push({
      source: 'ebay-sold',
      price: soldStats.p35,
      currency: 'USD',
      notes: `35th percentile of ${soldStats.samples.length} recent sold items`,
    });
    console.log(`[price] ✓ eBay sold price: $${soldStats.p35.toFixed(2)} (median: $${soldStats.median?.toFixed(2)})`);
  } else {
    console.log('[price] ✗ No eBay sold price data available');
  }

  // ========================================
  // TIER 2: Brand MSRP (Official Sites)
  // ========================================
  console.log('[price] Tier 2: Checking brand MSRP...');
  
  let brandPrice: number | null = null;
  let brandUrl: string | undefined;

  // FIRST: Try Vision API-provided brand website (most accurate!)
  let domainReachable = true;
  if (input.brandWebsite) {
    // Skip homepage URLs - they often show bundle/subscription prices, not individual products
    // Match: http://example.com, https://example.com, https://example.com/, http://example.com/
    const isHomepage = /^https?:\/\/[^\/]+\/?$/.test(input.brandWebsite);
    
    if (isHomepage) {
      console.log(`[price] ⚠️ Vision website is homepage (${input.brandWebsite}), skipping direct price extraction`);
    } else {
      console.log(`[price] Trying Vision API brand website: ${input.brandWebsite}`);
      
      // Use extractPriceFromBrand which handles JS detection
      brandPrice = await extractPriceFromBrand(input.brandWebsite, input.brand, input.title);
      
      if (brandPrice) {
        brandUrl = input.brandWebsite;
        console.log(`[price] ✓ Brand MSRP from Vision API website: $${brandPrice.toFixed(2)}`);
        
        // ALWAYS try URL variations to find the best (lowest) price
        // This protects against Vision AI providing wrong URLs (e.g., bundle pages, old URLs)
        const variations = generateUrlVariations(input.brandWebsite);
        let lowestPrice = brandPrice;
        let bestUrl = brandUrl;
        
        for (const variant of variations) {
          const variantPrice = await extractPriceFromBrand(variant, input.brand, input.title);
          if (variantPrice && variantPrice < lowestPrice) {
            lowestPrice = variantPrice;
            bestUrl = variant;
            console.log(`[price] ✓ Found better price via URL variation: $${variantPrice.toFixed(2)} (${variant})`);
          }
        }
        
        if (lowestPrice < brandPrice) {
          brandPrice = lowestPrice;
          brandUrl = bestUrl;
          console.log(`[price] ✓ Using lowest price $${brandPrice.toFixed(2)} from ${brandUrl}`);
        }
      } else {
        // Check if domain is reachable
        const { isDnsFailure } = await fetchHtml(input.brandWebsite);
        if (isDnsFailure) {
          console.warn(`[price] Vision domain unreachable (DNS lookup failed), skipping URL variations`);
          domainReachable = false;
        } else if (input.brandWebsite.includes('/')) {
          // Vision URL didn't work but domain exists - try common variations before falling back to Brave
          const variations = generateUrlVariations(input.brandWebsite);
          for (const variant of variations) {
            console.log(`[price] Trying URL variation: ${variant}`);
            const variantPrice = await extractPriceFromBrand(variant, input.brand, input.title);
            if (variantPrice) {
              brandPrice = variantPrice;
              brandUrl = variant;
              console.log(`[price] ✓ Brand MSRP from URL variation: $${brandPrice.toFixed(2)}`);
              break;
            }
          }
        }
      }
    }
  }

  // SECOND: Try brand-map (curated brand URLs)
  if (!brandPrice && domainReachable) {
    const signature = [input.brand, input.title].filter(Boolean).join(' ').trim();
    if (signature) {
      const mapped = await getBrandUrls(signature);
      if (mapped?.brand) {
        const mappedPrice = await extractPriceFromBrand(mapped.brand, input.brand, input.title);
        if (mappedPrice) {
          brandPrice = mappedPrice;
          brandUrl = mapped.brand;
          console.log(`[price] ✓ Brand MSRP from curated URL: $${brandPrice.toFixed(2)}`);
        }
      }
    }
  }

  // LAST: Fall back to Brave search for official brand site
  if (!brandPrice && input.brand) {
    const braveUrl = await braveFirstUrlForBrandSite(
      input.brand,
      input.title,
      undefined // Could pass brand domain from brand-map if available
    );
    
    if (braveUrl) {
      const bravePrice = await extractPriceFromBrand(braveUrl, input.brand, input.title);
      if (bravePrice && bravePrice > 0) { // Check for valid price (not -1 rejection)
        brandPrice = bravePrice;
        brandUrl = braveUrl;
        console.log(`[price] ✓ Brand MSRP from Brave search: $${bravePrice.toFixed(2)}`);
      }
    }
  }

  // AMAZON: Always try Amazon to provide marketplace pricing for comparison
  // This enables Phase 2 bundle price detection even when brand site works
  let amazonPrice: number | null = null;
  let amazonUrl: string | undefined;
  
  if (input.brand) {
    console.log('[price] Checking Amazon for marketplace pricing...');
    const { braveFirstUrl } = await import('./search.js');
    
    // Build search query with category context from keyText to avoid wrong products
    // e.g., "Root Sculpt" + "dietary supplement" prevents finding "arm cream"
    console.log('[price-debug] Building Amazon search query...');
    console.log(`[price-debug] input.keyText =`, input.keyText);
    console.log(`[price-debug] input.categoryPath =`, input.categoryPath);
    
    let searchQuery = `${input.brand} ${input.title}`;
    if (input.categoryPath) {
      searchQuery += ` ${input.categoryPath}`;
      console.log(`[price-debug] Added categoryPath to query: "${input.categoryPath}"`);
    } else if (input.keyText && input.keyText.length > 0) {
      // Use first key text item as category hint (usually product type)
      const categoryHint = input.keyText.find(text => 
        text.toLowerCase().includes('supplement') ||
        text.toLowerCase().includes('vitamin') ||
        text.toLowerCase().includes('capsule') ||
        text.toLowerCase().includes('serum') ||
        text.toLowerCase().includes('cream')
      );
      if (categoryHint) {
        searchQuery += ` ${categoryHint}`;
        console.log(`[price-debug] Added keyText hint to query: "${categoryHint}"`);
      } else {
        console.log(`[price-debug] No matching keyText hint found in:`, input.keyText);
      }
    } else {
      console.log(`[price-debug] No keyText or categoryPath available`);
    }
    
    console.log(`[price-debug] Final search query: "${searchQuery}"`);
    const amazonUrlFound = await braveFirstUrl(
      searchQuery,
      'amazon.com'
    );
    
    if (amazonUrlFound) {
      console.log(`[price] Amazon URL found: ${amazonUrlFound}`);
      
      // Phase 3: Extract price WITH shipping for competitive pricing
      const { html, isDnsFailure } = await fetchHtml(amazonUrlFound);
      if (html) {
        const priceData = extractPriceWithShipping(html, input.title);
        
        if (priceData.amazonItemPrice && priceData.amazonItemPrice > 0) {
          amazonPrice = priceData.amazonItemPrice;
          amazonUrl = amazonUrlFound;

          const normalizedBrand = normalizeBrand(input.brand);
          const normalizedTitle = normalizeBrand(priceData.pageTitle);
          const amazonMatchesBrand = Boolean(normalizedBrand && normalizedTitle && normalizedTitle.includes(normalizedBrand));

          if (!amazonMatchesBrand) {
            console.log(`[price] ⚠️ Amazon result skipped due to brand mismatch (title: ${priceData.pageTitle || 'unknown'})`);
            amazonPrice = null;
            amazonUrl = undefined;
          }
          
          if (amazonPrice && amazonUrl) {
            const shippingCents = Math.round(priceData.amazonShippingPrice * 100);
            const shippingNote = priceData.shippingEvidence === 'free' 
              ? 'free shipping' 
              : priceData.shippingEvidence === 'paid' 
                ? `$${priceData.amazonShippingPrice.toFixed(2)} shipping` 
                : 'shipping unknown';
            
            console.log(`[price] ✓ Amazon: item=$${amazonPrice.toFixed(2)}, ${shippingNote}`);
            
            candidates.push({
              source: 'brave-fallback',
              price: amazonPrice,
              currency: 'USD',
              url: amazonUrl,
              notes: `Amazon marketplace price (${shippingNote})`,
              shippingCents,
              matchesBrand: true,
            });
          }
        }
      }
    }
  }

  // Add brand website price if we found one AND it's different from Amazon
  if (brandPrice && (!amazonPrice || Math.abs(brandPrice - amazonPrice) > 0.01)) {
    candidates.push({
      source: 'brand-msrp',
      price: brandPrice,
      currency: 'USD',
      url: brandUrl,
      notes: 'Official brand site MSRP',
    });
  } else if (input.brand) {
    // Only log if we actually attempted brand lookup
    console.log('[price] ✗ No brand MSRP found');
  }

  // ========================================
  // PRICE SANITY CHECK: Filter out bundle prices
  // ========================================
  // Before AI arbitration, check if brand prices look like bundles compared to marketplace prices
  const brandCandidates = candidates.filter(c => c.source === 'brand-msrp');
  const marketCandidates = candidates.filter(c => 
    c.source === 'ebay-sold' || 
    c.url?.includes('amazon.com') || 
    c.url?.includes('walmart.com')
  );

  if (brandCandidates.length > 0 && marketCandidates.length > 0) {
    const comparableMarketCandidates = marketCandidates.filter(c => c.matchesBrand !== false);
    if (comparableMarketCandidates.length === 0) {
      console.log('[price] ⚠️ Skipping bundle check: no marketplace signals match brand');
    } else {
      // Find the lowest marketplace price among comparable signals
      const bestMarket = comparableMarketCandidates.reduce((best, c) =>
        c.price < best.price ? c : best,
        comparableMarketCandidates[0]
      );

      // Check each brand candidate
      for (const brand of brandCandidates) {
        if (isProbablyBundlePrice(brand.price, bestMarket.price)) {
          console.log(`[price] ⚠️ Brand price looks like bundle (>3x market). Dropping brand candidate`, {
            brandPrice: brand.price,
            comparisonPrice: bestMarket.price,
            ratio: (brand.price / bestMarket.price).toFixed(2) + 'x',
            brandUrl: brand.url,
            marketUrl: bestMarket.url,
          });

          // Remove it from candidates
          const idx = candidates.indexOf(brand);
          if (idx >= 0) {
            candidates.splice(idx, 1);
          }
        }
      }
    }
  }

  // ========================================
  // TIER 3: AI Arbitration
  // ========================================
  if (candidates.length === 0) {
    console.warn('[price] No price signals available - using category-based estimate');
    
    // Last resort: reasonable estimate based on product type
    let estimatedPrice = 29.99; // Default for supplements/beauty
    
    const titleLower = input.title.toLowerCase();
    if (titleLower.includes('serum') || titleLower.includes('cream') || titleLower.includes('moisturizer')) {
      estimatedPrice = 24.99; // Skincare
    } else if (titleLower.includes('supplement') || titleLower.includes('vitamin') || titleLower.includes('capsule')) {
      estimatedPrice = 29.99; // Supplements
    } else if (titleLower.includes('protein') || titleLower.includes('pre-workout') || titleLower.includes('collagen')) {
      estimatedPrice = 39.99; // Sports nutrition
    } else if (titleLower.includes('oil') && titleLower.includes('fish')) {
      estimatedPrice = 24.99; // Fish oil
    }
    
    console.log(`[price] Using category estimate: $${estimatedPrice.toFixed(2)}`);
    
    candidates.push({
      source: 'estimate',
      price: estimatedPrice,
      currency: 'USD',
      notes: 'Category-based estimate (no market data available)',
    });
  }

  // Debug log for troubleshooting pricing issues without brand-specific hardcoding
  console.log('[price] DEBUG: Price selection summary', {
    productTitle: input.title,
    productBrand: input.brand,
    candidatesCount: candidates.length,
    candidates: candidates.map(c => ({
      source: c.source,
      price: c.price,
      url: c.url?.substring(0, 50) + (c.url && c.url.length > 50 ? '...' : '')
    }))
  });
  
  console.log(`[price] Tier 3: AI arbitration with ${candidates.length} candidate(s)...`);
  const decision = await decideFinalPrice(input, candidates, soldStats);

  if (decision.ok && decision.chosen && decision.recommendedListingPrice) {
    console.log(`[price] ✓ Final decision: source=${decision.chosen.source} base=$${decision.chosen.price.toFixed(2)} final=$${decision.recommendedListingPrice.toFixed(2)}`);
    
    // Cache MSRP data (not computed price) so pricing logic can be applied with any user settings
    try {
      const msrpCents = Math.round(decision.chosen.price * 100);
      
      await setCachedPrice(cacheKey, {
        msrpCents,
        chosen: decision.chosen,
        candidates: decision.candidates,
        cachedAt: Date.now(),
      });
      
      console.log(`[price] ✓ Cached MSRP ($${decision.chosen.price.toFixed(2)}) for future lookups (30-day TTL)`);
    } catch (err) {
      console.warn(`[price] Failed to cache MSRP:`, err);
    }
  }

  return decision;
}

// ============================================================================
// LEGACY FUNCTION (deprecated, kept for backward compatibility)
// ============================================================================

/**
 * @deprecated Use lookupPrice() instead for AI-powered tiered pricing
 */
export async function lookupMarketPrice(
  brand?: string,
  product?: string,
  variant?: string
): Promise<MarketPrices> {
  console.warn('[price-lookup] lookupMarketPrice is deprecated. Use lookupPrice() instead.');
  
  // Map to new system
  const input: PriceLookupInput = {
    title: [product, variant].filter(Boolean).join(' ').trim() || 'Unknown Product',
    brand: brand || undefined,
    condition: 'NEW',
  };

  const decision = await lookupPrice(input);

  // Map back to legacy format
  const legacy: MarketPrices = {
    amazon: null,
    walmart: null,
    brand: decision.chosen?.source === 'brand-msrp' ? decision.chosen.price : null,
    avg: decision.recommendedListingPrice || 0,
  };

  return legacy;
}
