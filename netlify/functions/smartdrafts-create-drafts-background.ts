import type { Handler } from "@netlify/functions";
import { putJob } from "../../src/lib/job-store.js";
import { k } from "../../src/lib/user-keys.js";
import { recordDraftsCreated } from "../../src/lib/user-stats.js";

// Import the draft creation logic from the existing function
import OpenAI from "openai";
import { pickCategoryForGroup } from "../../src/lib/taxonomy-select.js";
import { listCategories } from "../../src/lib/taxonomy-store.js";
import { type PriceDecision } from "../../src/lib/price-lookup.js";
import { getDeliveredPricing, type DeliveredPricingDecision, type DeliveredPricingSettings } from "../../src/lib/delivered-pricing.js";
import { getBrandMetadata } from "../../src/lib/brand-map.js";
import { getDefaultPricingSettings, type PricingSettings } from "../../src/lib/pricing-config.js";
import { tokensStore } from "../../src/lib/_blobs.js";
import { fetchCategoryAspects, formatAspectsForPrompt, type CategoryAspectsResult } from "../../src/lib/ebay-category-aspects.js";

const GPT_TIMEOUT_MS = 30_000;
const GPT_RETRY_ATTEMPTS = 2;
const GPT_RETRY_DELAY_MS = 1000;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });

// Cache categories in memory for the lifetime of this function instance
let categoriesCache: any[] | null = null;
let categoriesLoadingPromise: Promise<any[]> | null = null;

type BackgroundPayload = {
  jobId?: string;
  userId?: string;
  products?: any[];
  promotion?: {
    enabled: boolean;
    rate: number | null;
  };
};

type PairedProduct = {
  productId: string;
  brand: string;
  product: string;
  title?: string; // For books: the actual book title (brand will be null, product is author)
  brandWebsite?: string; // Official brand website URL from Vision API
  variant?: string;
  size?: string;
  categoryPath?: string;
  keyText?: string[]; // Key text snippets from product packaging (from Vision API)
  photoQuantity?: number; // CHUNK 4: How many physical products visible in photo (from vision analysis)
  packCount?: number | null; // Number of units in package (e.g., 24 for 24-pack) - CRITICAL for variant pricing
  packageType?: string; // bottle/jar/tub/pouch/box/sachet/book/unknown - used for formulation inference
  netWeight?: { value: number; unit: string } | null; // AI-extracted weight from product label (e.g., 8 oz, 250 g)
  heroDisplayUrl?: string;
  backDisplayUrl?: string;
  side1DisplayUrl?: string;  // Optional 3rd image (side panel)
  side2DisplayUrl?: string;  // Optional 4th image (additional angle)
  extras?: string[];
  evidence?: string[];
};

type CategoryHint = {
  id: string;
  title: string;
  aspects: Record<string, any>;
};

// Attention reason codes - each describes why a draft needs manual review
type AttentionReason = {
  code: 'PRICE_FALLBACK' | 'PRICE_LOW' | 'PRICE_ABOVE_RETAIL' | 'PRICE_ESTIMATED' | 'NO_COMPS' | 'MISSING_WEIGHT' | 'MISSING_IMAGES' | 'MISSING_BRAND' | 'LOW_CONFIDENCE';
  message: string;
  severity: 'warning' | 'error';  // 'error' blocks publishing, 'warning' allows but shows alert
};

// Minimum fallback price when all pricing sources fail ($9.99)
const FALLBACK_PRICE_FLOOR = 9.99;

type Draft = {
  productId: string;
  groupId: string; // For eBay publishing via create-ebay-draft-user
  brand: string;
  product: string;
  title: string;
  description: string;
  bullets: string[];
  aspects: Record<string, string[]>;
  category: CategoryHint;
  images: string[];
  price: number; // Always set (never null) - uses fallback if needed
  condition: string;
  keyText?: string[]; // Key text from Vision API - helps determine formulation
  packageType?: string; // bottle/jar/tub/pouch/box/sachet/book/unknown - used for formulation inference
  weight?: { value: number; unit: string } | null; // Shipping weight in ounces (calculated from AI-extracted netWeight + container buffer)
  pricingStatus?: 'OK' | 'ESTIMATED' | 'NEEDS_REVIEW';
  priceWarning?: string; // Explains why price needs review
  needsPriceReview?: boolean; // Frontend flag for red glow/warning
  // NEW: Structured attention system for blocking publishing
  attentionReasons?: AttentionReason[]; // List of all issues requiring review
  needsAttention?: boolean; // True if any attentionReasons exist (convenience flag)
  priceMeta?: {
    chosenSource?: string;
    basePrice?: number;
    candidates?: any[];
  };
  promotion?: {
    enabled: boolean;
    rate: number | null;
  };
};

function parsePayload(raw: string | null | undefined): BackgroundPayload {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error("[smartdrafts-create-drafts-background] invalid JSON", { preview: raw?.slice(0, 200) });
    return {};
  }
}

async function writeJob(jobId: string, userId: string | undefined, data: Record<string, unknown>) {
  const jobKey = userId ? k.job(userId, jobId) : undefined;
  await putJob(jobId, { jobId, userId, ...data }, { key: jobKey });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Extract weight from product title/name as a last-resort fallback.
 * Parses patterns like "8 oz", "16oz", "500 mL", "1.5 lb", "100 capsules"
 * 
 * @returns Weight object if found, null otherwise
 */
function extractWeightFromTitle(title: string): { value: number; unit: string } | null {
  if (!title) return null;
  
  // Common weight patterns in product titles
  const patterns = [
    // Fluid ounces (must come before oz to match "fl oz" first)
    /(\d+(?:\.\d+)?)\s*(?:fl\.?\s*oz\.?|fluid\s*oz(?:ounce)?s?)/i,
    // Regular ounces
    /(\d+(?:\.\d+)?)\s*oz(?:ounces?)?(?!\s*fl)/i,
    // Milliliters
    /(\d+(?:\.\d+)?)\s*(?:ml|milliliters?)/i,
    // Liters
    /(\d+(?:\.\d+)?)\s*(?:l|liters?)(?![a-z])/i,
    // Grams
    /(\d+(?:\.\d+)?)\s*(?:g|grams?)(?![a-z])/i,
    // Kilograms
    /(\d+(?:\.\d+)?)\s*(?:kg|kilograms?)/i,
    // Pounds
    /(\d+(?:\.\d+)?)\s*(?:lb|lbs|pounds?)/i,
    // Count-based: capsules, tablets, softgels, gummies, ct
    /(\d+)\s*(?:capsules?|caps?|tablets?|tabs?|softgels?|gummies?|gummy|ct|count)/i,
  ];
  
  const unitMap: Record<string, string> = {
    'fl oz': 'fl oz',
    'fluid': 'fl oz',
    'oz': 'oz',
    'ounce': 'oz',
    'ml': 'ml',
    'milliliter': 'ml',
    'l': 'ml', // Will multiply by 1000
    'liter': 'ml', // Will multiply by 1000
    'g': 'g',
    'gram': 'g',
    'kg': 'g', // Will multiply by 1000
    'kilogram': 'g', // Will multiply by 1000
    'lb': 'lb',
    'lbs': 'lb',
    'pound': 'lb',
    'capsule': 'capsules',
    'cap': 'capsules',
    'tablet': 'tablets',
    'tab': 'tablets',
    'softgel': 'softgels',
    'gummie': 'gummies',
    'gummy': 'gummies',
    'ct': 'count',
    'count': 'count',
  };
  
  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (match) {
      const value = parseFloat(match[1]);
      // Determine unit from the matched string
      const matchedText = match[0].toLowerCase();
      
      // Handle liters → ml conversion
      if (/\d+(?:\.\d+)?\s*(?:l|liters?)(?![a-z])/i.test(match[0])) {
        return { value: value * 1000, unit: 'ml' };
      }
      // Handle kg → g conversion
      if (/\d+(?:\.\d+)?\s*(?:kg|kilograms?)/i.test(match[0])) {
        return { value: value * 1000, unit: 'g' };
      }
      
      // Map to standard unit
      for (const [key, unit] of Object.entries(unitMap)) {
        if (matchedText.includes(key)) {
          return { value, unit };
        }
      }
      
      // Fallback to oz if we matched something but couldn't identify unit
      return { value, unit: 'oz' };
    }
  }
  
  return null;
}

/**
 * Convert AI-extracted netWeight to shipping weight in ounces.
 * Adds a container buffer based on packageType for more accurate shipping costs.
 * 
 * Container buffer estimates (in ounces):
 * - bottle: 1 oz (plastic/glass bottle weight)
 * - jar: 2 oz (heavier glass jar)
 * - tub: 1.5 oz (larger plastic container)
 * - pouch: 0.5 oz (lightweight packaging)
 * - box: 1 oz (cardboard box)
 * - sachet: 0.25 oz (minimal packaging)
 * - book: 0 oz (weight is total book weight)
 * - unknown: 1 oz (safe default)
 */
