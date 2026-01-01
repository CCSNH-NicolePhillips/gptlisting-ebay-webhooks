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
  packCount?: number | null; // Pack count from vision analysis (e.g., 24 for "24-pack") for variant pricing
  amazonPackSize?: number; // Pack size detected from Amazon product page (e.g., 2 for "2-pack")
  pricingSettings?: PricingSettings; // Phase 3: User-configurable pricing settings
  skipCache?: boolean; // Skip cache and force fresh lookup (for testing/debugging)
  netWeight?: { value: number; unit: string }; // Size/weight from Vision API (e.g., {value: 15.22, unit: "fl oz"})
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
  // Manual review flags for low-confidence estimates
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

  // Tunable: > 1.8x seems very likely to be a bundle or multi-pack
  // Lowered from 2.5x to better catch size mismatches like brand site showing larger bottles
  // Example: Brand MSRP $74.95 vs Amazon $39.95 = 1.87x ratio suggests different sizes
  return ratio > 1.8;
}

/**
 * Detect if an Amazon page title indicates a bundle/multi-pack product
 * when we're selling a single item.
 * 
 * Common patterns:
 * - "48 Pack" / "24-Pack" / "(Pack of 12)"
 * - "Bundle" 
 * - "Case of 12"
 * - "X Count" where X > 1
 * 
 * @param pageTitle - The Amazon page title
 * @param sellingQuantity - How many items we're selling (photoQuantity)
 * @param sellingPackCount - If we're selling a pack (e.g., 6-pack), what size
 * @returns true if this appears to be a bundle page for more than we're selling
 */
function isAmazonBundlePage(
  pageTitle: string | undefined,
  sellingQuantity: number = 1,
  sellingPackCount: number | null | undefined = null
): boolean {
  if (!pageTitle) return false;
  
  const title = pageTitle.toLowerCase();
  
  // Pattern 1: Explicit "Bundle" in title
  if (/\bbundle\b/.test(title)) {
    console.log(`[price] ⚠️ Amazon page title contains 'Bundle' - rejecting for single item`);
    return true;
  }
  
  // Pattern 2: "X Pack" / "X-Pack" / "(Pack of X)" where X > what we're selling
  const packPatterns = [
    /(\d+)\s*[-\s]?pack\b/i,           // "48 Pack", "24-pack"
    /\(pack of (\d+)\)/i,               // "(Pack of 12)"
    /case of (\d+)/i,                   // "Case of 12"
    /(\d+)\s*count\b/i,                 // "24 Count"
    /(\d+)\s*(?:ct|pk)\b/i,             // "24ct", "12pk"
  ];
  
  const effectiveSellingQty = sellingPackCount && sellingPackCount > 1 
    ? sellingPackCount * sellingQuantity 
    : sellingQuantity;
  
  for (const pattern of packPatterns) {
    const match = title.match(pattern);
    if (match) {
      const packSize = parseInt(match[1], 10);
      // If Amazon is selling significantly more than we are (more than 2x), reject
      // Use > instead of >= to allow borderline cases like "Pack of 2" when selling 1
      if (packSize > effectiveSellingQty * 2 && packSize > 1) {
        console.log(`[price] ⚠️ Amazon page for ${packSize}-pack but we're selling ${effectiveSellingQty} items - rejecting`);
        return true;
      }
    }
  }
  
  return false;
}

/**
 * Check if Amazon page has a significantly different size than what we're selling
 * @param pageTitle - Amazon page title
 * @param productTitle - Our product title (should include size like "15.22 fl oz")
 * @returns true if there's a major size mismatch
 */
