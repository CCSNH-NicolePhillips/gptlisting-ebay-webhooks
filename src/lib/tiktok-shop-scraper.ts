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

async function tryOnce(key: string, seedUrl: string): Promise<TikTokShopProductResult | null> {
  const region = process.env.BROWSERLESS_SHOP_REGION ?? 'production-sfo';
  const endpoint = `wss://${region}.browserless.io?token=${key}&proxy=residential&proxyCountry=us&stealth=true`;
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;

  try {
    browser = await chromium.connectOverCDP(endpoint, { timeout: 45_000 });

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
