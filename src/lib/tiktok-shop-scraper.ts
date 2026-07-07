/**
 * TikTok Shop PDP metadata scraper.
 *
 * Loads a pinned TikTok Shop product page via a hosted Browserless.io session
 * (residential proxy + stealth, both handled by Browserless's own connection query
 * params) and reads the product's own price/title/image straight out of the raw
 * server-rendered HTML — specifically the `__MODERN_ROUTER_DATA__` script tag, a
 * Modern.js router data blob embedded in the initial response.
 *
 * The HTML is captured from the network response directly (not read off the DOM
 * after the page settles), because React hydration empties that script tag's
 * content shortly after load — reading it from `document.getElementById(...)` after
 * any wait returns a near-empty stub instead of the real payload.
 *
 * `__MODERN_SSR_DATA__` (a similarly-named sibling tag) was the first guess based on
 * naming convention, but only ever contains routing/i18n context, never product
 * data — confirmed by diffing several real page loads.
 *
 * Metadata only: does not download or process video content, and does not attempt
 * to read the video-carousel endpoint (`pdp_desktop/page_data`'s lazy-loaded
 * `video_list` component), since that requires a second authenticated POST that is
 * the actual source of TikTok's bot-check hits in practice, per prior scraping work
 * against this same site. Never throws — returns null on any failure so callers
 * (e.g. amazon-search.ts) can fall through cleanly to their next pricing source.
 * There is deliberately no retry loop.
 */

import { chromium, type Page } from 'playwright-core';

export interface TikTokShopProductResult {
  price: number | null;
  originalPrice: number | null;
  title: string | null;
  brand: string | null;
  imageUrl: string | null;
  /** Always null for now — video-carousel data isn't read (see module doc). */
  videoUrl: string | null;
  confidence: 'high' | 'low';
  reasoning: string;
}

export interface TikTokShopSearchResult {
  productId: string;
  title: string;
  brand: string | null;
  shopName: string | null;
  price: number | null;
  originalPrice: number | null;
  url: string;
  imageUrl: string | null;
  rating: number | null;
  reviewCount: number | null;
  soldCount: number | null;
}

const TITLE_WAIT_MS = 12_000;
const HTML_SETTLE_WAIT_MS = 4_000;

/**
 * Scrape a pinned TikTok Shop product URL for its current price/title/image.
 * Never throws — returns null on any failure so callers (e.g. amazon-search.ts)
 * can fall through cleanly to their next source.
 */
