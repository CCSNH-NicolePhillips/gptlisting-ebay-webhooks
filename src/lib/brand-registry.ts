/**
 * Brand Registry
 * 
 * Stores brand → Amazon ASIN mappings to solve the "wrong brand search" problem.
 * Instead of relying on Brave search to find the right product, we can store
 * known ASINs and construct direct Amazon URLs.
 * 
 * Storage: Upstash Redis REST API
 * Key format: brand:asin:{normalizedBrand}:{normalizedProduct}
 * TTL: 90 days (products don't change ASINs often)
 */

interface BrandRegistryEntry {
  asin: string;
  url: string;
  brand: string;
  product: string;
  addedAt: number;
  verified: boolean;
}

const BASE = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";

async function redisCall(...parts: string[]): Promise<{ result: unknown } | null> {
  if (!BASE || !TOKEN) return null;
  
  const encoded = parts.map((p) => encodeURIComponent(p));
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

function normalizeKey(str: string): string {
  // Remove special chars, lowercase, trim
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '').trim();
}

function buildKey(brand: string, product: string): string {
  const normBrand = normalizeKey(brand);
  const normProduct = normalizeKey(product);
  return `brand:asin:${normBrand}:${normProduct}`;
}

/**
 * Get Amazon ASIN for a brand + product
 */
export async function getAmazonAsin(brand: string, product: string): Promise<string | null> {
  try {
    const key = buildKey(brand, product);
    const resp = await redisCall("GET", key);
    
    if (!resp || !resp.result) {
      console.log(`[brand-registry] No ASIN found for: ${brand} ${product}`);
      return null;
    }
    
    const entry = typeof resp.result === 'string' ? JSON.parse(resp.result) : resp.result;
    console.log(`[brand-registry] ✓ Found ASIN: ${entry.asin} for ${brand} ${product}`);
    return entry.asin;
  } catch (error) {
    console.error('[brand-registry] Lookup error:', error);
    return null;
  }
}

/**
 * Save Amazon ASIN for a brand + product
 * No expiration - UPC/ASIN mappings are stable
 */
export async function saveAmazonAsin(
  brand: string, 
  product: string, 
  asin: string,
  verified = false
): Promise<void> {
  try {
    const key = buildKey(brand, product);
    const entry: BrandRegistryEntry = {
      asin,
      url: `https://www.amazon.com/dp/${asin}`,
      brand,
      product,
      addedAt: Date.now(),
      verified,
    };
    
    // No TTL - permanent storage (UPC/ASIN mappings don't change)
    await redisCall("SET", key, JSON.stringify(entry));
    console.log(`[brand-registry] ✓ Saved ASIN ${asin} for: ${brand} ${product} (verified: ${verified})`);
  } catch (error) {
    console.error('[brand-registry] Save error:', error);
  }
}

/**
 * Get all registered brands (for admin UI)
 */
export async function listBrandRegistry(userId?: string): Promise<BrandRegistryEntry[]> {
  try {
    const pattern = userId ? `brand:asin:${userId}:*` : 'brand:asin:*';
    const resp = await redisCall("KEYS", pattern);
    
    if (!resp || !Array.isArray(resp.result) || resp.result.length === 0) {
      return [];
    }
    
    const entries: BrandRegistryEntry[] = [];
    for (const key of resp.result) {
      const dataResp = await redisCall("GET", key as string);
      if (dataResp && dataResp.result) {
        const entry = typeof dataResp.result === 'string' ? JSON.parse(dataResp.result) : dataResp.result;
        entries.push(entry);
      }
    }
    
    return entries.sort((a, b) => b.addedAt - a.addedAt);
  } catch (error) {
    console.error('[brand-registry] List error:', error);
    return [];
  }
}

/**
 * Delete a brand registry entry
 */
export async function deleteAmazonAsin(brand: string, product: string): Promise<boolean> {
  try {
    const key = buildKey(brand, product);
    const resp = await redisCall("DEL", key);
    const deleted = !!(resp && typeof resp.result === 'number' && resp.result > 0);
    console.log(`[brand-registry] Deleted entry for: ${brand} ${product}`);
    return deleted;
  } catch (error) {
    console.error('[brand-registry] Delete error:', error);
    return false;
  }
}
