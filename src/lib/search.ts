import { canUseBrave, incBrave } from "./price-quota.js";

// ============================================================================
// MINIMAL BRAVE SEARCH - BRAND SITES ONLY
// ============================================================================
// Brave is now a "side quest" - only used for finding official brand sites
// No more Walmart/Amazon queries, no complex rate limiting
// ============================================================================

/**
 * Simple local rate limiting: wait 500ms between calls within this invocation
 * Since Brave is rarely used now, we don't need cross-instance coordination
 */
let lastCallTime = 0;
async function simpleRateLimit(): Promise<void> {
  const now = Date.now();
  const timeSince = now - lastCallTime;
  if (timeSince < 500) {
    await new Promise(resolve => setTimeout(resolve, 500 - timeSince));
  }
  lastCallTime = Date.now();
}

/**
 * Helper: Extract first URL from Brave search results
 */
function pickFirstUrl(results: any): string | null {
  if (!results) return null;
  const arr = Array.isArray(results) ? results : [];
  for (const entry of arr) {
    const value = entry?.url;
    if (typeof value === "string" && value) {
      return value;
    }
  }
  return null;
}

/**
 * Find first URL from Brave search (generic query)
 * Used by legacy code - prefer braveFirstUrlForBrandSite when possible
 */
export async function braveFirstUrl(query: string, site?: string): Promise<string | null> {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) return null;
  if (!(await canUseBrave())) return null;

  await simpleRateLimit();

  const targetQuery = site ? `${query} site:${site}` : query;
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", targetQuery);
  url.searchParams.set("count", "5");

  // Retry logic for rate limiting (429 errors)
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url.toString(), {
        headers: { "X-Subscription-Token": apiKey },
      });
      
      // Handle 429 rate limit with retry
      if (res.status === 429 && attempt < maxRetries) {
        // Check for Retry-After header (recommended by API specs)
        const retryAfter = res.headers.get('Retry-After');
        let delay: number;
        
        if (retryAfter) {
          // Retry-After can be either seconds or HTTP date
          const retrySeconds = parseInt(retryAfter, 10);
          if (!isNaN(retrySeconds)) {
            delay = retrySeconds * 1000; // Convert to milliseconds
            console.warn(`[Brave] Rate limited (429), Retry-After: ${retrySeconds}s (attempt ${attempt}/${maxRetries})`);
          } else {
            // If it's a date, calculate delay
            const retryDate = new Date(retryAfter);
            delay = Math.max(0, retryDate.getTime() - Date.now());
            console.warn(`[Brave] Rate limited (429), Retry-After: ${retryAfter} (attempt ${attempt}/${maxRetries})`);
          }
        } else {
          // Fallback: use exponential backoff with jitter if no Retry-After header
          delay = 1000 + Math.random() * 1000; // 1-2 seconds
          console.warn(`[Brave] Rate limited (429), no Retry-After header, using ${Math.round(delay)}ms delay (attempt ${attempt}/${maxRetries})`);
        }
        
        // Cap delay at 10 seconds to avoid excessive waits
        delay = Math.min(delay, 10000);
        
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      if (!res.ok) {
        console.warn(`[Brave] API returned ${res.status}`);
        return null;
      }
      await incBrave();
      const data: any = await res.json();
      const found = pickFirstUrl(data?.web?.results);
      console.log(`[Brave] Query: "${targetQuery}" → ${found || "(no results)"}`);
      return found ?? null;
    } catch (err) {
      if (attempt === maxRetries) {
        console.warn("[Brave] Search failed:", err);
        return null;
      }
      // Retry on network errors too
      const delay = 1000 + Math.random() * 1000;
      console.warn(`[Brave] Request failed, retrying in ${Math.round(delay)}ms (attempt ${attempt}/${maxRetries})`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  return null;
}

/**
 * Find official brand site URL
 * Prefers site-specific search when brand domain is known
 * Filters out major retailers (Amazon, Walmart, eBay, etc.)
 */
export async function braveFirstUrlForBrandSite(
  brandName: string,
  productTitle: string,
  brandDomain?: string
): Promise<string | null> {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) return null;
  if (!(await canUseBrave())) return null;

  await simpleRateLimit();

  // Prefer site-specific search if brand domain known
  const query = brandDomain
    ? `${productTitle} site:${brandDomain}`
    : `${brandName} ${productTitle}`;

  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", "5");

  // Retry logic for rate limiting (429 errors)
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url.toString(), {
        headers: { "X-Subscription-Token": apiKey },
      });
      
      // Handle 429 rate limit with retry
      if (res.status === 429 && attempt < maxRetries) {
        // Check for Retry-After header (recommended by API specs)
        const retryAfter = res.headers.get('Retry-After');
        let delay: number;
        
        if (retryAfter) {
          // Retry-After can be either seconds or HTTP date
          const retrySeconds = parseInt(retryAfter, 10);
          if (!isNaN(retrySeconds)) {
            delay = retrySeconds * 1000; // Convert to milliseconds
            console.warn(`[Brave] Rate limited (429), Retry-After: ${retrySeconds}s (attempt ${attempt}/${maxRetries})`);
          } else {
            // If it's a date, calculate delay
            const retryDate = new Date(retryAfter);
            delay = Math.max(0, retryDate.getTime() - Date.now());
            console.warn(`[Brave] Rate limited (429), Retry-After: ${retryAfter} (attempt ${attempt}/${maxRetries})`);
          }
        } else {
          // Fallback: use exponential backoff with jitter if no Retry-After header
          delay = 1000 + Math.random() * 1000; // 1-2 seconds
          console.warn(`[Brave] Rate limited (429), no Retry-After header, using ${Math.round(delay)}ms delay (attempt ${attempt}/${maxRetries})`);
        }
        
        // Cap delay at 10 seconds to avoid excessive waits
        delay = Math.min(delay, 10000);
        
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      if (!res.ok) {
        console.warn(`[Brave] API returned ${res.status}`);
        return null;
      }
      await incBrave();
      const data: any = await res.json();
      const results = data?.web?.results || [];

      // Filter out major retailers
      const retailerDomains = [
        'amazon.com', 'walmart.com', 'ebay.com', 'target.com',
        'bestbuy.com', 'homedepot.com', 'lowes.com', 'costco.com'
      ];

      for (const entry of results) {
        const foundUrl = entry?.url;
        if (!foundUrl || typeof foundUrl !== 'string') continue;

        // Skip retailers
        const isRetailer = retailerDomains.some(domain => foundUrl.includes(domain));
        if (isRetailer) continue;

        console.log(`[Brave] Brand site for "${brandName}": ${foundUrl}`);
        return foundUrl;
      }

      console.log(`[Brave] No brand site found for "${brandName}" (only retailers)`);
      return null;
    } catch (err) {
      if (attempt === maxRetries) {
        console.warn("[Brave] Brand search failed:", err);
        return null;
      }
      // Retry on network errors too
      const delay = 1000 + Math.random() * 1000;
      console.warn(`[Brave] Request failed, retrying in ${Math.round(delay)}ms (attempt ${attempt}/${maxRetries})`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  return null;
}