function isAmazonSizeMismatch(
  pageTitle: string | undefined,
  productTitle: string | undefined
): boolean {
  if (!pageTitle || !productTitle) return false;
  
  // Extract size from both titles
  const sizePattern = /(\d+(?:\.\d+)?)\s*(fl\s*oz|oz|ml|l|g|kg|lb|lbs)/i;
  
  const amazonMatch = pageTitle.match(sizePattern);
  const productMatch = productTitle.match(sizePattern);
  
  if (!amazonMatch || !productMatch) return false;
  
  const amazonSize = parseFloat(amazonMatch[1]);
  const amazonUnit = amazonMatch[2].toLowerCase().replace(/\s+/g, '');
  const productSize = parseFloat(productMatch[1]);
  const productUnit = productMatch[2].toLowerCase().replace(/\s+/g, '');
  
  // Normalize units to a common base (oz for liquid, g for weight)
  const normalizeToOz = (size: number, unit: string): number => {
    switch (unit) {
      case 'oz':
      case 'floz':
        return size;
      case 'ml':
        return size / 29.5735; // ml to fl oz
      case 'l':
        return size * 33.814; // liters to fl oz
      default:
        return size; // For weight units, just compare directly
    }
  };
  
  // Only compare if units are compatible (both liquid or both weight)
  const liquidUnits = ['oz', 'floz', 'ml', 'l'];
  const weightUnits = ['g', 'kg', 'lb', 'lbs'];
  
  const amazonIsLiquid = liquidUnits.includes(amazonUnit);
  const productIsLiquid = liquidUnits.includes(productUnit);
  
  if (amazonIsLiquid !== productIsLiquid) return false; // Incompatible units
  
  let amazonNormalized: number, productNormalized: number;
  
  if (amazonIsLiquid) {
    amazonNormalized = normalizeToOz(amazonSize, amazonUnit);
    productNormalized = normalizeToOz(productSize, productUnit);
  } else {
    // Weight comparison - normalize to grams
    const normalizeToG = (size: number, unit: string): number => {
      switch (unit) {
        case 'g': return size;
        case 'kg': return size * 1000;
        case 'lb':
        case 'lbs': return size * 453.592;
        default: return size;
      }
    };
    amazonNormalized = normalizeToG(amazonSize, amazonUnit);
    productNormalized = normalizeToG(productSize, productUnit);
  }
  
  // Reject if Amazon size is more than 50% different from our product
  const ratio = amazonNormalized / productNormalized;
  if (ratio > 1.5 || ratio < 0.67) {
    console.log(`[price] ⚠️ Size mismatch: Amazon=${amazonSize} ${amazonUnit}, Product=${productSize} ${productUnit} (ratio=${ratio.toFixed(2)})`);
    return true;
  }
  
  return false;
}

function normalizeBrand(str?: string | null): string | null {
  if (!str) return null;
  const cleaned = str.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return cleaned || null;
}

/**
 * Check if two brands are a reasonable match
 * Handles cases like "MaryRuth's" matching "MaryRuth Organics"
 */
