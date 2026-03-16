/**
 * Rainforest API — Brand-first Amazon search
 *
 * Strategy:
 *   1. Search Amazon by BRAND NAME only (broad) → returns the full product catalogue
 *      for that brand in one shot.
 *   2. Score/match each result against the product name we're looking for.
 *   3. Auto-populate the brand registry with EVERY unique ASIN found (fire-and-forget),
 *      so future runs skip keyword search entirely and go straight to ASIN lookup.
 *   4. Return the best matching result with price + ASIN, or null if no match.
 *
 * API docs: https://docs.trajectdata.com/rainforestapi/product-data-api/parameters/search
 * Base URL: https://api.rainforestapi.com/request
 * Env var:  RAINFOREST (API key)
 */

import { saveAmazonAsin } from './brand-registry.js';

const RAINFOREST_KEY = process.env.RAINFOREST;
const RAINFOREST_BASE = 'https://api.rainforestapi.com/request';

// Multi-pack / lot patterns — skip these results (same as amazon-search)
const LOT_BUNDLE_PATTERNS: RegExp[] = [
  /\bpack\s+of\s+\d+/i,
  /\b\d+\s*-?\s*pack\b/i,
  /\blot\s+of\s+\d+/i,
  /\bset\s+of\s+\d+/i,
  /\bbundle\s+of\s+\d+/i,
  /\(\s*pack\s+of\s+\d+\s*\)/i,
  /,\s*\d+\s*pack\b/i,
  /\bqty\s*:?\s*\d+\b/i,
  /\b[3-9][\s-]*pack\b/i,   // 3-pack and above only (2-pack handled by unit_price check)
  /\bset\s*:/i,
  /\bcombo\b/i,
  /\bkit\b/i,
  /\b\d+[\s-]*piece\b/i,
];

export interface RainforestSearchResult {
  asin: string;
  title: string;
  brand: string;
  price: number | null;
  rrpPrice: number | null;
  url: string;
  rating: number | null;
  ratingsTotal: number;
  unitPrice: string | null;
  recentSales: string | null;
  isPrime: boolean;
  sponsored: boolean;
  image: string | null;
}

