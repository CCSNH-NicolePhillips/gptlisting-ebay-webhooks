const BASE = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";

if (!BASE || !TOKEN) {
  console.warn("⚠️ BRAND MAP DISABLED — missing Upstash credentials");
}

async function redisCall(...parts: string[]): Promise<{ result: unknown } | null> {
  if (!BASE || !TOKEN) return null;

  const encoded = parts.map((part) => encodeURIComponent(part));
  const url = `${BASE}/${encoded.join("/")}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Redis error ${res.status}: ${text}`);
  }

  return res.json();
}

export type BrandUrls = {
  brand?: string;
  domain?: string; // Official brand website domain (e.g., performbettr.com)
  amazon?: string;
  walmart?: string;
  requiresJs?: boolean; // True if brand website prices are JavaScript-rendered
  lastChecked?: number; // Timestamp of last price check
};

export type BrandMetadata = {
  defaultProductType?: string; // Default type if product name doesn't match specific patterns
  productPatterns?: Array<{
    keywords: string[]; // Keywords to match in product name (e.g., ["serum", "cream"])
    productType: string; // Type to assign (e.g., "skincare beauty")
  }>;
  category?: string; // Optional: specific eBay category hint
  notes?: string; // Optional: any additional metadata
};

export async function setBrandUrls(sig: string, urls: BrandUrls): Promise<void> {
  if (!sig) return;
  try {
    await redisCall("SET", `brandmap:${sig}`, JSON.stringify(urls));
  } catch (err) {
    console.warn("brand-map write failed", err);
  }
}

export async function getBrandUrls(sig: string): Promise<BrandUrls | null> {
  if (!sig) return null;
  try {
    const resp = await redisCall("GET", `brandmap:${sig}`);
    const raw = resp?.result;
    if (typeof raw !== "string" || !raw) return null;
    try {
      return JSON.parse(raw);
    } catch (err) {
      console.warn("brand-map parse failed", err);
      return null;
    }
  } catch (err) {
    console.warn("brand-map read failed", err);
    return null;
  }
}

/**
 * Get brand domain from registry (Redis-backed).
 * Uses normalized brand name as key: brandmap:domain:{brand}
 * Returns the official website domain if registered.
 */
export async function getBrandDomainFromRegistry(brandName: string): Promise<string | null> {
  if (!brandName) return null;
  const normalized = brandName.toLowerCase().trim();
  try {
    const resp = await redisCall("GET", `brandmap:domain:${normalized}`);
    const raw = resp?.result;
    if (typeof raw === "string" && raw) {
      console.log(`[brand-map] ✓ Found domain for "${brandName}": ${raw}`);
      return raw;
    }
    return null;
  } catch (err) {
    console.warn("brand-domain lookup failed", err);
    return null;
  }
}

/**
 * Set brand domain in registry (Redis-backed).
 * Stores: brandmap:domain:{normalizedBrand} → domain
 * No TTL - brand domains are stable.
 */
export async function setBrandDomain(brandName: string, domain: string): Promise<void> {
  if (!brandName || !domain) return;
  const normalized = brandName.toLowerCase().trim();
  try {
    await redisCall("SET", `brandmap:domain:${normalized}`, domain);
    console.log(`[brand-map] ✓ Saved domain for "${brandName}": ${domain}`);
  } catch (err) {
    console.warn("brand-domain write failed", err);
  }
}

/**
 * Return type for authoritative brand domain resolution
 */
export type BrandDomainResolution = {
  domain: string | null;
  source: 'registry' | 'suggested' | 'none';
};

// Common suffix/stopwords to strip from brand names for comparison
const BRAND_STOPWORDS = [
  'shop', 'store', 'official', 'health', 'wellness', 'beauty', 'care',
  'labs', 'lab', 'pharma', 'natural', 'naturals', 'supplements', 'supplement',
  'nutrition', 'skincare', 'skin', 'home', 'usa', 'us', 'co', 'company',
  'inc', 'llc', 'ltd', 'the', 'and'
];

// Hosted storefront domains to reject (not canonical brand domains)
const HOSTED_STOREFRONT_PATTERNS = [
  '.myshopify.com',
  '.shopify.com',
  '.bigcartel.com',
  '.square.site',
  '.squarespace.com',
  '.wixsite.com',
  '.wix.com',
  '.weebly.com',
  '.godaddysites.com',
  '.wordpress.com',
  '.bigcommerce.com',
];

/**
 * Check if a domain is a hosted storefront (not a canonical brand domain)
 */
function isHostedStorefront(domain: string): boolean {
  const lower = domain.toLowerCase();
  return HOSTED_STOREFRONT_PATTERNS.some(pattern => lower.endsWith(pattern));
}

/**
 * Normalize a string for comparison: lowercase, remove punctuation, strip stopwords
 */
function normalizeForComparison(str: string): string {
  // Lowercase and remove punctuation/special chars
  let normalized = str.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  // Remove stopwords
  for (const stopword of BRAND_STOPWORDS) {
    const pattern = new RegExp(`\\b${stopword}\\b`, 'gi');
    normalized = normalized.replace(pattern, '').trim();
  }
  // Collapse multiple spaces
  normalized = normalized.replace(/\s+/g, ' ').trim();
  return normalized;
}

/**
 * Extract the domain base (before TLD)
 * e.g., "evereden.com" → "evereden", "shop.drteals.com" → "shopdrteals"
 */