export async function scrapeTikTokShopProduct(url: string): Promise<TikTokShopProductResult | null> {
  const key = process.env.BROWSERLESS_API_KEY;
  if (!key) {
    console.warn('[tiktok-shop-scraper] BROWSERLESS_API_KEY not set — skipping scrape');
    return null;
  }

  try {
    return await tryOnce(key, url);
  } catch (err) {
    console.warn('[tiktok-shop-scraper] Scrape failed (non-fatal):', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Search TikTok Shop for a keyword (e.g. "brand + product name") and return the
 * raw list of result cards from the `feed_list_search_word` component — same
 * `__MODERN_ROUTER_DATA__` SSR-blob technique as scrapeTikTokShopProduct(), just
 * read from `https://www.tiktok.com/shop/s?q=...` instead of a known PDP URL.
 * Never throws — returns [] on any failure so callers fall through cleanly.
 */
export async function searchTikTokShop(query: string, region = 'US'): Promise<TikTokShopSearchResult[]> {
  const key = process.env.BROWSERLESS_API_KEY;
  if (!key) {
    console.warn('[tiktok-shop-scraper] BROWSERLESS_API_KEY not set — skipping search');
    return [];
  }

  try {
    return await trySearchOnce(key, query, region);
  } catch (err) {
    console.warn('[tiktok-shop-scraper] Search failed (non-fatal):', err instanceof Error ? err.message : String(err));
    return [];
  }
}

async function trySearchOnce(key: string, query: string, region: string): Promise<TikTokShopSearchResult[]> {
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;

  try {
    const connected = await connectStealthContext(key);
    browser = connected.browser;
    const ctx = connected.ctx;

    const searchUrl = `https://www.tiktok.com/shop/s?q=${encodeURIComponent(query)}&region=${region}`;
    let rawHtml = '';
    const page = await ctx.newPage();
    page.on('response', async (res) => {
      if (rawHtml) return;
      try {
        if (res.url().startsWith('https://www.tiktok.com/shop/s') && (res.headers()['content-type'] ?? '').includes('text/html')) {
          rawHtml = await res.text();
        }
      } catch { /* ignore */ }
    });

    // Warm up with TikTok homepage first — a real user has browsing history.
    try {
      await page.goto('https://www.tiktok.com/', { waitUntil: 'commit', timeout: 15_000 });
      await sleep(8_000);
    } catch { /* non-fatal — proceed without warm-up */ }

    try {
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 40_000 });
    } catch (navErr) {
      console.log(`[tiktok-shop-scraper] search nav failed — ${navErr instanceof Error ? navErr.message.slice(0, 80) : 'connection error'}`);
      return [];
    }

    const title = await waitForTitle(page, TITLE_WAIT_MS);
    if (title === 'Security Check') {
      console.log('[tiktok-shop-scraper] search CAPTCHA — giving up (no retry)');
      return [];
    }
    if (!title) {
      console.log(`[tiktok-shop-scraper] search: blank title after ${TITLE_WAIT_MS}ms — heavy block`);
      return [];
    }

    await sleep(HTML_SETTLE_WAIT_MS);
    if (!rawHtml) {
      try {
        rawHtml = await page.content();
      } catch { /* fall through to failure below */ }
    }
    if (!rawHtml) {
      console.log('[tiktok-shop-scraper] search: could not capture page HTML');
      return [];
    }

    const routerMatch = rawHtml.match(/<script[^>]*id="__MODERN_ROUTER_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!routerMatch) {
      console.log('[tiktok-shop-scraper] search: __MODERN_ROUTER_DATA__ tag not found');
      return [];
    }

    let routerData: Record<string, unknown>;
    try {
      routerData = JSON.parse(routerMatch[1]);
    } catch (err) {
      console.log('[tiktok-shop-scraper] search: failed to parse __MODERN_ROUTER_DATA__:', err instanceof Error ? err.message : err);
      return [];
    }

    return extractSearchResults(routerData);
  } finally {
    await browser?.close().catch(() => { /* ignore */ });
  }
}

/**
 * Digs into loaderData -> page_config.components_map for the component named
 * `feed_list_search_word` (the actual keyword search results, as opposed to the
 * sibling `feed_list_recommended_for_you` / `feed_list_frequently_bought_together`
 * components that ride along on the same page) and maps its product cards.
 */
function extractSearchResults(routerData: Record<string, unknown>): TikTokShopSearchResult[] {
  const loaderData = routerData.loaderData as Record<string, unknown> | undefined;
  if (!loaderData) return [];

  for (const value of Object.values(loaderData)) {
    const pageData = value as Record<string, unknown> | undefined;
    const pageConfig = pageData?.page_config as Record<string, unknown> | undefined;
    const componentsMap = pageConfig?.components_map as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(componentsMap)) continue;

    const searchComponent = componentsMap.find((c) => c.component_name === 'feed_list_search_word');
    const products = (searchComponent?.component_data as Record<string, unknown> | undefined)?.products;
    if (!Array.isArray(products)) continue;

    return products.map(mapSearchProduct).filter((p): p is TikTokShopSearchResult => p !== null);
  }

  return [];
}

function mapSearchProduct(raw: unknown): TikTokShopSearchResult | null {
  const p = raw as Record<string, unknown>;
  const productId = typeof p.product_id === 'string' ? p.product_id : null;
  const seoUrl = p.seo_url as Record<string, unknown> | undefined;
  const canonicalUrl = typeof seoUrl?.canonical_url === 'string' ? seoUrl.canonical_url : null;
  if (!productId || !canonicalUrl) return null;

  const priceInfo = p.product_price_info as Record<string, unknown> | undefined;
  const brandInfo = p.brand_info as Record<string, unknown> | undefined;
  const sellerInfo = p.seller_info as Record<string, unknown> | undefined;
  const rateInfo = p.rate_info as Record<string, unknown> | undefined;
  const soldInfo = p.sold_info as Record<string, unknown> | undefined;
  const image = p.image as Record<string, unknown> | undefined;
  const imageUrls = image?.url_list as string[] | undefined;

  return {
    productId,
    title: typeof p.title === 'string' ? p.title : '',
    brand: typeof brandInfo?.brand_name === 'string' ? brandInfo.brand_name : null,
    shopName: typeof sellerInfo?.shop_name === 'string' ? sellerInfo.shop_name : null,
    price: parseDecimalPrice(priceInfo?.sale_price_decimal),
    originalPrice: parseDecimalPrice(priceInfo?.origin_price_decimal),
    url: canonicalUrl,
    imageUrl: imageUrls?.[0] ?? null,
    rating: typeof rateInfo?.score === 'number' ? rateInfo.score : null,
    reviewCount: parseDecimalPrice(rateInfo?.review_count),
    soldCount: typeof soldInfo?.sold_count === 'number' ? soldInfo.sold_count : null,
  };
}

export interface TikTokShopMatch {
  result: TikTokShopSearchResult;
  score: number;
  confidence: 'high' | 'medium' | 'low';
}