export interface RainforestMatchResult {
  /** Best matched result, or null if nothing scored high enough */
  match: RainforestSearchResult | null;
  /** All unique results (for bulk-registry population) */
  allResults: RainforestSearchResult[];
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Search Amazon via Rainforest by brand name, then find the best product match.
 * Automatically saves all discovered ASINs to the brand registry as a side-effect.
 *
 * @param brand       Brand name to search (e.g. "Cymbiotika")
 * @param productName Product name to match within the results (e.g. "Irish Sea Moss")
 * @param maxResults  How many search results to fetch (max 20 for 1 credit)
 */
export async function searchRainforestByBrand(
  brand: string,
  productName: string,
  maxResults = 20
): Promise<RainforestMatchResult> {
  const noMatch: RainforestMatchResult = {
    match: null,
    allResults: [],
    confidence: 'low',
    reasoning: 'rainforest-no-match',
  };

  if (!RAINFOREST_KEY) {
    console.log('[rainforest] RAINFOREST env var not set — skipping');
    return { ...noMatch, reasoning: 'RAINFOREST key not configured' };
  }

  if (!brand) {
    return { ...noMatch, reasoning: 'no brand supplied' };
  }

  console.log(`[rainforest] Searching brand="${brand}" product="${productName}"`);

  let rawResults: any[];
  try {
    rawResults = await fetchRainforestSearch(brand, maxResults);
  } catch (err) {
    console.error('[rainforest] API error:', err instanceof Error ? err.message : String(err));
    return { ...noMatch, reasoning: `API error: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!rawResults.length) {
    console.log(`[rainforest] No results for brand "${brand}"`);
    return { ...noMatch, reasoning: 'no results returned' };
  }

  // Normalise into our shape and deduplicate by ASIN
  const seen = new Set<string>();
  const results: RainforestSearchResult[] = [];
  for (const r of rawResults) {
    const asin: string = r.asin ?? '';
    if (!asin || seen.has(asin)) continue;
    seen.add(asin);

    const primaryPrice = r.price?.value ?? null;
    const rrpEntry = (r.prices ?? []).find((p: any) => p.is_rrp);
    const rrpPrice: number | null = rrpEntry?.value ?? null;

    // Build a clean /dp/ URL from the ASIN (the raw link may be a tracking redirect)
    const url = `https://www.amazon.com/dp/${asin}`;

    results.push({
      asin,
      title: r.title ?? '',
      brand: r.brand ?? brand,
      price: typeof primaryPrice === 'number' && primaryPrice > 0 ? primaryPrice : null,
      rrpPrice: typeof rrpPrice === 'number' && rrpPrice > 0 ? rrpPrice : null,
      url,
      rating: typeof r.rating === 'number' ? r.rating : null,
      ratingsTotal: typeof r.ratings_total === 'number' ? r.ratings_total : 0,
      unitPrice: r.unit_price ?? null,
      recentSales: r.recent_sales ?? null,
      isPrime: Boolean(r.is_prime),
      sponsored: Boolean(r.sponsored),
      image: r.image ?? null,
    });
  }

  console.log(`[rainforest] ${results.length} unique ASINs found for brand "${brand}"`);

  // ── Auto-populate brand registry (fire-and-forget) ──────────────────────
  // Store every product found under this brand so future lookups skip search.
  populateBrandRegistry(brand, results).catch(err =>
    console.warn('[rainforest] registry population error:', err instanceof Error ? err.message : String(err))
  );

  // ── Match the best result against our product name ───────────────────────
  const match = scoreResults(results, productName);

  if (!match) {
    console.log(`[rainforest] No matching product found for "${brand} ${productName}"`);
    return { match: null, allResults: results, confidence: 'low', reasoning: 'no title match' };
  }

  const confidence = deriveConfidence(match.score, match.result);
  console.log(
    `[rainforest] ✅ Best match: "${match.result.title.slice(0, 70)}" ` +
    `ASIN=${match.result.asin} price=$${match.result.price} confidence=${confidence} score=${match.score}`
  );

  return {
    match: match.result,
    allResults: results,
    confidence,
    reasoning: `rainforest brand-search score=${match.score} reasons=[${match.reasons.join(', ')}]`,
  };
}

// ---------------------------------------------------------------------------
// Rainforest API call
// ---------------------------------------------------------------------------

async function fetchRainforestSearch(brand: string, maxResults: number): Promise<any[]> {
  const url = new URL(RAINFOREST_BASE);
  url.searchParams.set('api_key', RAINFOREST_KEY!);
  url.searchParams.set('type', 'search');
  url.searchParams.set('amazon_domain', 'amazon.com');
  url.searchParams.set('search_term', brand);
  url.searchParams.set('number_of_results', String(maxResults));
  url.searchParams.set('exclude_sponsored', 'false'); // include — many brand results ARE sponsored
  url.searchParams.set('sort_by', 'featured'); // featured first → most relevant products

  const res = await fetch(url.toString());
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const data: any = await res.json();
  if (!data.request_info?.success) {
    throw new Error(`API unsuccessful: ${JSON.stringify(data).slice(0, 200)}`);
  }

  return Array.isArray(data.search_results) ? data.search_results : [];
}

// ---------------------------------------------------------------------------
// Scoring / matching
// ---------------------------------------------------------------------------

interface ScoredResult {
  result: RainforestSearchResult;
  score: number;
  reasons: string[];
}

function scoreResults(results: RainforestSearchResult[], productName: string): ScoredResult | null {
  if (!productName) return null;

  const scored: ScoredResult[] = [];

  // Extract significant words from productName for matching
  const GENERIC = new Set([
    'supplement', 'capsules', 'tablets', 'pills', 'powder', 'formula', 'complex',
    'blend', 'extract', 'bottle', 'pack', 'count', 'serving', 'servings', 'vitamin',
    'vitamins', 'cream', 'serum', 'lotion', 'stick', 'packet', 'packets', 'support',
    'health', 'boost', 'plus', 'pro', 'ultra', 'advanced', 'daily',
  ]);

  const productWords = productName
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !GENERIC.has(w));

  for (const r of results) {
    // Must have a price to be useful
    if (!r.price) continue;

    // Skip lot/bundle listings
    if (LOT_BUNDLE_PATTERNS.some(p => p.test(r.title))) {
      console.log(`[rainforest] skip lot/bundle: "${r.title.slice(0, 55)}"`);
      continue;
    }

    const titleLower = r.title.toLowerCase();
    const reasons: string[] = [];
    let score = 0;

    // Count product-word hits in title
    const hits = productWords.filter(w => titleLower.includes(w));
    const hitRatio = productWords.length > 0 ? hits.length / productWords.length : 0;

    if (hits.length === 0) continue; // zero overlap → definitely wrong product

    // For short product names (≤4 significant words), ALL words must appear in the title.
    // e.g. "ReLive Greens" → both 'relive' AND 'greens' must match, not just 'greens'.
    // This prevents a generic greens product matching when only 'greens' overlaps.
    if (productWords.length <= 4 && hitRatio < 1.0) {
      console.log(`[rainforest] skip partial match (${hits.length}/${productWords.length} words): "${r.title.slice(0, 55)}"`);
      continue;
    }

    score += Math.round(hitRatio * 60); // up to 60 pts for word match
    reasons.push(`words=${hits.length}/${productWords.length}`);

    // Bonus: non-sponsored result is more trustworthy ordering-wise
    if (!r.sponsored) {
      score += 10;
      reasons.push('organic');
    }

    // Bonus: high ratings
    if (r.rating && r.rating >= 4.0) {
      score += 5;
      reasons.push(`${r.rating}★`);
    }
    if (r.ratingsTotal >= 100) {
      score += 5;
      reasons.push(`${r.ratingsTotal} reviews`);
    }

    // Bonus: recent sales signal (popular product)
    if (r.recentSales && /\dk?\+/i.test(r.recentSales)) {
      score += 5;
      reasons.push('trending');
    }

    scored.push({ result: r, score, reasons });
  }

  if (!scored.length) return null;

  scored.sort((a, b) => b.score - a.score);
  return scored[0];
}

function deriveConfidence(score: number, result: RainforestSearchResult): 'high' | 'medium' | 'low' {
  if (score >= 60 && result.ratingsTotal >= 50) return 'high';
  if (score >= 30) return 'medium';
  return 'low';
}

// ---------------------------------------------------------------------------
// Auto-populate brand registry
// ---------------------------------------------------------------------------

/**
 * Extract a clean product name from a full Amazon title given a known brand.
 * Strips the brand prefix (case-insensitive) and cleans up punctuation.
 *
 * e.g. "CYMBIOTIKA Irish Sea Moss – Lemon Vanilla..." → "Irish Sea Moss Lemon Vanilla"
 */
function extractProductName(title: string, brand: string): string {
  // Remove brand prefix (case-insensitive)
  const brandPattern = new RegExp(`^\\s*${escapeRegex(brand)}\\s*[–—\\-:]?\\s*`, 'i');
  let name = title.replace(brandPattern, '');

  // Take only up to the first long dash / bullet separator (the rest is marketing copy)
  name = name.split(/\s*[–—]\s*/)[0];

  // Trim and collapse whitespace
  name = name.replace(/\s+/g, ' ').trim();

  return name.slice(0, 120); // cap length
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Save all unique ASINs found in a brand search to the brand registry.
 * Uses the extracted product name as the registry key.
 * This runs fire-and-forget so it never blocks the pricing pipeline.
 */
async function populateBrandRegistry(brand: string, results: RainforestSearchResult[]): Promise<void> {
  let saved = 0;
  for (const r of results) {
    if (!r.asin) continue;
    const productName = extractProductName(r.title, brand);
    if (!productName) continue;

    try {
      await saveAmazonAsin(brand, productName, r.asin, false);
      saved++;
    } catch {
      // Non-fatal — continue with remaining
    }
  }
  if (saved > 0) {
    console.log(`[rainforest] 🗂 Auto-registered ${saved} ASINs for brand "${brand}"`);
  }
}
