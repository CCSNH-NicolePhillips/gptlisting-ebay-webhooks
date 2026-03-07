/**
 * Google Lens Image Search for Pricing Fallback
 *
 * Used when Amazon lookup fails (product not listed on Amazon).
 * Performs a Google Lens visual/product search via SerpApi to find
 * retail pricing from the brand's own site, Target, Walmart, etc.
 *
 * Design principle: fail-open, silence-safe.
 * Any error → return null price. Never throw. Never block pricing.
 */

import { canUseSerp, incSerp } from '../../../../src/lib/price-quota.js';

const SERPAPI_BASE = 'https://serpapi.com/search';
const REQUEST_TIMEOUT_MS = 10_000;

/** Domains to skip — eBay, auction sites, and user-gen content */
const SKIP_SOURCES = new Set([
  'ebay', 'eBay',
  'mercari', 'Mercari',
  'poshmark', 'Poshmark',
  'facebook', 'Facebook',
  'instagram', 'Instagram',
  'pinterest', 'Pinterest',
  'reddit', 'Reddit',
  'tiktok', 'TikTok',
]);

export interface ImageSearchResult {
  price: number | null;
  source: string | null;
  title: string | null;
  url: string | null;
  /** true when SERPAPI_KEY is absent or quota was exhausted */
  skipped: boolean;
}

/**
 * Perform a Google Lens product search using the product's front image URL.
 * Returns the best retail price found (brand site > big-box retail > generic).
 *
 * @param imageUrl  Publicly accessible HTTPS URL of the product image.
 *                  Returns skipped=true if imageUrl is a local file path.
 */
export async function searchByGoogleLens(imageUrl: string): Promise<ImageSearchResult> {
  const empty: ImageSearchResult = { price: null, source: null, title: null, url: null, skipped: false };

  // Local/relative paths can't be sent to SerpApi
  if (!imageUrl.startsWith('http://') && !imageUrl.startsWith('https://')) {
    console.log('[serp-image] Image URL is not public HTTP(S) — skipping Google Lens');
    return { ...empty, skipped: true };
  }

  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    console.log('[serp-image] No SERPAPI_KEY — skipping Google Lens');
    return { ...empty, skipped: true };
  }

  // ── Quota check ──────────────────────────────────────────────────────────
  let allowed = true;
  try {
    allowed = await canUseSerp();
  } catch {
    allowed = true; // fail-open
  }

  if (!allowed) {
    console.log('[serp-image] Monthly SERP quota exceeded — skipping Google Lens');
    return { ...empty, skipped: true };
  }

  // ── Network call ─────────────────────────────────────────────────────────
  try {
    const url = new URL(SERPAPI_BASE);
    url.searchParams.set('engine', 'google_lens');
    url.searchParams.set('url', imageUrl);
    url.searchParams.set('type', 'products');  // product matches with prices
    url.searchParams.set('api_key', apiKey);

    console.log(`[serp-image] Google Lens product search for image: ${imageUrl.slice(0, 80)}...`);

    const response = await fetch(url.toString(), {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      console.warn(`[serp-image] HTTP ${response.status} from SerpApi Google Lens — skipping`);
      return empty;
    }

    // Count quota after a successful HTTP response
    await incSerp().catch(() => { /* non-fatal */ });

    const data = await response.json() as Record<string, unknown>;

    const matches: unknown[] = (data.visual_matches as unknown[] | undefined) ?? [];

    if (matches.length === 0) {
      console.log('[serp-image] Google Lens returned no visual matches');
      return empty;
    }

    // Find best retail price — prefer brand/retail over secondary markets
    for (const match of matches) {
      const m = match as Record<string, unknown>;

      const source: string = (m.source as string | undefined) ?? '';
      if (SKIP_SOURCES.has(source)) continue;

      const priceObj = m.price as Record<string, unknown> | undefined;
      if (!priceObj) continue;

      const extracted = priceObj.extracted_value as number | undefined;
      if (!extracted || extracted <= 0) continue;

      // Sanity check: skip prices that are suspiciously high (>$500) or low (<$1)
      if (extracted < 1 || extracted > 500) continue;

      const title = (m.title as string | undefined) ?? '';
      const link = (m.link as string | undefined) ?? '';

      console.log(`[serp-image] Found retail price $${extracted.toFixed(2)} from "${source}" — "${title.slice(0, 60)}"`);
      return {
        price: extracted,
        source,
        title,
        url: link,
        skipped: false,
      };
    }

    console.log('[serp-image] Google Lens found matches but none had usable retail prices');
    return empty;

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[serp-image] Google Lens error — ${msg}`);
    return empty;
  }
}