// Same generic-word lists as amazon-search.ts's isTitleMatch()/weak-brand-match logic —
// duplicated rather than imported to avoid a circular import (amazon-search.ts imports
// this module for Step 1.5/Step 3.5's pin scrape and live search).
const GENERIC_BRAND_WORDS = new Set([
  'labs', 'lab', 'co', 'corp', 'inc', 'llc', 'brand', 'brands',
  'health', 'healthcare', 'wellness', 'nutrition', 'nutritional',
  'natural', 'naturals', 'pure', 'life', 'living', 'bio',
]);

const GENERIC_PRODUCT_TERMS = new Set([
  'capsules', 'tablets', 'pills', 'powder', 'supplement',
  'cream', 'serum', 'lotion', 'stick', 'pack', 'packs', 'count', 'serving', 'servings',
  'vitamin', 'vitamins', 'formula', 'complex', 'blend', 'extract', 'bottle', 'packet', 'packets',
]);

function normalizeWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .filter((w) => !['the', 'and', 'for', 'with', 'new'].includes(w));
}

/**
 * Picks the best brand/title match out of a TikTok Shop search result set, using the
 * same brand-word-overlap + specific-product-word-overlap approach as amazon-search.ts's
 * isTitleMatch() — but simpler, since TikTok search results are already keyword-filtered
 * (unlike Amazon's broader catalog, a wrong-brand result rarely surfaces here at all).
 * Returns null if nothing scores as a plausible match.
 */
export function pickBestTikTokShopMatch(
  results: TikTokShopSearchResult[],
  brand: string,
  productName: string,
): TikTokShopMatch | null {
  const brandWords = normalizeWords(brand);
  const specificBrandWords = brandWords.filter((w) => !GENERIC_BRAND_WORDS.has(w));
  const matchBrandWords = specificBrandWords.length > 0 ? specificBrandWords : brandWords;
  const specificProductWords = normalizeWords(productName).filter(
    (w) => !GENERIC_PRODUCT_TERMS.has(w) && !/^\d/.test(w),
  );

  let best: TikTokShopMatch | null = null;

  for (const r of results) {
    if (r.price === null || r.price <= 0) continue;

    const titleLower = r.title.toLowerCase();
    const brandLower = (r.brand ?? '').toLowerCase();
    const shopLower = (r.shopName ?? '').toLowerCase();

    const brandInTitle = matchBrandWords.some((w) => titleLower.includes(w));
    const brandInField = matchBrandWords.some((w) => brandLower.includes(w) || shopLower.includes(w));

    let score = 100;
    if (matchBrandWords.length > 0 && !brandInTitle && !brandInField) {
      // Weak brand match — require a majority of specific product-name words to survive.
      const wordsInTitle = specificProductWords.filter((w) => titleLower.includes(w));
      const required = Math.max(2, Math.ceil(specificProductWords.length * 0.6));
      if (specificProductWords.length > 0 && wordsInTitle.length < required) continue;
      score -= 20;
    } else if (brandInTitle || brandInField) {
      score += 10;
    }

    // Require at least one specific product word to overlap regardless of brand match —
    // otherwise a same-brand-different-product result could slip through.
    if (specificProductWords.length > 0) {
      const overlap = specificProductWords.filter((w) => titleLower.includes(w)).length;
      if (overlap === 0) continue;
      score += overlap * 3;
    }

    if (r.rating && r.rating >= 4.0) score += 5;
    if (r.reviewCount && r.reviewCount >= 20) score += 5;
    if (r.soldCount && r.soldCount >= 100) score += 5;

    if (!best || score > best.score) {
      best = { result: r, score, confidence: score >= 110 ? 'high' : score >= 90 ? 'medium' : 'low' };
    }
  }

  return best;
}

/**
 * Connects to a fresh stealth Browserless session (residential proxy, spoofed
 * navigator fingerprint) and returns a ready-to-navigate context. Shared by both
 * the single-PDP scraper and the search scraper below.
 */
async function connectStealthContext(key: string) {
  const region = process.env.BROWSERLESS_SHOP_REGION ?? 'production-sfo';
  const endpoint = `wss://${region}.browserless.io?token=${key}&proxy=residential&proxyCountry=us&stealth=true`;
  const browser = await chromium.connectOverCDP(endpoint, { timeout: 45_000 });

  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
  });

  await ctx.addInitScript(`
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}), app: {} };
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
  `);

  return { browser, ctx };
}