function calculateShippingWeight(
  netWeight: { value: number; unit: string } | null | undefined,
  packageType: string | undefined
): { value: number; unit: string } | null {
  if (!netWeight || !netWeight.value || netWeight.value <= 0) {
    return null;
  }
  
  // Convert to ounces
  let weightInOz: number;
  const unit = (netWeight.unit || '').toLowerCase();
  
  switch (unit) {
    case 'oz':
    case 'ounce':
    case 'ounces':
      weightInOz = netWeight.value;
      break;
    case 'lb':
    case 'lbs':
    case 'pound':
    case 'pounds':
      weightInOz = netWeight.value * 16;
      break;
    case 'g':
    case 'gram':
    case 'grams':
      weightInOz = netWeight.value / 28.3495;
      break;
    case 'kg':
    case 'kilogram':
    case 'kilograms':
      weightInOz = netWeight.value * 35.274;
      break;
    case 'ml':
    case 'milliliter':
    case 'milliliters':
      // For liquids, assume 1ml = ~1g = ~0.035oz
      weightInOz = netWeight.value / 28.3495;
      break;
    case 'fl oz':
    case 'fl':
    case 'fluid oz':
    case 'fluid ounce':
    case 'fluid ounces':
      // Fluid ounces to weight ounces (assume water density)
      weightInOz = netWeight.value * 1.043; // 1 fl oz water = ~1.043 oz weight
      break;
    case 'capsules':
    case 'capsule':
    case 'tablets':
    case 'tablet':
    case 'softgels':
    case 'softgel':
    case 'gummies':
    case 'gummy':
    case 'ct':
    case 'count':
      // For pill counts, estimate weight: ~0.01-0.02 oz per capsule/tablet
      // Using 0.015 oz as average (larger capsules)
      weightInOz = netWeight.value * 0.015;
      break;
    case 'sticks':
    case 'stick':
      // Honey sticks, supplement sticks - typically 0.3-0.5 oz each
      // Using 0.35 oz as average for honey/supplement sticks
      weightInOz = netWeight.value * 0.35;
      break;
    case 'pieces':
    case 'piece':
    case 'pcs':
      // Gum pieces, small candies - typically very light
      // Using 0.02 oz as average per piece
      weightInOz = netWeight.value * 0.02;
      break;
    case 'packets':
    case 'packet':
      // Individual powder packets, sachets - typically 0.1-0.3 oz each
      // Using 0.2 oz as average
      weightInOz = netWeight.value * 0.2;
      break;
    case 'chews':
    case 'chew':
      // Chewable supplements - similar to gummies
      // Using 0.03 oz as average
      weightInOz = netWeight.value * 0.03;
      break;
    default:
      // Unknown unit - assume ounces
      console.warn(`[weight] Unknown weight unit "${netWeight.unit}", assuming ounces`);
      weightInOz = netWeight.value;
  }
  
  // Add container buffer based on packageType
  const containerBuffer: Record<string, number> = {
    bottle: 1,
    jar: 2,
    tub: 1.5,
    pouch: 0.5,
    box: 1,
    sachet: 0.25,
    book: 0,
    unknown: 1,
  };
  
  const buffer = containerBuffer[packageType || 'unknown'] ?? 1;
  const totalWeight = weightInOz + buffer;
  
  // Round to 1 decimal place
  const roundedWeight = Math.round(totalWeight * 10) / 10;
  
  console.log(`[weight] Calculated shipping weight: ${netWeight.value} ${netWeight.unit} → ${weightInOz.toFixed(1)} oz + ${buffer} oz buffer = ${roundedWeight} oz`);
  
  return { value: roundedWeight, unit: 'OUNCE' };
}

function timeoutPromise<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("Timeout")), ms))
  ]);
}

// Phase 3: Removed legacy computeEbayPrice function
// Pricing is now handled by computeEbayItemPrice in price-lookup.ts

