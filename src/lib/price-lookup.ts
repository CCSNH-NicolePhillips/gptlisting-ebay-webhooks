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
    
    // Pattern 0: Fix common Vision AI mistakes - /pages/ → /products/
    // Vision often returns marketing pages instead of product pages
    if (path.includes('/pages/')) {
      // Try replacing /pages/ with /products/ and extracting product name
      // Example: /pages/boost-testosterone-naturally-with-testo-pro → /products/testo-pro-capsules
      const pageName = filename || base;
      
      // Extract the core product name (after the last "with-" if present)
      const afterWith = pageName.includes('-with-') ? pageName.split('-with-').pop() : pageName;
      
      // Try common product naming patterns
      const productPatterns = [
        pageName, // Original name
        afterWith, // Name after "with-"
        afterWith + '-capsules', // Product + capsules
        afterWith + '-supplement', // Product + supplement  
        afterWith + '-bottle', // Product + bottle
        pageName.replace(/^(boost|naturally|with|get|buy|shop)-/g, ''), // Remove marketing prefixes
      ].filter((p): p is string => Boolean(p));
      
      // Deduplicate patterns
      const uniquePatterns = [...new Set(productPatterns)];
      
      for (const pattern of uniquePatterns) {
        variations.push(`${urlObj.origin}/products/${pattern}`);
      }
    }
    
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
  packCount?: number | null; // Pack count from label (e.g., 24 for "24 packets") - used for variant matching
  pricingSettings?: PricingSettings; // Phase 3: User-configurable pricing settings
}