function extractDomainBase(domain: string): string {
  return domain
    .toLowerCase()
    .replace(/^(www\.|shop\.|store\.|my\.|get\.|try\.)/, '') // Strip common prefixes
    .replace(/\.(com|org|net|co|io|us|uk|ca|de|fr|shop|store|health|beauty|wellness)(\.[a-z]{2})?$/i, '') // Strip TLDs
    .replace(/[^a-z0-9]/g, ''); // Remove remaining punctuation
}

/**
 * Check if a suggested domain is plausible for a brand.
 * This is a safety check to reject obviously unrelated domains.
 * 
 * Algorithm:
 * 1. Normalize brand (lowercase, remove punctuation, remove suffix words)
 * 2. Split brand into tokens, keep tokens with length >= 4
 * 3. Extract domain base (before TLD)
 * 4. Consider plausible if:
 *    - Any brand token (len>=4) is contained in domain base, OR
 *    - Domain base contains the brand's first 5 chars (after normalization)
 * 
 * Examples:
 * - brand="Evereden", domain="evereden.com" → true (token match)
 * - brand="Bettr.", domain="betrhealth.com" → false (no 4-char token, first 5 "bettr" not in "betrhealth")
 * - brand="Dr Teals", domain="drteals.com" → true (first 5 chars "drtea" in "drteals")
 */
export function isSuggestedDomainPlausible(brand: string, domain: string): boolean {
  if (!brand || !domain) return false;
  
  // Reject hosted storefront domains (not canonical brand domains)
  if (isHostedStorefront(domain)) {
    return false;
  }
  
  // Normalize brand
  const normalizedBrand = normalizeForComparison(brand);
  const brandNoSpaces = normalizedBrand.replace(/\s+/g, '');
  
  // Extract brand tokens (length >= 4)
  const brandTokens = normalizedBrand.split(/\s+/).filter(t => t.length >= 4);
  
  // Extract domain base
  const domainBase = extractDomainBase(domain);
  
  // Check 1: Any brand token (len>=4) is contained in domain
  for (const token of brandTokens) {
    if (domainBase.includes(token)) {
      return true;
    }
  }
  
  // Check 2: Domain base contains the brand's first 5 chars
  if (brandNoSpaces.length >= 5) {
    const first5 = brandNoSpaces.substring(0, 5);
    if (domainBase.includes(first5)) {
      return true;
    }
  } else if (brandNoSpaces.length >= 3) {
    // For short brands (3-4 chars), use the whole brand
    if (domainBase.includes(brandNoSpaces)) {
      return true;
    }
  }
  
  return false;
}

// Keep the old function name as an alias for backward compatibility
export const doesDomainMatchBrand = isSuggestedDomainPlausible;

/**
 * THE authoritative resolver for brand domains.
 * This is the ONLY function that decides "which domain wins".
 * 
 * Precedence (strict - do not deviate):
 * 1. Registry (Redis-backed) → source: 'registry'
 * 2. Suggested domain (if valid AND plausible for brand) → source: 'suggested'
 * 3. None → source: 'none'
 * 
 * No hardcoded mappings - all data comes from Redis.
 */
export async function resolveAuthoritativeBrandDomain(
  brand: string,
  suggestedDomain?: string | null
): Promise<BrandDomainResolution> {
  // 1. Check Redis-backed registry first (always wins)
  if (brand) {
    const registryDomain = await getBrandDomainFromRegistry(brand);
    if (registryDomain) {
      return { domain: registryDomain, source: 'registry' };
    }
  }
  
  // 2. Use suggested domain if valid (contains dot, no spaces, not garbage)
  if (suggestedDomain && typeof suggestedDomain === 'string') {
    const cleaned = suggestedDomain.trim();
    const looksLikeDomain = cleaned.includes('.') && !cleaned.includes(' ') && cleaned.length > 3;
    
    if (looksLikeDomain) {
      // Phase 4: Domain mismatch protection
      // Reject suggested domains that don't plausibly match the brand name
      if (brand && !isSuggestedDomainPlausible(brand, cleaned)) {
        console.log(`[brand-map] ⚠ Rejected implausible domain: brand="${brand}" suggested="${cleaned}"`);
        return { domain: null, source: 'none' };
      }
      return { domain: cleaned, source: 'suggested' };
    }
  }
  
  // 3. No valid domain found
  return { domain: null, source: 'none' };
}

/**
 * Store brand metadata (product type, category hints, etc.)
 */
export async function setBrandMetadata(brandName: string, metadata: BrandMetadata): Promise<void> {
  if (!brandName) return;
  try {
    const key = `brandmeta:${brandName.toLowerCase().trim()}`;
    await redisCall("SET", key, JSON.stringify(metadata));
  } catch (err) {
    console.warn("brand-metadata write failed", err);
  }
}

/**
 * Retrieve brand metadata
 */
export async function getBrandMetadata(brandName: string): Promise<BrandMetadata | null> {
  if (!brandName) return null;
  try {
    const key = `brandmeta:${brandName.toLowerCase().trim()}`;
    const resp = await redisCall("GET", key);
    const raw = resp?.result;
    if (typeof raw !== "string" || !raw) return null;
    try {
      return JSON.parse(raw);
    } catch (err) {
      console.warn("brand-metadata parse failed", err);
      return null;
    }
  } catch (err) {
    console.warn("brand-metadata read failed", err);
    return null;
  }
}