async function callOpenAI(prompt: string): Promise<string> {
  if (!process.env.OPENAI_API_KEY) {
    console.error("[GPT] OPENAI_API_KEY not configured");
    throw new Error("OpenAI API key not configured");
  }

  let lastError: any;
  for (let attempt = 1; attempt <= GPT_RETRY_ATTEMPTS; attempt++) {
    try {
      console.log(`[GPT] Attempt ${attempt}/${GPT_RETRY_ATTEMPTS} - calling OpenAI...`);
      const completion = await timeoutPromise(
        openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
            {
              role: "system",
              content: "You are an eBay listing expert. Create SEO-optimized, conversion-focused listings with detailed descriptions and complete item specifics. Fill in as many eBay category aspects as possible - the more complete, the better the search ranking. Respond only with valid JSON matching the requested format.",
            },
            { role: "user", content: prompt },
          ],
          max_tokens: 4000, // Increased to allow for complete aspects (40-50 fields) + detailed description
        }),
        GPT_TIMEOUT_MS
      );
      console.log(`[GPT] Attempt ${attempt} succeeded`);
      return completion.choices?.[0]?.message?.content || "{}";
    } catch (err) {
      lastError = err;
      console.error(`[GPT] Attempt ${attempt} failed:`, err instanceof Error ? err.message : String(err));
      if (attempt >= GPT_RETRY_ATTEMPTS) break;
      const delay = GPT_RETRY_DELAY_MS * attempt;
      console.warn(`[GPT] Retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }
  
  const message = lastError instanceof Error ? lastError.message : String(lastError || "OpenAI error");
  throw new Error(message);
}

async function getRelevantCategories(product: PairedProduct, marketplaceProductType?: string): Promise<string> {
  try {
    // Use cached categories to avoid repeated Redis calls (15+ seconds each!)
    // Ensure only ONE concurrent load happens even when multiple products start simultaneously
    if (!categoriesCache) {
      if (!categoriesLoadingPromise) {
        const start = Date.now();
        console.log('[Cache] Starting category load...');
        categoriesLoadingPromise = listCategories();
        
        try {
          categoriesCache = await categoriesLoadingPromise;
          console.log(`[Cache] Loaded ${categoriesCache.length} categories in ${Date.now() - start}ms`);
        } finally {
          categoriesLoadingPromise = null; // Clear promise after load completes
        }
      } else {
        // Another product is already loading - wait for it
        console.log('[Cache] Waiting for concurrent category load...');
        categoriesCache = await categoriesLoadingPromise;
        console.log('[Cache] Category load completed (from concurrent request)');
      }
    }
    const allCategories = categoriesCache;
    
    // For books (where brand is null), search by title instead of author/product name
    // This prevents "Bobbi Brown" (author) from matching food categories like "Brown Sauce"
    const isBook = !product.brand || product.brand === 'null';
    
    // Build semantic search terms based on product TYPE, not brand/product names
    // This prevents "Root" from matching "Lobe Pumps & Root Blowers" or "Fish Oil" matching "Fish Sauce"
    const productName = (product.product || '').toLowerCase();
    const brandName = (product.brand || '').toLowerCase();
    
    // Detect product type - PREFER marketplace type from Amazon/Walmart (most reliable)
    // Then check brand metadata database, then fallback to keyword detection
    let productType = '';
    if (marketplaceProductType) {
      // Use marketplace-detected type (from Amazon/Walmart JSON-LD)
      productType = marketplaceProductType.toLowerCase();
      console.log(`[Category] Using marketplace product type: "${productType}"`);
    } else if (isBook) {
      productType = 'book';
    } else {
      // Check brand metadata database first
      if (brandName) {
        const brandMeta = await getBrandMetadata(brandName);
        if (brandMeta) {
          // Check if product name matches any specific patterns
          if (brandMeta.productPatterns) {
            for (const pattern of brandMeta.productPatterns) {
              const matches = pattern.keywords.some(keyword => 
                productName.includes(keyword.toLowerCase())
              );
              if (matches) {
                productType = pattern.productType;
                console.log(`[Category] Brand "${brandName}" product matched pattern "${pattern.keywords.join(', ')}" → "${productType}"`);
                break;
              }
            }
          }
          
          // Fall back to default product type if no pattern matched
          if (!productType && brandMeta.defaultProductType) {
            productType = brandMeta.defaultProductType;
            console.log(`[Category] Using default product type for brand "${brandName}": "${productType}"`);
          }
        }
      }
      
      // Fallback to keyword detection if no database entry
      if (!productType) {
        if (productName.includes('vitamin') || productName.includes('supplement') || productName.includes('capsule') || productName.includes('pill')) {
          productType = 'vitamin supplement';
        } else if (productName.includes('oil') && (productName.includes('fish') || productName.includes('omega'))) {
          productType = 'fish oil supplement';
        } else if (productName.includes('collagen') || productName.includes('protein') || productName.includes('creatine') || productName.includes('pre workout') || productName.includes('pre ') || productName.includes(' pre')) {
          productType = 'sports nutrition supplement';
        } else if (productName.includes('serum') || productName.includes('cleanser') || productName.includes('cream') || productName.includes('lotion') || productName.includes('moisturizer')) {
          productType = 'skincare beauty';
        } else if (productName.includes('bath') || productName.includes('soak') || productName.includes('salt')) {
          productType = 'bath body';
        } else if (productName.includes('detox') || productName.includes('cleanse') || productName.includes('clean slate')) {
          productType = 'detox supplement';
        } else if (productName.includes('inositol') || productName.includes('hormonal')) {
          productType = 'vitamin supplement';
        }
      }
    }
    
    // Use product type + category path instead of brand/product names
    const searchTerms = [
      productType,
      product.categoryPath
    ].filter(Boolean).join(' ').toLowerCase();
    
    const relevant = allCategories
      .filter(cat => {
        const catText = `${cat.title} ${cat.slug}`.toLowerCase();
        // Split search terms and require at least one significant match
        const terms = searchTerms.split(/\s+/).filter(t => t.length > 2);
        return terms.some(term => catText.includes(term));
      })
      .slice(0, 20)
      .map(cat => {
        // Include key item specifics for each category
        const aspects = cat.itemSpecifics
          ?.filter((spec: any) => !spec.required && spec.name !== 'Brand') // Skip required fields that are auto-filled
          .slice(0, 8) // Limit to top 8 aspects to keep prompt reasonable
          .map((spec: any) => spec.name)
          .join(', ') || '';
        
        return aspects 
          ? `${cat.id}: ${cat.title} (aspects: ${aspects})`
          : `${cat.id}: ${cat.title}`;
      })
      .join('\n');
    
    if (relevant) {
      console.log(`[Category] Found ${relevant.split('\n').length} categories matching type: "${productType}"`);
      return relevant;
    }
    
    // Fallback to common categories if no match found
    console.log(`[Category] No type match for "${productType}", using fallback categories`);
    const commonCats = [
      '261186', // Books
      '180959', // Vitamins & Lifestyle Supplements
      '181034', // Dietary Supplements & Nutrition
      '11450', // Clothing, Shoes & Accessories  
      '293', // Consumer Electronics
      '88433', // Everything Else
    ];
    
    const fallback = allCategories
      .filter(cat => commonCats.includes(cat.id))
      .map(cat => {
        const aspects = cat.itemSpecifics
          ?.filter((spec: any) => !spec.required && spec.name !== 'Brand')
          .slice(0, 8)
          .map((spec: any) => spec.name)
          .join(', ') || '';
        
        return aspects 
          ? `${cat.id}: ${cat.title} (aspects: ${aspects})`
          : `${cat.id}: ${cat.title}`;
      })
      .join('\n');
    
    return fallback;
  } catch (err) {
    console.error('[getRelevantCategories] Error:', err);
    return '';
  }
}

function buildPrompt(
  product: PairedProduct, 
  categoryHint: CategoryHint | null, 
  categories: string,
  competitorPrices?: { amazon: number | null; walmart: number | null; brand: number | null; avg: number },
  categoryAspects?: CategoryAspectsResult | null
): string {
  const lines: string[] = [];
  
  // VALIDATION: If product has title but also has supplement/health product indicators, it's NOT a book
  // This is a safety check in case vision classification was wrong
  if (product.title) {
    const categoryLower = (product.categoryPath || '').toLowerCase();
    const productLower = (product.product || '').toLowerCase();
    const keyTextLower = (product.keyText || []).join(' ').toLowerCase();
    
    const isActuallySupplementNotBook = 
      categoryLower.includes('health') ||
      categoryLower.includes('vitamin') ||
      categoryLower.includes('supplement') ||
      categoryLower.includes('dietary') ||
      keyTextLower.includes('capsule') ||
      keyTextLower.includes('tablet') ||
      keyTextLower.includes('supplement facts') ||
      productLower.includes('capsule') ||
      productLower.includes('tablet');
    
    if (isActuallySupplementNotBook) {
      console.warn(`[buildPrompt] ⚠️ Product has title="${product.title}" but appears to be supplement, not book`);
      console.warn(`[buildPrompt] Category: ${product.categoryPath}, Product: ${product.product}`);
      console.warn(`[buildPrompt] Treating as supplement, ignoring book title field`);
      // Don't use the title - treat as regular product
      lines.push(`Product: ${product.product}`);
      if (product.brand && product.brand !== "Unknown") {
        lines.push(`Brand: ${product.brand}`);
      }
      
      // Include key text from product packaging (Vision API extraction)
      if (product.keyText && product.keyText.length > 0) {
        lines.push(`Product Label Text (visible on packaging): ${product.keyText.join(', ')}`);
        lines.push('👉 Use this label text to determine the correct formulation, size, and quantity.');
      }
    } else {
      // Actually a book
      lines.push(`Book Title: ${product.title}`);
      lines.push(`Author: ${product.product}`);
    }
  } else {
    lines.push(`Product: ${product.product}`);
    if (product.brand && product.brand !== "Unknown") {
      lines.push(`Brand: ${product.brand}`);
    }
    
    // Include key text from product packaging (Vision API extraction)
    if (product.keyText && product.keyText.length > 0) {
      lines.push(`Product Label Text (visible on packaging): ${product.keyText.join(', ')}`);
      lines.push('👉 Use this label text to determine the correct formulation, size, and quantity.');
    }
  }
  
  if (product.variant) {
    lines.push(`Variant: ${product.variant}`);
  }
  
  if (product.size) {
    lines.push(`Size: ${product.size}`);
  }
  
  if (product.categoryPath) {
    lines.push(`Category hint: ${product.categoryPath}`);
  }
  
  if (categoryHint) {
    lines.push(`eBay category: ${categoryHint.title} (ID: ${categoryHint.id})`);
    
    if (categoryHint.aspects && Object.keys(categoryHint.aspects).length > 0) {
      const aspectHints = Object.entries(categoryHint.aspects)
        .slice(0, 5)
        .map(([key, val]: [string, any]) => {
          const values = Array.isArray(val?.values) ? val.values.slice(0, 3).join(', ') : '';
          return values ? `${key}: ${values}` : key;
        })
        .filter(Boolean);
      if (aspectHints.length > 0) {
        lines.push(`Suggested aspects: ${aspectHints.join('; ')}`);
      }
    }
  }
  
  if (product.evidence && product.evidence.length > 0) {
    lines.push(`Matching evidence: ${product.evidence.join('; ')}`);
  }
  
  lines.push("");
  
  if (categories && categories.length > 0) {
    lines.push("Choose the most appropriate eBay category ID from this list:");
    lines.push(categories);
    lines.push("");
  }
  
  lines.push("Create a professional eBay listing with accurate, SEO-optimized details.");
  
  // Add competitor pricing data if available
  if (competitorPrices && (competitorPrices.amazon || competitorPrices.walmart || competitorPrices.brand)) {
    lines.push("");
    lines.push("COMPETITOR PRICING DATA (USE THESE EXACT VALUES):");
    if (competitorPrices.amazon) {
      lines.push(`- Amazon current price: $${competitorPrices.amazon.toFixed(2)}`);
    }
    if (competitorPrices.walmart) {
      lines.push(`- Walmart current price: $${competitorPrices.walmart.toFixed(2)}`);
    }
    if (competitorPrices.brand) {
      lines.push(`- Brand direct price: $${competitorPrices.brand.toFixed(2)}`);
    }
    if (competitorPrices.avg > 0) {
      lines.push(`- Market average: $${competitorPrices.avg.toFixed(2)}`);
    }
    lines.push("");
    lines.push("PRICING RULES:");
    lines.push("- You MUST use the lowest competitor price from above as your 'price' field");
    lines.push("- DO NOT search for prices - the data above is authoritative and current");
    lines.push("- DO NOT invent or hallucinate prices");
    lines.push("- Return ONLY the number in the 'price' field (e.g., 16.00)");
  } else {
    lines.push("IMPORTANT PRICING RULES:");
    lines.push("- Search Amazon.com for the product's 'Typical Price' or 'List Price' (NOT sale/deal prices, NOT marketplace seller prices)");
    lines.push("- IGNORE third-party marketplace sellers with inflated prices - use ONLY Amazon's direct price or manufacturer MSRP");
    lines.push("- For books: use new hardcover/paperback price from publisher, NOT collectible/used/rare edition pricing");
    lines.push("⚠️ CRITICAL: Match the EXACT quantity shown in photos - if photos show 1 bottle, use SINGLE bottle price, NOT 2-pack/3-pack/bundle pricing!");
    lines.push("- Match the EXACT size/variant shown in photos (30-day supply vs 90-day, 8oz vs 16oz, etc.)");
    lines.push("- Common mistake: Using '2 Pack' or 'Twin Pack' prices when photos show only 1 unit");
    lines.push("- Typical range: supplements $15-45, books $10-35, cosmetics $10-50");
    lines.push("- If you see prices over $50 for common items, you're likely looking at wrong variant or marketplace pricing");
  }
  
  lines.push("Assess condition based on whether it appears to be new/sealed or used.");
  lines.push("");
  lines.push("FORMULATION DETECTION (CRITICAL):");
  lines.push("⚠️ ALWAYS use 'Product Label Text' provided above - do NOT guess or make assumptions!");
  lines.push("Look at the extracted text from product photos to determine formulation:");
  lines.push("- If label text mentions 'drink', 'beverage', 'ready to drink', 'RTD', 'shot' (energy shot/protein shot) → formulation is 'Liquid'");
  lines.push("- If label text mentions 'ml', 'mL', 'fl oz', 'fluid ounces' → formulation is 'Liquid' (these are liquid measurements!)");
  lines.push("- If label text mentions 'liquid', 'drops', 'dropper', 'sublingual' → formulation is 'Liquid'");
  lines.push("- If label text mentions 'mix', 'mixing instructions', 'add to water', 'shake', 'stir', 'scoop', 'flavor' (Berry, Vanilla, etc.) → formulation is 'Powder'");
  lines.push("- If label text mentions 'capsule', 'capsules', 'caps', 'vcaps', '60 count', '90 count' → formulation is 'Capsule'");
  lines.push("- If label text mentions 'tablet', 'tablets', 'tabs' → formulation is 'Tablet'");
  lines.push("- If label text mentions 'gummy', 'gummies', 'chewable' → formulation is 'Gummy'");
  
  // Add packageType hint if available (from Vision API)
  if (product.packageType && product.packageType !== 'unknown') {
    lines.push(`- Product package type from photo: ${product.packageType}`);
    if (product.packageType === 'bottle') {
      lines.push("  → Most bottles contain LIQUID (drinks, oils, drops) - verify with label text");
    } else if (product.packageType === 'tub' || product.packageType === 'pouch' || product.packageType === 'jar') {
      lines.push("  → Tubs/pouches/jars often contain POWDER - verify with label text");
    }
  }
  
  lines.push("Common mistake: Products with flavors (Natural Berry, Vanilla) are usually POWDER drinks, NOT capsules!");
  lines.push("Common mistake: If label says 'Liquid Drops', do NOT output 'Capsule' - use the actual label text!");
  lines.push("Common mistake: Ketone/electrolyte DRINKS in bottles are LIQUID formulation, not Powder!");
  lines.push("");
  lines.push("TITLE REQUIREMENTS (SEO-CRITICAL):");
  lines.push("- Must be 60-80 characters (use ALL available space for SEO)");
  lines.push("- Include: Brand + Product Name + Key Features + Size/Type + FORMULATION");
  lines.push("- Use keywords buyers search for (e.g., 'Supplement', 'Powder', 'Capsules', 'Support', 'Health')");
  lines.push("- Example: 'Natural Stacks Dopamine Brain Food 60 Capsules Focus Memory Supplement NEW'");
  lines.push("- Example: 'MyBrainCo Gut Repair Powder Supplement 310g Natural Berry Flavor NEW'");
  lines.push("- For books: 'Title by Author - Edition/Format (Hardcover/Paperback) ISBN - Condition'");
  lines.push("- NO generic titles like 'Natural Stacks Dopamine Brain Food' - add DESCRIPTIVE KEYWORDS!");
  lines.push("");
  lines.push("DESCRIPTION REQUIREMENTS (CONVERSION-CRITICAL):");
  lines.push("- Must be 200-500 words (detailed paragraph format, NOT one sentence!)");
  lines.push("- Structure: Opening hook → Key benefits → Features → Specifications → Call to action");
  lines.push("- Include WHY someone would want this product (benefits, use cases)");
  lines.push("- List ALL ingredients, features, certifications visible on packaging");
  lines.push("- Use engaging, professional language that sells the product");
  lines.push("- Example structure:");
  lines.push("  'Discover [Product Name], the premium [category] designed to [main benefit]...'");
  lines.push("  '[Key features paragraph with specific benefits]...'");
  lines.push("  'Perfect for [target audience/use cases]...'");
  lines.push("  'Specifications: [size, count, ingredients, certifications]...'");
  lines.push("- DO NOT write one-sentence descriptions! Expand with details, benefits, and selling points.");
  lines.push("");
  
  // Add full category aspects from eBay Taxonomy API if available
  if (categoryAspects && (categoryAspects.required.length > 0 || categoryAspects.optional.length > 0)) {
    lines.push("=== COMPLETE CATEGORY ASPECTS FROM EBAY ===");
    lines.push("You MUST fill as many of these aspects as possible based on the product information.");
    lines.push("eBay ranks listings higher when more aspects are filled out accurately.");
    lines.push("");
    const aspectsFormatted = formatAspectsForPrompt(categoryAspects);
    lines.push(aspectsFormatted);
    lines.push("");
    lines.push("INSTRUCTIONS FOR ASPECTS:");
    lines.push("- Fill ALL required aspects (these are mandatory for listing)");
    lines.push("- Fill as many optional aspects as you can determine from the product");
    lines.push("- For aspects with [allowed: ...] values, use ONLY those exact values");
    lines.push("- For aspects with [suggested: ...] values, prefer those but can use similar values");
    lines.push("- If an aspect has (multiple) marker, you can provide an array of values");
    lines.push("- Use 'Does Not Apply' ONLY if truly not applicable, never for missing data");
    lines.push("- NEVER leave required aspects empty or with placeholder values");
    lines.push("");
  } else {
    lines.push("CRITICAL REQUIREMENT: You MUST fill out ALL relevant item specifics (aspects) for your chosen category.");
    lines.push("Example aspects for health products: Brand, Type, Formulation, Main Purpose, Ingredients, Features, Active Ingredients, Number of Capsules, etc.");
    lines.push("The more complete and accurate the aspects, the better the eBay search ranking.");
    lines.push("DO NOT just fill Brand and Type - include ALL relevant aspects you can determine from the product!");
    lines.push("");
  }
  
  lines.push("Response format (JSON):");
  lines.push("{");
  if (categories && categories.length > 0) {
    lines.push('  "categoryId": "12345", // Choose the most appropriate eBay category ID from the list above');
  }
  lines.push('  "title": "...", // 60-80 chars, SEO-optimized with keywords (Brand + Product + Features + Size)');
  lines.push('  "description": "...", // 200-500 word detailed description (NOT one sentence!)');
  lines.push('  "bullets": ["...", "...", "..."], // 3-5 benefit-focused bullet points');
  lines.push('  "aspects": {');
  lines.push('    // REQUIRED: Include ALL aspects shown for your chosen category above');
  lines.push('    "Brand": ["..."],');
  lines.push('    "Type": ["..."],');
  lines.push('    "Formulation": ["Capsule"], // Example - fill based on product');
  lines.push('    "Main Purpose": ["Brain Health"], // Example - fill based on product');
  lines.push('    "Ingredients": ["L-Tyrosine", "..."], // Example - list key ingredients');
  lines.push('    "Features": ["Non-GMO", "Gluten-Free"], // Example - list all features');
  lines.push('    "Active Ingredients": ["..."], // Include if shown in category aspects');
  lines.push('    // ... include EVERY aspect listed for the chosen category');
  lines.push('  },');
  lines.push('  "price": 29.99, // Current retail price from Amazon/Walmart');
  lines.push('  "condition": "NEW" // or "USED"');
  lines.push("}");
  
  return lines.join("\n");
}

async function pickCategory(product: PairedProduct): Promise<CategoryHint | null> {
  try {
    console.log(`[Category] Picking for: ${product.brand} ${product.product}`);
    
    // Skip the expensive pickCategoryForGroup lookup - we already have GPT choosing the category
    // pickCategoryForGroup calls listCategories() again (12+ seconds!) which we already cached above
    // Instead, just return null and let GPT pick from the relevant categories list
    console.log(`[Category] Skipping fallback category lookup - will use GPT selection only`);
    return null;
  } catch (err) {
    console.error(`[Category] Error picking category:`, err);
    return null;
  }
}

function parseGptResponse(responseText: string, product: PairedProduct): any {
  try {
    // Strip markdown code blocks if present (```json ... ```)
    let cleanText = responseText.trim();
    if (cleanText.startsWith('```')) {
      // Remove opening ```json and closing ```
      cleanText = cleanText.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }
    
    const parsed = JSON.parse(cleanText);
    return {
      categoryId: typeof parsed.categoryId === 'string' ? parsed.categoryId.trim() : undefined,
      title: typeof parsed.title === 'string' ? parsed.title.slice(0, 80) : `${product.brand} ${product.product}`.slice(0, 80),
      description: typeof parsed.description === 'string' ? parsed.description.slice(0, 4000) : `${product.brand} ${product.product}`, // Allow up to 4000 chars for eBay
      bullets: Array.isArray(parsed.bullets) ? parsed.bullets.slice(0, 5).map((b: any) => String(b).slice(0, 200)) : [],
      aspects: typeof parsed.aspects === 'object' && parsed.aspects !== null ? parsed.aspects : {},
      price: typeof parsed.price === 'number' && parsed.price > 0 ? parsed.price : undefined,
      condition: typeof parsed.condition === 'string' ? parsed.condition : 'NEW',
    };
  } catch (err) {
    console.error('[GPT] Failed to parse response:', err);
    return {
      categoryId: undefined,
      title: `${product.brand} ${product.product}`.slice(0, 80),
      description: `${product.brand} ${product.product}`,
      bullets: [],
      aspects: {},
      price: undefined,
      condition: 'NEW',
    };
  }
}