async function tryOnce(key: string, seedUrl: string): Promise<TikTokShopProductResult | null> {
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;

  try {
    const connected = await connectStealthContext(key);
    browser = connected.browser;
    const ctx = connected.ctx;

    let rawHtml = '';
    const page = await ctx.newPage();
    page.on('response', async (res) => {
      if (rawHtml) return;
      try {
        if (res.url() === seedUrl && (res.headers()['content-type'] ?? '').includes('text/html')) {
          rawHtml = await res.text();
        }
      } catch { /* ignore */ }
    });

    // Warm up with TikTok homepage first — a real user has browsing history.
    try {
      await page.goto('https://www.tiktok.com/', { waitUntil: 'commit', timeout: 15_000 });
      await sleep(8_000);
    } catch { /* non-fatal — proceed without warm-up */ }

    try {
      await page.goto(seedUrl, { waitUntil: 'domcontentloaded', timeout: 40_000 });
    } catch (navErr) {
      console.log(`[tiktok-shop-scraper] nav failed — ${navErr instanceof Error ? navErr.message.slice(0, 80) : 'connection error'}`);
      return null;
    }

    const title = await waitForTitle(page, TITLE_WAIT_MS);
    if (title === 'Security Check') {
      console.log('[tiktok-shop-scraper] CAPTCHA — giving up (no retry)');
      return null;
    }
    if (!title) {
      console.log(`[tiktok-shop-scraper] blank title after ${TITLE_WAIT_MS}ms — heavy block`);
      return null;
    }

    // Give the response listener a moment to catch the document body if the
    // navigation event fired before it attached.
    await sleep(HTML_SETTLE_WAIT_MS);
    if (!rawHtml) {
      try {
        rawHtml = await page.content();
      } catch { /* fall through to failure below */ }
    }
    if (!rawHtml) {
      console.log('[tiktok-shop-scraper] could not capture page HTML');
      return null;
    }

    const routerMatch = rawHtml.match(/<script[^>]*id="__MODERN_ROUTER_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!routerMatch) {
      console.log('[tiktok-shop-scraper] __MODERN_ROUTER_DATA__ tag not found in page HTML');
      return null;
    }

    let productInfo: Record<string, unknown> | null;
    try {
      productInfo = findProductInfo(JSON.parse(routerMatch[1]));
    } catch (err) {
      console.log('[tiktok-shop-scraper] failed to parse __MODERN_ROUTER_DATA__:', err instanceof Error ? err.message : err);
      return null;
    }

    if (!productInfo) {
      console.log('[tiktok-shop-scraper] __MODERN_ROUTER_DATA__ parsed but no product_info block found');
      return null;
    }

    return extractProductResult(productInfo);
  } finally {
    await browser?.close().catch(() => { /* ignore */ });
  }
}

/**
 * Depth-first search for the `product_info` node — identified structurally (has both
 * `product_model` and `promotion_model` keys) rather than by a fixed path, since its
 * position within `components_map` isn't guaranteed to stay at a fixed index.
 */
function findProductInfo(node: unknown, seen = new Set<unknown>()): Record<string, unknown> | null {
  if (!node || typeof node !== 'object' || seen.has(node)) return null;
  seen.add(node);

  if (!Array.isArray(node)) {
    const obj = node as Record<string, unknown>;
    if ('product_model' in obj && 'promotion_model' in obj) return obj;
  }

  for (const value of Object.values(node as Record<string, unknown>)) {
    const found = findProductInfo(value, seen);
    if (found) return found;
  }
  return null;
}

function extractProductResult(productInfo: Record<string, unknown>): TikTokShopProductResult {
  const productModel = productInfo.product_model as Record<string, unknown> | undefined;
  const promotionModel = productInfo.promotion_model as Record<string, unknown> | undefined;
  const minPrice = (promotionModel?.promotion_product_price as Record<string, unknown> | undefined)
    ?.min_price as Record<string, unknown> | undefined;

  const price = parseDecimalPrice(minPrice?.sale_price_decimal);
  const originalPrice = parseDecimalPrice(minPrice?.origin_price_decimal);

  if (price === null) {
    console.warn(
      '[tiktok-shop-scraper] no sale_price_decimal in promotion_model — raw min_price:',
      JSON.stringify(minPrice ?? {}).slice(0, 500),
    );
  }

  const images = productModel?.images as Array<{ url_list?: string[] }> | undefined;
  const imageUrl = images?.[0]?.url_list?.[0] ?? null;

  return {
    price,
    originalPrice,
    title: typeof productModel?.name === 'string' ? productModel.name : null,
    brand: null,
    imageUrl: imageUrl && imageUrl.startsWith('http') ? imageUrl : null,
    videoUrl: null,
    confidence: price !== null ? 'high' : 'low',
    reasoning: 'tiktok-shop-pin',
  };
}

function parseDecimalPrice(raw: unknown): number | null {
  const num = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(num) && num > 0 ? num : null;
}

async function waitForTitle(page: Page, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await page.title().catch(() => '');
    if (t && t !== '') return t;
    await sleep(500);
  }
  return '';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