export type PriceSource = 'ebay-sold' | 'amazon' | 'brand-msrp' | 'brave-fallback' | 'estimate';

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
  // Phase 5: Flag when estimate is used - alerts user to review pricing
  needsManualReview?: boolean;
  manualReviewReason?: string;
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
      },
    });
    if (!res.ok) {
      console.warn(`[fetchHtml] HTTP ${res.status} ${res.statusText} for ${url}`);
      return { html: null, isDnsFailure: false };
    }
    const html = await res.text();
    return { html, isDnsFailure: false };
  } catch (err: any) {
    const isDnsFailure = err?.cause?.code === 'ENOTFOUND';
    console.warn("fetchHtml failed", { url, err });
    return { html: null, isDnsFailure };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Helper: Extract price from URL
 * Returns { price, isDnsFailure } where isDnsFailure indicates the domain doesn't exist
 */
/* istanbul ignore next */
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
  productTitle?: string,
  packCount?: number | null
): Promise<number | null> {
  const { html, isDnsFailure } = await fetchHtml(url);
  
  if (!html) {
    if (isDnsFailure) {
      console.log(`[price] DNS lookup failed for ${url}`);
    }
    return null;
  }
  
  const price = extractPriceFromHtml(html, productTitle, packCount);
  
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
/* istanbul ignore next */
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
  /* istanbul ignore next */
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
    const settings = input.pricingSettings || getDefaultPricingSettings();
    
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
 * Fallback decision when AI fails: prefer ebay-sold, then Amazon (trusted), then brand MSRP
 * 
 * TRUST SCORES:
 * - ebay-sold: 95% (actual sales data)
 * - amazon (with product match): 90% (verified product match on major marketplace)
 * - brand-msrp: 70% (may find wrong variant)
 * - brave-fallback: 60% (web search, may be outdated)
 * - estimate: 30% (category-based guess)
 */
function fallbackDecision(input: PriceLookupInput, candidates: PriceSourceDetail[]): PriceDecision {
  // Prefer ebay-sold first (95% trust - actual sales)
  const ebaySold = candidates.find(c => c.source === 'ebay-sold');
  if (ebaySold) {
    console.log(`[price] Fallback decision: using ebay-sold $${ebaySold.price.toFixed(2)} (trust: 95%)`);
    return {
      ok: true,
      chosen: ebaySold,
      candidates,
      recommendedListingPrice: ebaySold.price,
      reason: 'fallback-to-ebay-sold'
    };
  }

  // SECOND: Amazon with product match (90% trust - verified match on major marketplace)
  const amazon = candidates.find(c => c.source === 'amazon' && c.matchesBrand);
  if (amazon) {
    const settings = input.pricingSettings || getDefaultPricingSettings();
    
    const priceCents = Math.round(amazon.price * 100);
    const shippingCents = amazon.shippingCents || 0;
    
    const result = computeEbayItemPrice({
      amazonItemPriceCents: priceCents,
      amazonShippingCents: shippingCents,
      discountPercent: settings.discountPercent,
      shippingStrategy: settings.shippingStrategy,
      templateShippingEstimateCents: settings.templateShippingEstimateCents,
      shippingSubsidyCapCents: settings.shippingSubsidyCapCents,
    });
    
    const finalPrice = result.ebayItemPriceCents / 100;
    
    console.log(`[price] Fallback decision: using amazon $${amazon.price.toFixed(2)} → $${finalPrice.toFixed(2)} (trust: 90%, ${settings.shippingStrategy}, ${settings.discountPercent}% off)`);
    return {
      ok: true,
      chosen: amazon,
      candidates,
      recommendedListingPrice: finalPrice,
      reason: 'fallback-to-amazon-trusted'
    };
  }

  // THIRD: Brand MSRP with pricing settings (70% trust - may find wrong variant)
  const brandMsrp = candidates.find(c => c.source === 'brand-msrp');
  if (brandMsrp) {
    // Phase 3: Use computeEbayItemPrice with user settings
    const settings = input.pricingSettings || getDefaultPricingSettings();
    
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
 * Tier 1: Amazon marketplace (retail reference)
 * Tier 2: OpenAI web_search (brand website pricing)
 * Tier 3: Brave + scrape (brand website fallback)
 * Tier 4: eBay sold/suggested (market-based when no retail exists)
 * Tier 5: Category estimate (last resort)
 */
export async function lookupPrice(
  input: PriceLookupInput
): Promise<PriceDecision> {
  console.log(`[price] Starting lookup for: "${input.title}"${input.brand ? ` (${input.brand})` : ''}${input.upc ? ` [${input.upc}]` : ''}`);

  // Build enriched title that includes pack/size info from keyText
  // This helps with variant matching on brand sites
  let enrichedTitle = input.title;
  if (Array.isArray(input.keyText) && input.keyText.length > 0) {
    // Look for pack indicators in keyText that aren't in the title
    const packPatterns = [
      /\b(\d+)\s*pack\b/i,
      /\b(\d+)\s*ct\b/i,
      /\b(\d+)\s*count\b/i,
      /\b(\d+)\s*packets?\b/i,
      /\b(\d+)\s*oz\b/i,
    ];
    
    for (const keyItem of input.keyText) {
      if (typeof keyItem !== 'string') continue;
      for (const pattern of packPatterns) {
        const match = keyItem.match(pattern);
        if (match && !enrichedTitle.toLowerCase().includes(match[0].toLowerCase())) {
          enrichedTitle = `${enrichedTitle}, ${keyItem}`;
          console.log(`[price] Enriched title with keyText: "${keyItem}"`);
          break;
        }
      }
    }
  }

  // Check cache first - cache stores MSRP data, we compute price with current user settings
  const cacheKey = makePriceSig(input.brand, input.title);
  
  try {
    const cached = await getCachedPrice(cacheKey);
    
    if (cached?.msrpCents && cached?.chosen) {
      console.log(`[price] ✓ Using cached MSRP: $${(cached.msrpCents / 100).toFixed(2)} (source: ${cached.chosen.source})`);
      
      // Compute final price using current user settings
      const settings = input.pricingSettings || getDefaultPricingSettings();
      // Use cached shipping if available, otherwise 0 (brand-msrp has no shipping info)
      // Don't fall back to templateShippingEstimateCents - that's for eBay, not Amazon
      const amazonShippingCents = cached.chosen.shippingCents ?? 0;
      
      const pricingResult = computeEbayItemPrice({
        amazonItemPriceCents: cached.msrpCents,
        amazonShippingCents: amazonShippingCents,
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
  // TIER 1: Amazon Marketplace (Retail Reference)
  // ========================================
  console.log('[price] Tier 1: Checking Amazon marketplace...');
  
  let amazonPrice: number | null = null;
  let amazonUrl: string | undefined;
  
  if (input.brand) {
    const { braveFirstUrl } = await import('./search.js');
    const { getAmazonAsin } = await import('./brand-registry.js');
    
    // FIRST: Check brand registry for known ASIN
    const registeredAsin = await getAmazonAsin(input.brand, input.title);
    let amazonUrlFound: string | null = null;
    
    // Helper: Build Amazon search query
    const buildAmazonSearchQuery = (simplified: boolean = false): string => {
      if (simplified) {
        // Simplified query: brand + first 2 words of product + key identifier (like CFU, oz, count)
        const productWords = input.title?.split(/\s+/).slice(0, 2).join(' ') || '';
        let simplifiedQuery = `${input.brand} ${productWords}`;
        
        // Add the most distinctive identifier from keyText
        if (input.keyText && input.keyText.length > 0) {
          const identifierPatterns = [
            /\d+\s*(billion|million)\s*(cfu)?/i,
            /\d+\s*(mg|g|oz|ml|fl\s*oz)/i,
            /\d+\s*(pack|count|ct|capsules?|tablets?|gummies?|patches?|servings?)/i,
          ];
          
          for (const text of input.keyText) {
            if (!text || text.length < 3) continue;
            const isIdentifier = identifierPatterns.some(pattern => pattern.test(text));
            if (isIdentifier) {
              simplifiedQuery += ` ${text}`;
              break; // Only add one identifier
            }
          }
        }
        
        return simplifiedQuery;
      }
      
      // Full query: brand + full title + key identifiers
      let searchQuery = `${input.brand} ${input.title}`;
      
      if (input.keyText && input.keyText.length > 0) {
        const normalizedTitle = input.title?.toLowerCase() || '';
        const normalizedBrand = input.brand?.toLowerCase() || '';
        
        const identifierPatterns = [
          /\d+\s*(billion|million)\s*(cfu)?/i,
          /\d+\s*(mg|g|oz|ml|fl\s*oz)/i,
          /\d+\s*(pack|count|ct|capsules?|tablets?|gummies?|patches?|servings?)/i,
          /\d+x\d+/i,
        ];
        
        const addedTerms: string[] = [];
        
        for (const text of input.keyText) {
          if (!text || text.length < 3) continue;
          
          const normalizedText = text.toLowerCase();
          
          if (normalizedTitle.includes(normalizedText)) continue;
          if (normalizedText === normalizedBrand) continue;
          
          const isIdentifier = identifierPatterns.some(pattern => pattern.test(text));
          
          if (isIdentifier && addedTerms.length < 2) {
            addedTerms.push(text);
            console.log(`[price-debug] Adding key identifier from keyText: "${text}"`);
          }
        }
        
        if (addedTerms.length > 0) {
          searchQuery += ` ${addedTerms.join(' ')}`;
        }
      }
      
      return searchQuery;
    };
    
    if (registeredAsin) {
      amazonUrlFound = `https://www.amazon.com/dp/${registeredAsin}`;
      console.log(`[price] Using registered ASIN: ${registeredAsin}`);
    } else {
      // FALLBACK: Search via Brave
      console.log('[price-debug] No registered ASIN, falling back to search');
      console.log('[price-debug] Building Amazon search query...');
      console.log(`[price-debug] input.keyText =`, input.keyText);
      console.log(`[price-debug] input.categoryPath =`, input.categoryPath);
      
      const searchQuery = buildAmazonSearchQuery(false);
      
      console.log(`[price-debug] Final search query: "${searchQuery}"`);
      amazonUrlFound = await braveFirstUrl(
        searchQuery,
        'amazon.com'
      );
    }
    
    // Track if we should try simplified query on rejection
    let triedSimplified = false;
    
    // Amazon search/validation loop - tries full query first, then simplified on rejection
    amazonSearchLoop: while (amazonUrlFound) {
      console.log(`[price] Amazon URL found: ${amazonUrlFound}`);
      
      const { html, isDnsFailure } = await fetchHtml(amazonUrlFound);
      if (!html) {
        console.log(`[price-debug] Failed to fetch Amazon HTML (DNS failure: ${isDnsFailure})`);
        break amazonSearchLoop;
      }
      
      console.log(`[price-debug] Fetched HTML (${html.length} bytes), extracting price...`);
      const priceData = extractPriceWithShipping(html, input.title);
      console.log(`[price-debug] Extraction result: itemPrice=${priceData.amazonItemPrice}, pageTitle="${priceData.pageTitle}"`);
      
      if (priceData.amazonItemPrice && priceData.amazonItemPrice > 0) {
        // STRICT VALIDATION: Must match brand AND key product terms (unless using registered ASIN)
        const normalizedBrand = normalizeBrand(input.brand);
        const normalizedTitle = normalizeBrand(priceData.pageTitle);
        const brandMatches = Boolean(normalizedBrand && normalizedTitle && normalizedTitle.includes(normalizedBrand));
        
        // Skip validation if we used a registered ASIN (already trusted)
        const skipValidation = Boolean(registeredAsin);
        
        // Check if enough key product terms appear in Amazon title
        // Require at least 50% of terms (minimum 2) to prevent wrong product matches
        let productMatches = false;
        if (input.keyText && input.keyText.length > 0) {
          const keyTerms = input.keyText
            .filter(t => t && t.length > 3) // Skip short/generic terms
            .map(t => normalizeBrand(t))
            .filter((t): t is string => Boolean(t));
          
          const matchingTerms = keyTerms.filter(term => normalizedTitle?.includes(term));
          const matchCount = matchingTerms.length;
          const matchRatio = keyTerms.length > 0 ? matchCount / keyTerms.length : 0;
          
          // CRITICAL FIX: The FIRST keyText term is typically the product name (e.g., "TestoPro")
          // It MUST match to avoid wrong-product matches like "Shilajit Gummies" for "TestoPro Testosterone"
          const firstKeyTerm = keyTerms[0];
          const firstTermMatches = Boolean(firstKeyTerm && normalizedTitle?.includes(firstKeyTerm));
          
          // Require: (1) first/product-name term matches, (2) at least 50% of all terms, (3) minimum 2 matches
          const minRequired = Math.min(2, keyTerms.length);
          productMatches = firstTermMatches && matchCount >= minRequired && matchRatio >= 0.5;
          
          console.log(`[price-debug] Amazon product match check: keyTerms=${JSON.stringify(keyTerms)}, matched=${matchCount}/${keyTerms.length} (${(matchRatio*100).toFixed(0)}%), firstTerm="${firstKeyTerm}" matches=${firstTermMatches}, passes=${productMatches}`);
          if (!productMatches && matchCount > 0) {
            console.log(`[price-debug] Matched terms: ${JSON.stringify(matchingTerms)}, missing: ${JSON.stringify(keyTerms.filter(t => !matchingTerms.includes(t)))}`);
          }
        } else {
          // No keyText - just use brand match
          productMatches = true;
        }

        if (skipValidation || (brandMatches && productMatches)) {
          amazonPrice = priceData.amazonItemPrice;
          amazonUrl = amazonUrlFound;
          
          const shippingCents = Math.round(priceData.amazonShippingPrice * 100);
          const shippingNote = priceData.shippingEvidence === 'free' 
            ? 'free shipping' 
            : priceData.shippingEvidence === 'paid' 
              ? `$${priceData.amazonShippingPrice.toFixed(2)} shipping` 
              : 'shipping unknown';
          
          console.log(`[price] ✓ Amazon: item=$${amazonPrice.toFixed(2)}, ${shippingNote}`);
          
          const amazonCandidate: PriceSourceDetail = {
            source: 'amazon',
            price: amazonPrice,
            currency: 'USD',
            url: amazonUrl,
            notes: `Amazon marketplace price (${shippingNote})`,
            shippingCents,
            matchesBrand: true,
          };
          
          candidates.push(amazonCandidate);
          
          // SHORT-CIRCUIT: Amazon is the preferred source - skip Brave/brand-msrp tiers
          // Apply user pricing settings and return immediately
          console.log(`[price] ✓ Amazon price found - using as preferred source (skipping brand-msrp tier)`);
          
          const settings = input.pricingSettings || getDefaultPricingSettings();
          const priceCents = Math.round(amazonPrice * 100);
          
          const pricingResult = computeEbayItemPrice({
            amazonItemPriceCents: priceCents,
            amazonShippingCents: shippingCents,
            discountPercent: settings.discountPercent,
            shippingStrategy: settings.shippingStrategy,
            templateShippingEstimateCents: settings.templateShippingEstimateCents,
            shippingSubsidyCapCents: settings.shippingSubsidyCapCents,
          });
          
          const finalPrice = pricingResult.ebayItemPriceCents / 100;
          console.log(`[price] 💰 AMAZON PREFERRED: retail=$${amazonPrice.toFixed(2)} | discount=${settings.discountPercent}% | final=$${finalPrice.toFixed(2)}`);
          
          // Cache the Amazon price for future lookups
          const cacheKey = makePriceSig(input.brand, input.title);
          await setCachedPrice(cacheKey, {
            msrpCents: priceCents,
            chosen: amazonCandidate,
            candidates: [amazonCandidate],
          });
          console.log(`[price] ✓ Cached Amazon MSRP ($${amazonPrice.toFixed(2)}) for future lookups (30-day TTL)`);
          
          return {
            ok: true,
            chosen: amazonCandidate,
            candidates: [amazonCandidate],
            recommendedListingPrice: finalPrice,
            reason: 'Amazon price found and preferred',
          };
        } else {
          console.log(`[price] ✗ Amazon result rejected - brand match: ${brandMatches}, product match: ${productMatches} (title: ${priceData.pageTitle || 'unknown'})`);
          
          // RETRY WITH SIMPLIFIED QUERY if we haven't tried yet
          if (!triedSimplified && !registeredAsin) {
            triedSimplified = true;
            const simplifiedQuery = buildAmazonSearchQuery(true);
            console.log(`[price] 🔄 Retrying Amazon with simplified query: "${simplifiedQuery}"`);
            
            amazonUrlFound = await braveFirstUrl(simplifiedQuery, 'amazon.com');
            if (amazonUrlFound) {
              continue amazonSearchLoop; // Try again with new URL
            } else {
              console.log('[price] ✗ Simplified query also found no Amazon URL');
              break amazonSearchLoop;
            }
          }
          break amazonSearchLoop;
        }
      } else {
        break amazonSearchLoop;
      }
    }
    
    if (!amazonUrlFound) {
      console.log('[price] ✗ No Amazon URL found for this product');
    }
  }

  // ========================================
  // TIER 2: OpenAI Web Search (Brand Website - when Amazon fails)
  // ========================================
  // Use OpenAI Responses API with web_search to find brand website + price
  let webSearchUrl: string | null = null;
  let openaiWebSearchPrice: number | null = null;
  let openaiWebSearchConfidence: 'high' | 'medium' | 'low' = 'low';
  
  if (!amazonPrice && input.brand && input.title) {
    console.log('[price] Tier 2: Trying OpenAI web_search...');
    
    const { searchBrandWebsitePriceText } = await import('./openai-websearch.js');
    
    const webResult = await searchBrandWebsitePriceText(
      input.brand,
      input.title,
      input.keyText,
      input.photoQuantity ?? 1
    );
    
    if (webResult.price && webResult.price > 0) {
      openaiWebSearchPrice = webResult.price;
      openaiWebSearchConfidence = webResult.confidence;
      webSearchUrl = webResult.productUrl || webResult.officialWebsite;
      
      console.log(`[price] ✓ OpenAI web_search found: $${webResult.price.toFixed(2)} (${webResult.confidence} confidence)`);
      console.log(`[price]   Brand: ${webResult.brand}`);
      console.log(`[price]   Website: ${webResult.officialWebsite}`);
      console.log(`[price]   Product URL: ${webResult.productUrl}`);
      if (webResult.amazonUrl) {
        console.log(`[price]   Amazon URL: ${webResult.amazonUrl}`);
        console.log(`[price]   Amazon Reasoning: ${webResult.amazonReasoning}`);
      }
      console.log(`[price]   Reasoning: ${webResult.reasoning}`);
      
      // If confidence is high or medium, verify by scraping the productUrl
      if (webResult.confidence === 'high' || webResult.confidence === 'medium') {
        let verifiedPrice = webResult.price;
        let priceSource = 'openai-claimed';
        let urlVerified = false;
        
        // VERIFY: Scrape the productUrl to confirm the price (OpenAI can hallucinate)
        if (webResult.productUrl) {
          console.log(`[price] 🔍 Verifying OpenAI price by scraping: ${webResult.productUrl}`);
          const { html: verifyHtml } = await fetchHtml(webResult.productUrl);
          if (verifyHtml) {
            urlVerified = true;
            const verifyData = extractPriceWithShipping(verifyHtml, input.title);
            if (verifyData.amazonItemPrice && verifyData.amazonItemPrice > 0) {
              console.log(`[price] ✓ Scraped price: $${verifyData.amazonItemPrice.toFixed(2)} (OpenAI claimed: $${webResult.price.toFixed(2)})`);
              // Use scraped price if it differs significantly from OpenAI's claim
              const priceDiff = Math.abs(verifyData.amazonItemPrice - webResult.price) / webResult.price;
              if (priceDiff > 0.15) {
                console.log(`[price] ⚠️ Price mismatch (${(priceDiff * 100).toFixed(0)}% diff) - using scraped price instead`);
                verifiedPrice = verifyData.amazonItemPrice;
                priceSource = 'scraped-verified';
              } else {
                priceSource = 'openai-verified';
              }
            } else {
              console.log('[price] ⚠️ Could not extract price from productUrl - using OpenAI price');
            }
          } else {
            // URL returned 404 or failed - OpenAI hallucinated the URL
            console.log('[price] ❌ productUrl returned 404/error - OpenAI hallucinated, falling through to next tier');
            // Don't use OpenAI's price, continue to Tier 3/4
          }
        }
        
        // Only use OpenAI price if URL was verified or no URL was provided
        if (urlVerified || !webResult.productUrl) {
          const priceCents = Math.round(verifiedPrice * 100);
          const openaiCandidate: PriceSourceDetail = {
            source: 'brand-msrp',
            price: verifiedPrice,
            currency: 'USD',
            url: webResult.productUrl || webResult.officialWebsite || undefined,
            notes: `OpenAI web_search: ${webResult.source} (${webResult.confidence} confidence, ${priceSource})`,
          };
          
          candidates.push(openaiCandidate);
          
          // Apply pricing strategy
          const pricingSettings = input.pricingSettings || getDefaultPricingSettings();
          const pricingResult = computeEbayItemPrice({
            amazonItemPriceCents: priceCents,
            amazonShippingCents: 0,
            discountPercent: pricingSettings.discountPercent,
            shippingStrategy: pricingSettings.shippingStrategy,
            templateShippingEstimateCents: pricingSettings.templateShippingEstimateCents,
            shippingSubsidyCapCents: pricingSettings.shippingSubsidyCapCents,
          });
          
          const finalPrice = pricingResult.ebayItemPriceCents / 100;
          console.log(`[price] 💰 OPENAI WEB_SEARCH PRICE: retail=$${verifiedPrice.toFixed(2)} | discount=${pricingSettings.discountPercent}% | final=$${finalPrice.toFixed(2)}`);
          
          // Cache the price for future lookups
          const cacheKey = makePriceSig(input.brand, input.title);
          await setCachedPrice(cacheKey, {
            msrpCents: priceCents,
            chosen: openaiCandidate,
            candidates: [openaiCandidate],
          });
          console.log(`[price] ✓ Cached brand MSRP ($${verifiedPrice.toFixed(2)}) for future lookups (30-day TTL)`);
          
          return {
            ok: true,
            chosen: openaiCandidate,
            candidates: [openaiCandidate],
            recommendedListingPrice: finalPrice,
            reason: `OpenAI web_search found brand MSRP (${webResult.confidence} confidence)`,
          };
        }
        // If URL was 404, fall through to Tier 3/4
      } else {
        console.log('[price] ⚠ OpenAI confidence is low, will try additional verification...');
      }
    } else if (webResult.officialWebsite || webResult.productUrl) {
      // Found website but no price - will try to scrape in Tier 3
      webSearchUrl = webResult.productUrl || webResult.officialWebsite;
      console.log(`[price] ✓ OpenAI found website but no price: ${webSearchUrl}`);
    } else {
      console.log('[price] ✗ OpenAI web_search did not find brand website');
    }
  }

  // ========================================
  // TIER 3: Brand MSRP (Official Sites - Fallback)
  // ========================================
  console.log('[price] Tier 3: Checking brand MSRP...');
  
  let brandPrice: number | null = null;
  let brandUrl: string | undefined;

  // PRIORITY: Try web-search AI URL first (most accurate product page)
  let domainReachable = true;
  if (webSearchUrl) {
    console.log(`[price] Trying web-search AI URL: ${webSearchUrl}`);
    brandPrice = await extractPriceFromBrand(webSearchUrl, input.brand, enrichedTitle, input.packCount);
    
    if (brandPrice) {
      brandUrl = webSearchUrl;
      console.log(`[price] ✓ Brand MSRP from web-search URL: $${brandPrice.toFixed(2)}`);
      
      // Try variations to find better price
      const variations = generateUrlVariations(webSearchUrl);
      let lowestPrice = brandPrice;
      let bestUrl = brandUrl;
      
      for (const variant of variations) {
        const variantPrice = await extractPriceFromBrand(variant, input.brand, enrichedTitle, input.packCount);
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
      console.log(`[price] ✗ Could not extract price from web-search URL, trying variations...`);
      const variations = generateUrlVariations(webSearchUrl);
      for (const variant of variations) {
        console.log(`[price] Trying URL variation: ${variant}`);
        const variantPrice = await extractPriceFromBrand(variant, input.brand, enrichedTitle, input.packCount);
        if (variantPrice) {
          brandPrice = variantPrice;
          brandUrl = variant;
          console.log(`[price] ✓ Brand MSRP from URL variation: $${brandPrice.toFixed(2)}`);
          break;
        }
      }
    }
  }

  // SECOND: Try Vision API-provided brand website (most accurate!)
  if (!brandPrice && input.brandWebsite) {
    // Skip homepage URLs - they often show bundle/subscription prices, not individual products
    // Match: http://example.com, https://example.com, https://example.com/, http://example.com/
    const isHomepage = /^https?:\/\/[^\/]+\/?$/.test(input.brandWebsite);
    
    if (isHomepage) {
      console.log(`[price] ⚠️ Vision website is homepage (${input.brandWebsite}), skipping direct price extraction`);
    } else {
      console.log(`[price] Trying Vision API brand website: ${input.brandWebsite}`);
      
      // Use extractPriceFromBrand which handles JS detection
      brandPrice = await extractPriceFromBrand(input.brandWebsite, input.brand, enrichedTitle, input.packCount);
      
      if (brandPrice) {
        brandUrl = input.brandWebsite;
        console.log(`[price] ✓ Brand MSRP from Vision API website: $${brandPrice.toFixed(2)}`);
        
        // ALWAYS try URL variations to find the best (lowest) price
        // This protects against Vision AI providing wrong URLs (e.g., bundle pages, old URLs)
        const variations = generateUrlVariations(input.brandWebsite);
        let lowestPrice = brandPrice;
        let bestUrl = brandUrl;
        
        for (const variant of variations) {
          const variantPrice = await extractPriceFromBrand(variant, input.brand, enrichedTitle, input.packCount);
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
            const variantPrice = await extractPriceFromBrand(variant, input.brand, enrichedTitle, input.packCount);
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
        const mappedPrice = await extractPriceFromBrand(mapped.brand, input.brand, enrichedTitle, input.packCount);
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
      const bravePrice = await extractPriceFromBrand(braveUrl, input.brand, enrichedTitle, input.packCount);
      if (bravePrice && bravePrice > 0) { // Check for valid price (not -1 rejection)
        brandPrice = bravePrice;
        brandUrl = braveUrl;
        console.log(`[price] ✓ Brand MSRP from Brave search: $${bravePrice.toFixed(2)}`);
      }
    }
  }

  // Add brand website price if we found one (as fallback/alternative to Amazon)
  if (brandPrice) {
    candidates.push({
      source: 'brand-msrp',
      price: brandPrice,
      currency: 'USD',
      url: brandUrl,
      notes: 'Official brand site MSRP',
    });
  } else if (input.brand && !amazonPrice) {
    // Only log if we actually attempted brand lookup and have no Amazon either
    console.log('[price] ✗ No brand MSRP or Amazon price found');
  }

  // ========================================
  // TIER 4: eBay Sold/Suggested (Market-Based Fallback)
  // ========================================
  // Only use eBay sold prices when we have NO retail reference (no Amazon, no brand MSRP)
  // This provides market-based pricing for obscure/discontinued products
  if (candidates.length === 0) {
    console.log('[price] Tier 4: Checking eBay sold prices (no retail reference found)...');
    
    const soldStats = await fetchSoldPriceStats({
      title: input.title,
      brand: input.brand,
      upc: input.upc,
      condition: input.condition,
      quantity: input.quantity,
    });

    if (soldStats.rateLimited) {
      console.warn('[price] ⚠️ eBay sold prices rate limited');
    } else if (soldStats.ok && soldStats.p35) {
      candidates.push({
        source: 'ebay-sold',
        price: soldStats.p35,
        currency: 'USD',
        notes: `35th percentile of ${soldStats.samples.length} recent sold items (market-based)`,
      });
      console.log(`[price] ✓ eBay sold price: $${soldStats.p35.toFixed(2)} (median: $${soldStats.median?.toFixed(2)})`);
      
      // For eBay sold, use the price directly (it's already competitive market price)
      // No need for discount since this IS the market price
      const priceCents = Math.round(soldStats.p35 * 100);
      const settings = input.pricingSettings || getDefaultPricingSettings();
      
      // Cache for future lookups
      const cacheKey = makePriceSig(input.brand, input.title);
      await setCachedPrice(cacheKey, {
        msrpCents: priceCents,
        chosen: {
          source: 'ebay-sold',
          price: soldStats.p35,
          currency: 'USD',
          notes: `35th percentile of ${soldStats.samples.length} sold items`,
        },
        candidates: candidates,
      });
      console.log(`[price] ✓ Cached eBay sold price ($${soldStats.p35.toFixed(2)}) for future lookups`);
      
      // For eBay sold, we return the p35 directly as the listing price
      // (it's already competitive - we want to be at or slightly below market)
      return {
        ok: true,
        chosen: candidates[0],
        candidates: candidates,
        recommendedListingPrice: soldStats.p35,
        reason: 'eBay sold price (no retail reference available)',
      };
    } else {
      console.log('[price] ✗ No eBay sold price data available');
    }
  }

  // ========================================
  // PRICE SANITY CHECK: Filter out bundle prices
  // ========================================
  // Before AI arbitration, check if brand prices look like bundles compared to marketplace prices
  const brandCandidates = candidates.filter(c => c.source === 'brand-msrp');
  const marketCandidates = candidates.filter(c => 
    c.source === 'ebay-sold' || 
    c.source === 'amazon' ||
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
  // TIER 5: Category Estimate (Last Resort)
  // ========================================
  // When all tiers fail, provide a category-based estimate with manual review flag
  if (candidates.length === 0) {
    console.warn('[price] ⚠️ TIER 5: No price signals from any source - using category estimate');
    console.warn('[price] ⚠️ This listing needs manual price review!');
    
    // Category-based estimates with expanded patterns
    let estimatedPrice = 29.99; // Default for supplements/beauty
    let category = 'general';
    
    const titleLower = input.title.toLowerCase();
    const brandLower = (input.brand || '').toLowerCase();
    
    // Skincare
    if (titleLower.includes('serum') || titleLower.includes('cream') || 
        titleLower.includes('moisturizer') || titleLower.includes('lotion') ||
        titleLower.includes('cleanser') || titleLower.includes('toner')) {
      estimatedPrice = 24.99;
      category = 'skincare';
    }
    // Supplements (general)
    else if (titleLower.includes('supplement') || titleLower.includes('vitamin') || 
             titleLower.includes('capsule') || titleLower.includes('tablet') ||
             titleLower.includes('probiotic')) {
      estimatedPrice = 29.99;
      category = 'supplements';
    }
    // Sports nutrition (premium)
    else if (titleLower.includes('protein') || titleLower.includes('pre-workout') || 
             titleLower.includes('collagen') || titleLower.includes('creatine') ||
             titleLower.includes('bcaa') || titleLower.includes('whey')) {
      estimatedPrice = 39.99;
      category = 'sports-nutrition';
    }
    // Fish oil / Omega
    else if ((titleLower.includes('oil') && titleLower.includes('fish')) ||
             titleLower.includes('omega') || titleLower.includes('krill')) {
      estimatedPrice = 24.99;
      category = 'fish-oil';
    }
    // Wellness drinks / powders
    else if (titleLower.includes('powder') || titleLower.includes('drink mix') ||
             titleLower.includes('greens') || titleLower.includes('superfood')) {
      estimatedPrice = 34.99;
      category = 'wellness-drinks';
    }
    // Hair care
    else if (titleLower.includes('shampoo') || titleLower.includes('conditioner') ||
             titleLower.includes('hair')) {
      estimatedPrice = 19.99;
      category = 'hair-care';
    }
    // Baby / Kids
    else if (titleLower.includes('baby') || titleLower.includes('infant') ||
             titleLower.includes('kids') || titleLower.includes('children')) {
      estimatedPrice = 24.99;
      category = 'baby-kids';
    }
    
    console.log(`[price] Category detected: ${category} → estimate: $${estimatedPrice.toFixed(2)}`);
    
    const estimateCandidate: PriceSourceDetail = {
      source: 'estimate',
      price: estimatedPrice,
      currency: 'USD',
      notes: `Category-based estimate (${category}) - NEEDS MANUAL REVIEW`,
    };
    
    candidates.push(estimateCandidate);
    
    // Return early with manual review flag
    return {
      ok: true,
      chosen: estimateCandidate,
      candidates: [estimateCandidate],
      recommendedListingPrice: estimatedPrice,
      reason: `No retail pricing found. Using ${category} category estimate. Please verify pricing manually.`,
      needsManualReview: true,
      manualReviewReason: `Could not find pricing on Amazon, brand website (${input.brand || 'unknown'}), or eBay sold listings. Category estimate used.`,
    };
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
  
  console.log(`[price] Tier 5: AI arbitration with ${candidates.length} candidate(s)...`);
  const decision = await decideFinalPrice(input, candidates);

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