function normalizeAspects(aspects: any, product: PairedProduct): Record<string, string[]> {
  const normalized: Record<string, string[]> = {};
  
  // Placeholder values to filter out (GPT sometimes returns these)
  const placeholders = [
    'select', 'choose', '...', 'value', 'not applicable', 'n/a', 
    'does not apply', 'unknown', 'other', 'see description'
  ];
  
  const isPlaceholder = (val: string): boolean => {
    const lower = val.toLowerCase().trim();
    if (lower.length === 0) return true;
    if (lower.length > 50) return false; // Long values are likely real
    return placeholders.some(p => lower.includes(p) && lower.length < 30);
  };
  
  if (typeof aspects === 'object' && aspects !== null) {
    for (const [key, value] of Object.entries(aspects)) {
      if (Array.isArray(value)) {
        const stringValues = value
          .map(v => String(v).trim())
          .filter(v => v && !isPlaceholder(v)); // Filter out empty and placeholders
        if (stringValues.length > 0) {
          normalized[key] = stringValues.slice(0, 10);
        }
      } else if (value !== null && value !== undefined) {
        const stringValue = String(value).trim();
        if (stringValue && !isPlaceholder(stringValue)) {
          normalized[key] = [stringValue];
        }
      }
    }
  }
  
  // CRITICAL: Always ensure Brand is present from product data if missing or invalid
  if (product.brand && product.brand !== "Unknown" && (!normalized.Brand || normalized.Brand.length === 0)) {
    normalized.Brand = [product.brand];
    console.log(`[normalizeAspects] ✓ Brand set from product.brand: "${product.brand}"`);
  } else if (!normalized.Brand || normalized.Brand.length === 0) {
    console.error(`[normalizeAspects] ⚠️ CRITICAL: Brand is missing! product.brand="${product.brand}", productId="${product.productId}"`);
    console.error(`[normalizeAspects] Product data:`, JSON.stringify({ 
      brand: product.brand, 
      product: product.product,
      productId: product.productId,
      title: product.title 
    }));
  }
  
  if (product.size && !normalized.Size) {
    normalized.Size = [product.size];
  }
  
  return normalized;
}