function brandsMatch(brand1?: string | null, brand2?: string | null): boolean {
  const n1 = normalizeBrand(brand1);
  const n2 = normalizeBrand(brand2);
  if (!n1 || !n2) return false;
  
  // Direct substring match
  if (n1.includes(n2) || n2.includes(n1)) return true;
  
  // Check if they share a significant common prefix (at least 6 chars or 80% of shorter)
  const minLen = Math.min(n1.length, n2.length);
  const prefixThreshold = Math.max(6, Math.floor(minLen * 0.8));
  
  let commonPrefix = 0;
  for (let i = 0; i < minLen && n1[i] === n2[i]; i++) {
    commonPrefix++;
  }
  
  if (commonPrefix >= prefixThreshold) return true;
  
  // Handle possessive 's - "maryruths" vs "maryruth" (remove trailing 's')
  const n1NoS = n1.endsWith('s') && n1.length > 3 ? n1.slice(0, -1) : n1;
  const n2NoS = n2.endsWith('s') && n2.length > 3 ? n2.slice(0, -1) : n2;
  
  if (n1NoS.includes(n2NoS) || n2NoS.includes(n1NoS)) return true;
  
  return false;
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
1. **ALWAYS prefer Amazon price when available** - this is the competitive marketplace price buyers compare against
   - Amazon reflects real market pricing that buyers will comparison shop
   - Brand MSRP is often inflated and not competitive
   - Example: Brand $115, Amazon $75 → use Amazon $75 (competitive price)
2. Only use brand MSRP if NO Amazon price is available
3. Only use eBay sold prices if NO brand MSRP and NO Amazon price is available
4. If using eBay sold price, return it as basePrice (already competitive)
5. For used items, eBay sold data is more reliable than MSRP

IMPORTANT: Return the BASE/RETAIL price as both basePrice and recommendedListingPrice.
Do NOT apply discounts yourself - the system will apply competitive pricing automatically.

RESPONSE FORMAT (JSON only):
{
  "chosenSource": "amazon" | "brand-msrp" | "ebay-sold" | "brave-fallback",
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
 * Fallback decision when AI fails: prefer ebay-sold, then Amazon, then brand MSRP
 */
function fallbackDecision(input: PriceLookupInput, candidates: PriceSourceDetail[]): PriceDecision {
  // Get user pricing settings
  const settings = input.pricingSettings || getDefaultPricingSettings();
  
  // Helper to apply discount
  const applyDiscount = (price: number, shippingCents: number = 0): number => {
    const priceCents = Math.round(price * 100);
    const result = computeEbayItemPrice({
      amazonItemPriceCents: priceCents,
      amazonShippingCents: shippingCents,
      discountPercent: settings.discountPercent,
      shippingStrategy: settings.shippingStrategy,
      templateShippingEstimateCents: settings.templateShippingEstimateCents,
      shippingSubsidyCapCents: settings.shippingSubsidyCapCents,
    });
    return result.ebayItemPriceCents / 100;
  };
  
  // Prefer ebay-sold first (already competitive marketplace price)
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

  // PRIORITY 2: Amazon (competitive marketplace price)
  const amazon = candidates.find(c => c.source === 'amazon');
  if (amazon) {
    const finalPrice = applyDiscount(amazon.price, amazon.shippingCents || 0);
    console.log(`[price] Fallback decision: amazon $${amazon.price.toFixed(2)} → $${finalPrice.toFixed(2)} (${settings.shippingStrategy}, ${settings.discountPercent}% off)`);
    return {
      ok: true,
      chosen: amazon,
      candidates,
      recommendedListingPrice: finalPrice,
      reason: 'fallback-to-amazon-with-discount'
    };
  }

  // PRIORITY 3: Brand MSRP (less competitive, but better than estimate)
  const brandMsrp = candidates.find(c => c.source === 'brand-msrp');
  if (brandMsrp) {
    const finalPrice = applyDiscount(brandMsrp.price, brandMsrp.shippingCents || 0);
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
  
  // Minimum reasonable MSRP to accept from cache (catches corrupted entries like $2.71)
  const MIN_VALID_MSRP_CENTS = 500; // $5.00 minimum - most supplements/products cost more
  
  if (!input.skipCache) {
    try {
      const cached = await getCachedPrice(cacheKey);
    
    if (cached?.msrpCents && cached?.chosen) {
      // Validate cached price isn't suspiciously low (catches corrupted cache entries)
      if (cached.msrpCents < MIN_VALID_MSRP_CENTS) {
        console.warn(`[price] ⚠️ Cached MSRP $${(cached.msrpCents / 100).toFixed(2)} is suspiciously low - ignoring cache`);
        // Fall through to fresh lookup
      } else {
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
    }
  } catch (error) {
    console.warn('[price] Cache read error, proceeding without cache:', error);
    // Continue with normal price lookup
  }
  } else {
    console.log('[price] Skipping cache (skipCache=true)');
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
  // TIER 2: Amazon Marketplace (Strict Matching)
  // ========================================
  console.log('[price] Tier 2: Checking Amazon marketplace...');
  
  let amazonPrice: number | null = null;
  let amazonUrl: string | undefined;
  
  if (input.brand) {
    const { braveFirstUrl } = await import('./search.js');
    const { getAmazonAsin } = await import('./brand-registry.js');
    
    // FIRST: Check brand registry for known ASIN
    const registeredAsin = await getAmazonAsin(input.brand, input.title);
    let amazonUrlFound: string | null = null;
    
    if (registeredAsin) {
      amazonUrlFound = `https://www.amazon.com/dp/${registeredAsin}`;
      console.log(`[price] Using registered ASIN: ${registeredAsin}`);
    } else {
      // FALLBACK: Search via Brave
      console.log('[price-debug] No registered ASIN, falling back to search');
      console.log('[price-debug] Building Amazon search query...');
      console.log(`[price-debug] input.keyText =`, input.keyText);
      console.log(`[price-debug] input.categoryPath =`, input.categoryPath);
      console.log(`[price-debug] input.netWeight =`, input.netWeight);
      
      let searchQuery = `${input.brand} ${input.title}`;
      
      // Include size/weight in search query to find correct variant
      // Only add if not already in the title (avoid duplication like "15.22 fl oz 15.22 fl oz")
      if (input.netWeight && input.netWeight.value && input.netWeight.unit) {
        const sizeStr = `${input.netWeight.value} ${input.netWeight.unit}`;
        const normalizedTitle = input.title.toLowerCase().replace(/\s+/g, ' ');
        const normalizedSize = sizeStr.toLowerCase().replace(/\s+/g, ' ');
        if (!normalizedTitle.includes(normalizedSize)) {
          searchQuery += ` ${sizeStr}`;
          console.log(`[price-debug] Added netWeight to query: "${sizeStr}"`);
        } else {
          console.log(`[price-debug] Size "${sizeStr}" already in title, not duplicating`);
        }
      }
      
      if (input.categoryPath) {
        searchQuery += ` ${input.categoryPath}`;
        console.log(`[price-debug] Added categoryPath to query: "${input.categoryPath}"`);
      } else if (input.keyText && input.keyText.length > 0) {
        const categoryHint = input.keyText.find(text => 
          text.toLowerCase().includes('supplement') ||
          text.toLowerCase().includes('vitamin') ||
          text.toLowerCase().includes('capsule') ||
          text.toLowerCase().includes('serum') ||
          text.toLowerCase().includes('cream') ||
          text.toLowerCase().includes('hair') ||
          text.toLowerCase().includes('skin')
        );
        if (categoryHint) {
          searchQuery += ` ${categoryHint}`;
          console.log(`[price-debug] Added keyText hint to query: "${categoryHint}"`);
        }
      }
      
      console.log(`[price-debug] Final search query: "${searchQuery}"`);
      amazonUrlFound = await braveFirstUrl(
        searchQuery,
        'amazon.com'
      );
    }
    
    if (amazonUrlFound) {
      console.log(`[price] Amazon URL found: ${amazonUrlFound}`);
      
      const { html, isDnsFailure } = await fetchHtml(amazonUrlFound);
      if (!html) {
        console.log(`[price-debug] Failed to fetch Amazon HTML (DNS failure: ${isDnsFailure})`);
      }
      if (html) {
        console.log(`[price-debug] Fetched HTML (${html.length} bytes), extracting price...`);
        const priceData = extractPriceWithShipping(html, input.title);
        console.log(`[price-debug] Extraction result: itemPrice=${priceData.amazonItemPrice}, pageTitle="${priceData.pageTitle}"`);
        
        if (priceData.amazonItemPrice && priceData.amazonItemPrice > 0) {
          // STRICT VALIDATION: Must match brand AND key product terms (unless using registered ASIN)
          const brandMatches = brandsMatch(input.brand, priceData.pageTitle);
          const normalizedTitle = normalizeBrand(priceData.pageTitle);
          
          // Skip validation if we used a registered ASIN (already trusted)
          const skipValidation = Boolean(registeredAsin);
          
          // Check if at least one key product term appears in Amazon title
          let productMatches = false;
          if (input.keyText && input.keyText.length > 0) {
            const keyTerms = input.keyText
              .filter(t => t && t.length > 3) // Skip short/generic terms
              .map(t => normalizeBrand(t))
              .filter((t): t is string => Boolean(t));
            
            productMatches = keyTerms.some(term => normalizedTitle?.includes(term));
            console.log(`[price-debug] Amazon product match check: keyTerms=${JSON.stringify(keyTerms)}, matches=${productMatches}`);
          } else {
            // No keyText - just use brand match
            productMatches = true;
          }

          // BUNDLE CHECK: Reject Amazon pages that are bundles when we're selling single items
          const isBundleMismatch = isAmazonBundlePage(
            priceData.pageTitle,
            input.photoQuantity || 1,
            input.packCount
          );

          // SIZE CHECK: Reject Amazon pages with significantly different sizes
          const isSizeMismatch = isAmazonSizeMismatch(
            priceData.pageTitle,
            input.title
          );

          if (skipValidation || (brandMatches && productMatches && !isBundleMismatch && !isSizeMismatch)) {
            amazonPrice = priceData.amazonItemPrice;
            amazonUrl = amazonUrlFound;
            
            const shippingCents = Math.round(priceData.amazonShippingPrice * 100);
            const shippingNote = priceData.shippingEvidence === 'free' 
              ? 'free shipping' 
              : priceData.shippingEvidence === 'paid' 
                ? `$${priceData.amazonShippingPrice.toFixed(2)} shipping` 
                : 'shipping unknown';
            
            console.log(`[price] ✓ Amazon: item=$${amazonPrice.toFixed(2)}, ${shippingNote}`);
            
            candidates.push({
              source: 'amazon',
              price: amazonPrice,
              currency: 'USD',
              url: amazonUrl,
              notes: `Amazon marketplace price (${shippingNote})`,
              shippingCents,
              matchesBrand: true,
            });
          } else {
            const rejectReasons = [];
            if (!brandMatches) rejectReasons.push('brand mismatch');
            if (!productMatches) rejectReasons.push('product mismatch');
            if (isBundleMismatch) rejectReasons.push('bundle/multipack page');
            if (isSizeMismatch) rejectReasons.push('size mismatch');
            console.log(`[price] ✗ Amazon result rejected - ${rejectReasons.join(', ')} (title: ${priceData.pageTitle || 'unknown'})`);
            
            // AUTO-RETRY: If size mismatch and we have netWeight, try a size-focused search
            if (isSizeMismatch && !registeredAsin && input.netWeight && input.netWeight.value && input.netWeight.unit) {
              console.log(`[price] 🔄 Retrying with size-focused search...`);
              
              // Build a size-first query: "Brand 15.22 oz" or "Brand 60 capsules"
              const sizeStr = `${input.netWeight.value} ${input.netWeight.unit}`;
              // Extract key product term (first significant word from title, skip size)
              const titleWords = input.title
                .replace(/[\d.]+\s*(oz|fl oz|ml|g|mg|capsules?|tablets?|pieces?|sticks?|gummies?)/gi, '')
                .trim()
                .split(/\s+/)
                .filter(w => w.length > 3);
              const keyWord = titleWords[0] || '';
              
              const sizeFirstQuery = `${input.brand} ${sizeStr} ${keyWord}`.trim();
              console.log(`[price-debug] Size-focused retry query: "${sizeFirstQuery}"`);
              
              const retryUrl = await braveFirstUrl(sizeFirstQuery, 'amazon.com');
              
              if (retryUrl && retryUrl !== amazonUrlFound) {
                console.log(`[price] 🔄 Retry found different URL: ${retryUrl}`);
                
                const { html: retryHtml } = await fetchHtml(retryUrl);
                if (retryHtml) {
                  const retryPriceData = extractPriceWithShipping(retryHtml, input.title);
                  
                  if (retryPriceData.amazonItemPrice && retryPriceData.amazonItemPrice > 0) {
                    // Re-validate size match
                    const retryBrandMatches = brandsMatch(input.brand, retryPriceData.pageTitle);
                    const retrySizeMismatch = isAmazonSizeMismatch(retryPriceData.pageTitle, input.title);
                    
                    if (retryBrandMatches && !retrySizeMismatch) {
                      amazonPrice = retryPriceData.amazonItemPrice;
                      amazonUrl = retryUrl;
                      
                      const shippingCents = Math.round(retryPriceData.amazonShippingPrice * 100);
                      const shippingNote = retryPriceData.shippingEvidence === 'free' 
                        ? 'free shipping' 
                        : retryPriceData.shippingEvidence === 'paid' 
                          ? `$${retryPriceData.amazonShippingPrice.toFixed(2)} shipping` 
                          : 'shipping unknown';
                      
                      console.log(`[price] ✓ Retry success! Amazon: item=$${amazonPrice.toFixed(2)}, ${shippingNote}`);
                      console.log(`[price]   Title: ${retryPriceData.pageTitle?.substring(0, 100)}...`);
                      
                      candidates.push({
                        source: 'amazon',
                        price: amazonPrice,
                        currency: 'USD',
                        url: amazonUrl,
                        notes: `Amazon marketplace price (${shippingNote}) [retry-with-size]`,
                        shippingCents,
                        matchesBrand: true,
                      });
                    } else {
                      console.log(`[price] ✗ Retry also rejected - brand=${retryBrandMatches}, sizeMismatch=${retrySizeMismatch}`);
                    }
                  }
                }
              } else if (retryUrl === amazonUrlFound) {
                console.log(`[price] 🔄 Retry returned same URL, skipping`);
              }
            }
          }
        }
      }
    } else {
      console.log('[price] ✗ No Amazon URL found for this product');
    }
  }

  // ========================================
  // TIER 2.5: Web Search AI (Experimental - when Amazon fails)
  // ========================================
  // Only use web search if Amazon didn't return anything
  if (!amazonPrice && input.brand && input.title) {
    console.log('[price] Tier 2.5: Trying web-search AI...');
    
    const { searchWebForPrice } = await import('./web-search-pricing.js');
    const additionalContext = [
      input.categoryPath,
      input.keyText?.slice(0, 3).join(', '),
    ].filter(Boolean).join(' | ');
    
    const webResult = await searchWebForPrice(
      input.brand,
      input.title,
      additionalContext
    );
    
    if (webResult.price && webResult.price > 0) {
      console.log(`[price] ✓ Web search found: $${webResult.price.toFixed(2)} (${webResult.source}, ${webResult.confidence} confidence)`);
      console.log(`[price]   URL: ${webResult.url}`);
      console.log(`[price]   Reasoning: ${webResult.reasoning}`);
      
      candidates.push({
        source: 'brave-fallback', // Map to existing source type
        price: webResult.price,
        currency: 'USD',
        url: webResult.url || undefined,
        notes: `Web search: ${webResult.source} (${webResult.confidence} confidence) - ${webResult.reasoning}`,
      });
    } else {
      console.log('[price] ✗ Web search did not find price');
    }
  }

  // ========================================
  // TIER 3: Brand MSRP (Official Sites - Fallback)
  // ========================================
  console.log('[price] Tier 3: Checking brand MSRP...');
  
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

      // SAFEGUARD: If marketplace price is suspiciously low (< $8), don't trust it
      // This catches cases where Amazon returned a multi-pack page that we divided incorrectly
      if (bestMarket.price < 8.00) {
        console.log(`[price] ⚠️ Marketplace price $${bestMarket.price.toFixed(2)} is suspiciously low - keeping brand MSRP as alternative`);
      } else {
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
    // Sanity check: reject negative or suspiciously low prices
    const minValidPrice = 5.00; // Minimum $5 recommended price
    if (decision.recommendedListingPrice < minValidPrice) {
      console.warn(`[price] ⚠️ Recommended price $${decision.recommendedListingPrice.toFixed(2)} is below minimum - rejecting`);
      return {
        ok: false,
        candidates: decision.candidates,
        reason: `Price $${decision.recommendedListingPrice.toFixed(2)} is below minimum threshold`,
        needsManualReview: true,
        manualReviewReason: 'Calculated price too low - please verify manually',
      } as PriceDecision;
    }
    
    console.log(`[price] ✓ Final decision: source=${decision.chosen.source} base=$${decision.chosen.price.toFixed(2)} final=$${decision.recommendedListingPrice.toFixed(2)}`);
    
    // Cache MSRP data (not computed price) so pricing logic can be applied with any user settings
    // Only cache prices above $5 to prevent corrupted cache entries
    try {
      const msrpCents = Math.round(decision.chosen.price * 100);
      
      if (msrpCents >= 500) { // Only cache if MSRP >= $5
        await setCachedPrice(cacheKey, {
          msrpCents,
          chosen: decision.chosen,
          candidates: decision.candidates,
          cachedAt: Date.now(),
        });
      
        console.log(`[price] ✓ Cached MSRP ($${decision.chosen.price.toFixed(2)}) for future lookups (30-day TTL)`);
      } else {
        console.warn(`[price] ⚠️ Not caching MSRP $${decision.chosen.price.toFixed(2)} - too low`);
      }
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