async function createDraftForProduct(
  product: PairedProduct, 
  promotion: { enabled: boolean; rate: number | null }, 
  pricingSettings: PricingSettings,
  retryAttempt: number = 0
): Promise<Draft> {
  const startTime = Date.now();
  const retryLabel = retryAttempt > 0 ? ` (retry ${retryAttempt})` : '';
  console.log(`[Draft] Creating for: ${product.productId}${retryLabel}`);
  console.log(`[Draft] Product data:`, JSON.stringify({ 
    brand: product.brand, 
    product: product.product, 
    title: product.title,
    brandWebsite: product.brandWebsite
  }));
  console.log(`[Draft-debug] keyText:`, product.keyText);
  console.log(`[Draft-debug] categoryPath:`, product.categoryPath);
  console.log(`[Draft-debug] Full product keys:`, Object.keys(product));
  
  // ========================================
  // DELIVERED PRICING ENGINE
  // ========================================
  // Uses Google Shopping for market comps
  // Prices to delivered-to-door, then backs into item + shipping
  // ========================================
  
  let pricingDecision: PriceDecision | null = null;
  let deliveredDecision: DeliveredPricingDecision | null = null;
  let finalPrice: number | null = null;
  let pricingStatus: 'OK' | 'ESTIMATED' | 'NEEDS_REVIEW' = 'NEEDS_REVIEW';
  let priceMeta: any = undefined;
  let priceWarning: string | undefined = undefined;

  try {
    const priceStart = Date.now();
    
    // Build price lookup title - fallback to keyText if product name is missing
    // This handles cases where Vision API didn't extract productName but did get keyText
    let priceLookupTitle = [product.product, product.variant].filter(Boolean).join(' ').trim();
    if (!priceLookupTitle && product.keyText && product.keyText.length > 0) {
      // Use first 4 keyText terms as fallback (e.g., "Hydrolyzed Collagen Protein Powder")
      priceLookupTitle = product.keyText.slice(0, 4).join(' ').trim();
      console.log(`[smartdrafts-price] Using keyText fallback for title: "${priceLookupTitle}"`);
    }
    
    console.log(`[smartdrafts-price] Looking up price for: ${product.brand || '(no brand)'} ${priceLookupTitle || '(no product name)'}`);
    
    // ========================================
    // Delivered-Price-First Pricing Engine
    // ========================================
    
    const deliveredSettings: Partial<DeliveredPricingSettings> = {
      mode: 'market-match',
      shippingEstimateCents: pricingSettings.templateShippingEstimateCents || 600,
      minItemCents: 499, // $4.99 floor
      lowPriceMode: 'FLAG_ONLY', // Soft rollout: flag but don't skip
      useSmartShipping: true,
    };
    
    deliveredDecision = await getDeliveredPricing(
      product.brand || '',
      priceLookupTitle,
      deliveredSettings
    );
    
    console.log(`[smartdrafts-price] Result: item=$${(deliveredDecision.finalItemCents / 100).toFixed(2)}, ship=$${(deliveredDecision.finalShipCents / 100).toFixed(2)}, canCompete=${deliveredDecision.canCompete}`);
    
    // Convert to PriceDecision format for compatibility
    const itemDollars = deliveredDecision.finalItemCents / 100;
    
    if (deliveredDecision.skipListing) {
      // Can't compete and lowPriceMode=AUTO_SKIP
      pricingDecision = {
        ok: false,
        candidates: [],
        reason: 'Cannot compete on delivered price',
      };
    } else if (!deliveredDecision.canCompete) {
      // Overpriced but not skipping (FLAG_ONLY mode)
      pricingDecision = {
        ok: true,
        source: deliveredDecision.compsSource as any,
        price: itemDollars,
        recommendedListingPrice: itemDollars,
        candidates: deliveredDecision.ebayComps.map(c => ({
          source: 'ebay-sold' as const,
          price: c.deliveredCents / 100,
          url: c.url || undefined,
          currency: 'USD',
        })),
        needsManualReview: true,
        manualReviewReason: `Cannot compete: market floor $${(deliveredDecision.activeFloorDeliveredCents! / 100).toFixed(2)} delivered, our price $${((deliveredDecision.finalItemCents + deliveredDecision.finalShipCents) / 100).toFixed(2)}`,
      };
    } else {
      // Good price - can compete
      pricingDecision = {
        ok: true,
        source: deliveredDecision.compsSource as any,
        price: itemDollars,
        confidence: deliveredDecision.matchConfidence,
        recommendedListingPrice: itemDollars,
        candidates: [
          ...deliveredDecision.ebayComps.slice(0, 3).map(c => ({
            source: 'ebay-sold' as const,
            price: c.deliveredCents / 100,
            url: c.url || undefined,
            currency: 'USD',
          })),
          ...deliveredDecision.retailComps.slice(0, 2).map(c => ({
            source: c.source as any,
            price: c.deliveredCents / 100,
            url: c.url || undefined,
            currency: 'USD',
          })),
        ],
        needsManualReview: deliveredDecision.matchConfidence === 'low',
        manualReviewReason: deliveredDecision.matchConfidence === 'low' 
          ? 'Low confidence match - please verify product identity'
          : undefined,
      };
    }
    
    console.log(`[smartdrafts-price] Price lookup took ${Date.now() - priceStart}ms`);

    // Guard against null pricingDecision (should never happen, but TypeScript needs it)
    if (!pricingDecision) {
      console.warn(`[smartdrafts-price] ⚠️ No pricing decision returned`);
      pricingStatus = 'NEEDS_REVIEW';
      finalPrice = null;
      priceWarning = 'Pricing engine returned no decision. Please set price manually.';
    } else if (!pricingDecision.ok || !pricingDecision.recommendedListingPrice) {
      console.warn(`[smartdrafts-price] ⚠️ No price found for "${priceLookupTitle}"`);
      pricingStatus = 'NEEDS_REVIEW';
      finalPrice = null;
      priceWarning = 'Could not determine price from any source. Please set price manually.';
    } else if (pricingDecision.needsManualReview) {
      // Estimate-based price - not confident
      console.warn(`[smartdrafts-price] ⚠️ Estimated price for "${priceLookupTitle}" - needs review`);
      finalPrice = pricingDecision.recommendedListingPrice;
      pricingStatus = 'ESTIMATED';
      priceWarning = pricingDecision.manualReviewReason || 'Price is an estimate based on category. Please verify.';
      priceMeta = {
        chosenSource: pricingDecision.chosen?.source || pricingDecision.source,
        basePrice: pricingDecision.chosen?.price || pricingDecision.price,
        pricingEngine: 'delivered',
        candidates: pricingDecision.candidates.map(c => ({
          source: c.source,
          price: c.price,
          notes: c.notes,
        })),
        ...(deliveredDecision && {
          canCompete: deliveredDecision.canCompete,
          compsSource: deliveredDecision.compsSource,
          ebayCompsCount: deliveredDecision.ebayComps.length,
          retailCompsCount: deliveredDecision.retailComps.length,
          shippingEstimateSource: deliveredDecision.shippingEstimateSource,
        }),
      };
    } else {
      finalPrice = pricingDecision.recommendedListingPrice;
      pricingStatus = 'OK';
      priceMeta = {
        chosenSource: pricingDecision.chosen?.source || pricingDecision.source,
        basePrice: pricingDecision.chosen?.price || pricingDecision.price,
        pricingEngine: 'delivered',
        candidates: pricingDecision.candidates.map(c => ({
          source: c.source,
          price: c.price,
          notes: c.notes,
        })),
        ...(deliveredDecision && {
          canCompete: deliveredDecision.canCompete,
          compsSource: deliveredDecision.compsSource,
          ebayCompsCount: deliveredDecision.ebayComps.length,
          retailCompsCount: deliveredDecision.retailComps.length,
          activeFloorCents: deliveredDecision.activeFloorDeliveredCents,
          finalItemCents: deliveredDecision.finalItemCents,
          finalShipCents: deliveredDecision.finalShipCents,
          freeShipApplied: deliveredDecision.freeShipApplied,
          shippingEstimateSource: deliveredDecision.shippingEstimateSource,
        }),
      };
      
      console.log(
        `[smartdrafts-price] ✓ title="${priceLookupTitle}" ` +
        `final=$${finalPrice.toFixed(2)} ` +
        `source=${pricingDecision.chosen?.source || pricingDecision.source}`
      );
    }
  } catch (err) {
    console.error(`[smartdrafts-price] Price lookup failed:`, err);
    pricingStatus = 'NEEDS_REVIEW';
    finalPrice = null;
  }
  
  const catListStart = Date.now();
  const relevantCategories = await getRelevantCategories(product, undefined);
  console.log(`[Draft] Category list generation took ${Date.now() - catListStart}ms`);
  console.log(`[Draft] Category list preview:\n${relevantCategories.slice(0, 500)}...`);
  
  const catStart = Date.now();
  const categoryHint = await pickCategory(product);
  console.log(`[Draft] Category fallback pick took ${Date.now() - catStart}ms`);
  
  // Try to get a likely category ID to fetch full aspects from eBay's Taxonomy API
  // Extract the first category ID from the relevantCategories list as a hint
  let likelyCategoryId: string | null = null;
  const categoryIdMatch = relevantCategories.match(/^(\d+):/m);
  if (categoryIdMatch) {
    likelyCategoryId = categoryIdMatch[1];
  } else if (categoryHint?.id) {
    likelyCategoryId = categoryHint.id;
  }
  
  // Fetch full category aspects from eBay Taxonomy API
  let categoryAspects: CategoryAspectsResult | null = null;
  if (likelyCategoryId) {
    try {
      const aspectsStart = Date.now();
      categoryAspects = await fetchCategoryAspects(likelyCategoryId);
      if (categoryAspects) {
        console.log(`[Draft] Fetched ${categoryAspects.all.length} aspects for category ${likelyCategoryId} (${categoryAspects.required.length} required, ${categoryAspects.optional.length} optional) in ${Date.now() - aspectsStart}ms`);
      }
    } catch (err) {
      console.warn(`[Draft] Failed to fetch category aspects:`, err);
    }
  }
  
  const prompt = buildPrompt(product, categoryHint, relevantCategories, undefined, categoryAspects);
  console.log(`[Draft] Prompt length: ${prompt.length} chars`);
  console.log(`[Draft] Prompt preview:`, prompt.slice(0, 500));
  
  const gptStart = Date.now();
  const responseText = await callOpenAI(prompt);
  console.log(`[Draft] GPT call took ${Date.now() - gptStart}ms`);
  console.log(`[Draft] GPT response:`, responseText.slice(0, 500));
  
  const parsed = parseGptResponse(responseText, product);
  console.log(`[Draft] Parsed response:`, JSON.stringify(parsed, null, 2));
  
  let finalCategory: CategoryHint | null = categoryHint;
  if (parsed.categoryId) {
    console.log(`[Draft] GPT selected category ID: ${parsed.categoryId}`);
    try {
      const { getCategoryById } = await import("../../src/lib/taxonomy-store.js");
      const gptCategory = await getCategoryById(parsed.categoryId);
      if (gptCategory) {
        finalCategory = {
          id: gptCategory.id,
          title: gptCategory.title || gptCategory.slug || '',
          aspects: {},
        };
        console.log(`[Draft] Using GPT category: ${finalCategory.title} (${finalCategory.id})`);
      } else {
        console.warn(`[Draft] GPT category ${parsed.categoryId} not found, using fallback`);
      }
    } catch (err) {
      console.error(`[Draft] Error loading GPT category:`, err);
    }
  }
  
  const aspects = normalizeAspects(parsed.aspects, product);
  // Collect all product images: front (hero), back, side1, side2, then extras
  const images = [
    product.heroDisplayUrl,
    product.backDisplayUrl,
    product.side1DisplayUrl,
    product.side2DisplayUrl,
    ...(product.extras || [])
  ].filter((x): x is string => Boolean(x));
  
  // 🔍 DEBUG: Log images being added to draft
  console.log(`[Draft] 🖼️ Images for ${product.productId}:`);
  console.log(`[Draft]   Brand: "${product.brand}", Product: "${product.product}"`);
  console.log(`[Draft]   heroDisplayUrl: ${product.heroDisplayUrl || 'MISSING'}`);
  console.log(`[Draft]   heroDisplayUrl hash: ${product.heroDisplayUrl?.match(/\/([a-f0-9]+)-/)?.[1] || 'N/A'}`);
  console.log(`[Draft]   backDisplayUrl: ${product.backDisplayUrl || 'MISSING'}`);
  console.log(`[Draft]   backDisplayUrl hash: ${product.backDisplayUrl?.match(/\/([a-f0-9]+)-/)?.[1] || 'N/A'}`);
  console.log(`[Draft]   side1DisplayUrl: ${product.side1DisplayUrl || 'MISSING'}`);
  console.log(`[Draft]   side2DisplayUrl: ${product.side2DisplayUrl || 'MISSING'}`);
  console.log(`[Draft]   extras: ${(product.extras || []).length} items`);
  console.log(`[Draft]   Total images after filter: ${images.length}`);
  images.forEach((url, i) => {
    console.log(`[Draft]   [${i}] ${url.substring(0, 100)}...`);
    console.log(`[Draft]       Contains pipe: ${url.includes('|')}, Contains %7C: ${url.includes('%7C')}`);
  });
  
  // Use AI-powered pricing decision (already computed above)
  
  // Calculate shipping weight from AI-extracted netWeight
  const shippingWeight = calculateShippingWeight(product.netWeight, product.packageType);
  if (shippingWeight) {
    console.log(`[Draft] ✓ AI-extracted weight for ${product.productId}: ${product.netWeight?.value} ${product.netWeight?.unit} → shipping weight ${shippingWeight.value} oz`);
  } else if (product.netWeight) {
    console.log(`[Draft] ⚠️ Could not calculate shipping weight from netWeight: ${JSON.stringify(product.netWeight)}`);
  }
  
  // Fallback to Amazon weight if no AI weight available
  let finalWeight = shippingWeight;
  if (!finalWeight && pricingDecision?.amazonWeight) {
    const amazonWt = pricingDecision.amazonWeight;
    console.log(`[Draft] 🔄 Using Amazon weight as fallback: ${amazonWt.value} ${amazonWt.unit}`);
    // Convert Amazon weight to ounces for eBay shipping
    finalWeight = calculateShippingWeight(amazonWt, product.packageType);
    if (finalWeight) {
      console.log(`[Draft] ✓ Amazon weight converted to shipping weight: ${finalWeight.value} oz`);
    }
  }
  
  // Last-resort fallback: extract weight from product title/name
  // This is better than defaulting to 16 oz for everything
  if (!finalWeight) {
    const titleWeight = extractWeightFromTitle(product.product || '') 
      || extractWeightFromTitle(product.brand + ' ' + product.product || '')
      || extractWeightFromTitle(parsed.title || '');
    if (titleWeight) {
      console.log(`[Draft] 📦 Extracted weight from title: ${titleWeight.value} ${titleWeight.unit}`);
      finalWeight = calculateShippingWeight(titleWeight, product.packageType);
      if (finalWeight) {
        console.log(`[Draft] ✓ Title weight converted to shipping weight: ${finalWeight.value} oz`);
      }
    }
  }
  
  // ========================================
  // BUILD ATTENTION REASONS (track all issues)
  // ========================================
  const attentionReasons: AttentionReason[] = [];
  
  // Track pricing issues
  let resolvedPrice: number = finalPrice ?? FALLBACK_PRICE_FLOOR;
  
  if (finalPrice === null && parsed.price) {
    // GPT suggested a price when pricing engine failed
    console.log(`[Draft] 💰 Using GPT-suggested price as fallback: $${parsed.price.toFixed(2)}`);
    resolvedPrice = parsed.price;
    pricingStatus = 'ESTIMATED';
    priceWarning = 'Price from AI estimate (pricing engine failed). Please verify.';
    attentionReasons.push({
      code: 'PRICE_FALLBACK',
      message: `Price $${parsed.price.toFixed(2)} is from AI estimate - please verify against market`,
      severity: 'warning',
    });
  } else if (finalPrice === null) {
    // No price from engine OR GPT - use floor price
    console.log(`[Draft] ⚠️ No price available, using fallback floor: $${FALLBACK_PRICE_FLOOR.toFixed(2)}`);
    resolvedPrice = FALLBACK_PRICE_FLOOR;
    pricingStatus = 'NEEDS_REVIEW';
    priceWarning = `No price found - using minimum $${FALLBACK_PRICE_FLOOR.toFixed(2)}. YOU MUST SET CORRECT PRICE.`;
    attentionReasons.push({
      code: 'PRICE_FALLBACK',
      message: `No pricing data found. Defaulted to $${FALLBACK_PRICE_FLOOR.toFixed(2)} - set correct price before publishing`,
      severity: 'error',
    });
  }
  
  // Flag low prices (under $5)
  if (resolvedPrice !== null && resolvedPrice < 5.00) {
    attentionReasons.push({
      code: 'PRICE_LOW',
      message: `Price $${resolvedPrice.toFixed(2)} is very low - verify this is correct`,
      severity: 'warning',
    });
  }
  
  // Flag prices higher than retail (Amazon/Walmart/major retailers)
  // Our price should be LOWER than retail to be competitive
  if (resolvedPrice !== null && deliveredDecision) {
    const retailPrices = [
      deliveredDecision.amazonPriceCents,
      deliveredDecision.walmartPriceCents,
    ].filter((p): p is number => p !== null && p > 0);
    
    if (retailPrices.length > 0) {
      const lowestRetailCents = Math.min(...retailPrices);
      const ourPriceCents = Math.round(resolvedPrice * 100);
      
      // Flag if we're priced higher than ANY major retailer
      if (ourPriceCents > lowestRetailCents) {
        const lowestRetailDollars = lowestRetailCents / 100;
        const overpricePercent = ((ourPriceCents - lowestRetailCents) / lowestRetailCents * 100).toFixed(0);
        attentionReasons.push({
          code: 'PRICE_ABOVE_RETAIL',
          message: `Price $${resolvedPrice.toFixed(2)} is ${overpricePercent}% above retail ($${lowestRetailDollars.toFixed(2)}) - may not sell`,
          severity: 'warning',
        });
        console.log(`[Draft]   WARNING: PRICE_ABOVE_RETAIL - $${resolvedPrice.toFixed(2)} > retail $${lowestRetailDollars.toFixed(2)}`);
      }
    }
  }
  
  // Flag estimated prices from low-confidence matches
  if (pricingStatus === 'ESTIMATED' && !attentionReasons.some(r => r.code === 'PRICE_FALLBACK')) {
    attentionReasons.push({
      code: 'PRICE_ESTIMATED',
      message: priceWarning || 'Price is an estimate - please verify',
      severity: 'warning',
    });
  }
  
  // Track missing weight - this is a serious issue that affects shipping cost
  if (!finalWeight) {
    attentionReasons.push({
      code: 'MISSING_WEIGHT',
      message: 'No weight found (AI, Amazon, or title) - will default to 16oz which may cause incorrect shipping cost',
      severity: 'error', // Upgraded to error - weight is critical for accurate shipping
    });
    console.log(`[Draft] ❌ MISSING_WEIGHT for ${product.productId}: No weight from AI, Amazon, or title extraction`);
  }
  
  // Track missing images
  if (images.length === 0) {
    attentionReasons.push({
      code: 'MISSING_IMAGES',
      message: 'No product images available',
      severity: 'error',
    });
  }
  
  // Track missing brand (for non-books)
  if (!product.brand && product.packageType !== 'book') {
    attentionReasons.push({
      code: 'MISSING_BRAND',
      message: 'Brand not detected - may affect search visibility',
      severity: 'warning',
    });
  }
  
  // Track no competitive data
  if (pricingDecision && pricingDecision.candidates && pricingDecision.candidates.length === 0) {
    attentionReasons.push({
      code: 'NO_COMPS',
      message: 'No market data found - price is a blind estimate',
      severity: 'warning',
    });
  }
  
  const needsAttention = attentionReasons.length > 0;
  const hasBlockingIssue = attentionReasons.some(r => r.severity === 'error');
  
  console.log(`[Draft] Attention check: ${attentionReasons.length} issues (${hasBlockingIssue ? 'BLOCKING' : 'warnings only'})`);
  attentionReasons.forEach(r => console.log(`[Draft]   ${r.severity.toUpperCase()}: ${r.code} - ${r.message}`));
  
  const draft: Draft = {
    productId: product.productId,
    groupId: product.productId, // Add groupId for eBay publishing
    brand: product.brand,
    product: product.product,
    title: parsed.title,
    description: parsed.description,
    bullets: parsed.bullets,
    aspects,
    category: finalCategory || { id: '', title: product.categoryPath || 'Uncategorized', aspects: {} },
    images,
    price: resolvedPrice,  // Always a number now (never null)
    condition: parsed.condition,
    keyText: product.keyText, // Pass through Vision API key text for formulation detection
    packageType: product.packageType, // Pass through Vision API package type for formulation inference
    weight: finalWeight, // AI-extracted weight with Amazon fallback
    pricingStatus,
    priceWarning,
    needsPriceReview: pricingStatus !== 'OK',
    attentionReasons: attentionReasons.length > 0 ? attentionReasons : undefined,
    needsAttention,
    priceMeta,
    promotion, // Include promotion settings in draft
  };
  
  console.log(`[Draft] ✓ Created for ${product.productId} in ${Date.now() - startTime}ms: "${draft.title}"`);
  console.log(`[Draft] Final draft data for ${product.productId}:`, JSON.stringify({
    productId: draft.productId,
    brand: draft.brand,
    product: draft.product,
    title: draft.title,
    aspectsCount: Object.keys(draft.aspects || {}).length,
    aspectsKeys: Object.keys(draft.aspects || {}),
    categoryId: draft.category?.id,
    categoryTitle: draft.category?.title,
    imagesCount: draft.images?.length || 0,
    images: draft.images?.map(u => u?.substring(0, 80) + '...'),
    price: draft.price,
    condition: draft.condition
  }, null, 2));
  
  // Validate draft completeness - check for minimum required data
  const aspectsCount = Object.keys(draft.aspects || {}).length;
  const hasCategory = draft.category && draft.category.id && draft.category.id !== '';
  const hasBrand = draft.aspects?.Brand && draft.aspects.Brand.length > 0;
  const hasType = draft.aspects?.Type && draft.aspects.Type.length > 0;
  
  // CRITICAL: If Brand is missing, this will cause eBay publish errors
  if (!hasBrand) {
    console.error(`[Draft] 🚨 CRITICAL: Brand aspect is missing for ${product.productId}!`);
    console.error(`[Draft] Product brand field: "${product.brand}"`);
    console.error(`[Draft] All aspects:`, JSON.stringify(draft.aspects));
    
    // Last resort: Try to extract brand from title or product name
    if (!product.brand) {
      const titleWords = (draft.title || '').split(' ');
      const potentialBrand = titleWords[0]; // Often brand is first word
      if (potentialBrand && potentialBrand.length > 2) {
        console.warn(`[Draft] Using fallback brand from title: "${potentialBrand}"`);
        draft.aspects.Brand = [potentialBrand];
        // Don't retry - accept this fallback
      }
    }
  }
  
  // Consider draft incomplete if it's missing critical fields
  const isIncomplete = !hasCategory || !hasBrand || aspectsCount < 3;
  
  if (isIncomplete && retryAttempt < 2) {
    console.warn(`[Draft] ⚠️ Incomplete draft for ${product.productId}: category=${hasCategory}, brand=${hasBrand}, aspectsCount=${aspectsCount}`);
    console.warn(`[Draft] 🔄 Retrying draft creation (attempt ${retryAttempt + 1}/2)...`);
    await sleep(1000); // Brief delay before retry
    return createDraftForProduct(product, promotion, pricingSettings, retryAttempt + 1);
  }
  
  if (isIncomplete && retryAttempt >= 2) {
    console.error(`[Draft] ❌ Failed to create complete draft after ${retryAttempt + 1} attempts for ${product.productId}`);
  }
  
  return draft;
}

export const handler: Handler = async (event) => {
  const handlerStartTime = Date.now();
  const body = parsePayload(event.body);
  const jobId = typeof body.jobId === "string" ? body.jobId : undefined;
  const userId = typeof body.userId === "string" ? body.userId : undefined;
  const products = Array.isArray(body.products) ? body.products : [];
  const promotion = body.promotion || { enabled: false, rate: null };

  console.log(`[PERF] Handler started for jobId: ${jobId}, products: ${products.length}`);
  
  // Hard limit to prevent timeouts
  const MAX_PRODUCTS_PER_JOB = 50;
  if (products.length > MAX_PRODUCTS_PER_JOB) {
    console.error(`[smartdrafts] Job rejected: ${products.length} products exceeds limit of ${MAX_PRODUCTS_PER_JOB}`);
    if (jobId && userId) {
      await writeJob(jobId, userId, {
        state: "error",
        error: `Too many products (${products.length}). Maximum is ${MAX_PRODUCTS_PER_JOB} per batch. Please process in smaller chunks.`,
        finishedAt: Date.now(),
      }).catch(() => {});
    }
    return { 
      statusCode: 400,
      body: JSON.stringify({
        error: `Too many products. Maximum is ${MAX_PRODUCTS_PER_JOB} per batch. Please select fewer products or process in smaller chunks.`
      })
    };
  }

  if (!jobId || !userId) {
    if (jobId) {
      await writeJob(jobId, userId, {
        state: "error",
        error: "Missing job metadata",
        finishedAt: Date.now(),
      }).catch(() => {});
    }
    return { statusCode: 200 };
  }

  if (products.length === 0) {
    await writeJob(jobId, userId, {
      state: "error",
      error: "No products provided",
      finishedAt: Date.now(),
    });
    return { statusCode: 200 };
  }

  // Phase 3: Load user pricing settings
  let pricingSettings: PricingSettings = getDefaultPricingSettings();
  if (userId) {
    try {
      const store = tokensStore();
      // CRITICAL: Use encodeURIComponent to match userScopedKey() used in user-settings-save
      const settingsKey = `users/${encodeURIComponent(userId)}/settings.json`;
      const settingsBlob = await store.get(settingsKey);
      if (settingsBlob) {
        const settingsData = JSON.parse(settingsBlob);
        if (settingsData.pricing) {
          pricingSettings = {
            ...getDefaultPricingSettings(),
            ...settingsData.pricing,
          };
          console.log(`[pricing] ✓ Loaded user settings: discount=${pricingSettings.discountPercent}%, strategy=${pricingSettings.shippingStrategy}, shippingCents=${pricingSettings.templateShippingEstimateCents}`);
        }
      } else {
        console.log(`[pricing] No user settings found at ${settingsKey}, using defaults`);
      }
    } catch (err) {
      console.warn(`[pricing] Failed to load user settings, using defaults:`, err);
    }

    // Phase 3.5: Check default fulfillment policy for free shipping
    try {
      const store = tokensStore();
      const { hasFreeShipping, extractShippingCost } = await import("../../src/lib/policy-helpers.js");
      const { getUserAccessToken, apiHost, headers: ebayHeaders } = await import("../../src/lib/_ebay.js");
      const { userScopedKey } = await import("../../src/lib/_auth.js");

      // Load policy defaults
      const policyDefaultsKey = userScopedKey(userId, 'policy-defaults.json');
      const policyDefaults = await store.get(policyDefaultsKey, { type: 'json' }) as any;

      if (policyDefaults?.fulfillment) {
        const fulfillmentPolicyId = policyDefaults.fulfillment;
        console.log(`[pricing] Checking fulfillment policy ${fulfillmentPolicyId} for free shipping...`);

        // Fetch the policy from eBay
        const token = await getUserAccessToken(userId);
        const host = apiHost();
        const h = ebayHeaders(token);
        const policyUrl = `${host}/sell/account/v1/fulfillment_policy/${encodeURIComponent(fulfillmentPolicyId)}`;
        const policyRes = await fetch(policyUrl, { headers: h });

        if (policyRes.ok) {
          const policy = await policyRes.json();

          if (hasFreeShipping(policy)) {
            pricingSettings.templateShippingEstimateCents = 0;
            console.log(`[pricing] ✓ Free shipping policy detected - setting templateShippingEstimateCents to 0`);
          } else {
            const extractedCost = extractShippingCost(policy);
            if (extractedCost !== null && extractedCost !== pricingSettings.templateShippingEstimateCents) {
              pricingSettings.templateShippingEstimateCents = extractedCost;
              console.log(`[pricing] ✓ Extracted shipping cost from policy: ${extractedCost} cents`);
            }
          }
        } else {
          console.warn(`[pricing] Failed to fetch fulfillment policy ${fulfillmentPolicyId}: ${policyRes.status}`);
        }
      }
    } catch (err) {
      console.warn(`[pricing] Failed to check fulfillment policy for free shipping:`, err);
    }
  }

  try {
    const writeJobStart = Date.now();
    await writeJob(jobId, userId, {
      state: "running",
      startedAt: Date.now(),
      totalProducts: products.length,
      processedProducts: 0,
    });
    console.log(`[PERF] Initial writeJob took ${Date.now() - writeJobStart}ms`);

    const drafts: Draft[] = [];
    const errors: any[] = [];
    
    // Track completed count for progress updates
    let completedCount = 0;
    
    const loopStartTime = Date.now();
    console.log(`[PERF] Starting BATCHED processing of ${products.length} products...`);
    
    // Process products in batches to avoid overwhelming connections
    // CONCURRENCY_LIMIT controls how many products process simultaneously
    const CONCURRENCY_LIMIT = 3; // Conservative: 3 products at a time
    const batches: typeof products[] = [];
    
    for (let i = 0; i < products.length; i += CONCURRENCY_LIMIT) {
      batches.push(products.slice(i, i + CONCURRENCY_LIMIT));
    }
    
    console.log(`[PERF] Processing ${batches.length} batches with concurrency limit of ${CONCURRENCY_LIMIT}`);
    
    const results: PromiseSettledResult<any>[] = [];
    
    // Process each batch sequentially, but products within batch run in parallel
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      const batchStartTime = Date.now();
      console.log(`[PERF] === Starting batch ${batchIndex + 1}/${batches.length} (${batch.length} products) ===`);
      
      const batchResults = await Promise.allSettled(
        batch.map(async (product, i) => {
          const absoluteIndex = batchIndex * CONCURRENCY_LIMIT + i;
          const productStartTime = Date.now();
          console.log(`\n[PERF] ========== PRODUCT ${absoluteIndex + 1}/${products.length} START (Batch ${batchIndex + 1}) ==========`);
          console.log(`[PERF] Product ID: ${product.productId}`);
          
          try {
            const draft = await createDraftForProduct(product, promotion, pricingSettings);
            
            const productTotalTime = Date.now() - productStartTime;
            console.log(`[PERF] Product ${absoluteIndex + 1}/${products.length} TOTAL time: ${productTotalTime}ms`);
            console.log(`[PERF] ========== PRODUCT ${absoluteIndex + 1}/${products.length} END ==========\n`);
            
            // Update progress (increment completed count)
            completedCount++;
            const progressStart = Date.now();
            await writeJob(jobId, userId, {
              state: "running",
              processedProducts: completedCount,
              totalProducts: products.length,
            });
            console.log(`[PERF] Progress update (${completedCount}/${products.length}) took ${Date.now() - progressStart}ms`);
            
            return { success: true, draft };
          } catch (err: any) {
            console.error(`[Draft] Error creating draft for ${product.productId}:`, err);
            completedCount++;
            return {
              success: false,
              error: {
                productId: product.productId,
                error: err.message || String(err),
              }
            };
          }
        })
      );
      
      results.push(...batchResults);
      
      const batchTotalTime = Date.now() - batchStartTime;
      console.log(`[PERF] === Batch ${batchIndex + 1}/${batches.length} completed in ${batchTotalTime}ms ===\n`);
    }
    
    // Collect results
    for (const result of results) {
      if (result.status === 'fulfilled') {
        if (result.value.success && result.value.draft) {
          drafts.push(result.value.draft);
        } else if (!result.value.success) {
          errors.push(result.value.error);
        }
      } else {
        errors.push({
          productId: 'unknown',
          error: result.reason?.message || String(result.reason),
        });
      }
    }
    
    const loopTotalTime = Date.now() - loopStartTime;
    console.log(`[PERF] BATCHED PROCESSING COMPLETE: ${loopTotalTime}ms for ${products.length} products`);
    console.log(`[PERF] Wall-clock time per product: ${Math.round(loopTotalTime / products.length)}ms (batched with concurrency ${CONCURRENCY_LIMIT})`);
    console.log(`[PERF] Speed improvement vs sequential: ~${Math.round(products.length * 45000 / loopTotalTime)}x faster`);
    
    // Track user stats (drafts created this week)
    if (drafts.length > 0) {
      await recordDraftsCreated(userId, drafts.length);
    }
    
    await writeJob(jobId, userId, {
      state: "completed",
      finishedAt: Date.now(),
      totalProducts: products.length,
      processedProducts: products.length,
      drafts,
      errors: errors.length > 0 ? errors : undefined,
    });

    console.log(JSON.stringify({ 
      evt: "smartdrafts-create-drafts.completed", 
      userId, 
      jobId, 
      draftCount: drafts.length,
      errorCount: errors.length,
    }));

  } catch (err: any) {
    console.error("[smartdrafts-create-drafts-background] error", err);
    await writeJob(jobId, userId, {
      state: "error",
      finishedAt: Date.now(),
      error: err.message || String(err),
    });
  }

  return { statusCode: 200 };
};
