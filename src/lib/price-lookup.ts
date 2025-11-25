import { extractPriceFromHtml, extractPriceAndTypeFromHtml } from "./html-price.js";
import { braveFirstUrl, braveTopUrls } from "./search.js";
import { getBrandUrls } from "./brand-map.js";
import { getCachedPrice, setCachedPrice, makePriceSig } from "./price-cache.js";
import { searchAmazonProduct, type AmazonProductResult } from "./amazon-product-api.js";

export type MarketPrices = {
  amazon: number | null;
  walmart: number | null;
  brand: number | null;
  avg: number;
  productType?: string; // Product type/category extracted from Amazon/Walmart
};

async function fetchHtml(url: string | null | undefined, timeoutMs = 10000): Promise<string | null> {
  if (!url) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
      },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.text();
  } catch (err) {
    console.warn("fetchHtml failed", { url, err });
    return null;
  }
}

async function priceFrom(url: string | null | undefined): Promise<number | null> {
  const html = await fetchHtml(url);
  if (!html) return null;
  return extractPriceFromHtml(html);
}

async function priceAndTypeFrom(url: string | null | undefined): Promise<{ price: number | null; productType?: string }> {
  const html = await fetchHtml(url);
  if (!html) return { price: null };
  return extractPriceAndTypeFromHtml(html);
}

function toMarketPrices(raw: Record<string, any> | null | undefined): MarketPrices | null {
  if (!raw) return null;
  const coerce = (value: any): number | null => {
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    return +numeric.toFixed(2);
  };
  const amazon = coerce(raw.amazon);
  const walmart = coerce(raw.walmart);
  const brand = coerce(raw.brand);
  const avg = (() => {
    const numeric = typeof raw.avg === "number" ? raw.avg : Number(raw.avg);
    if (!Number.isFinite(numeric) || numeric <= 0) return 0;
    return +numeric.toFixed(2);
  })();
  const productType = typeof raw.productType === "string" ? raw.productType : undefined;
  return { amazon, walmart, brand, avg, productType };
}

function average(values: Array<number | null>): number {
  const present = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (!present.length) return 0;
  const total = present.reduce((acc, value) => acc + value, 0);
  return +(total / present.length).toFixed(2);
}

function cleanQueryPart(value: string | undefined | null): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

function isRetailerUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return /amazon\.com|walmart\.com/i.test(url);
}

async function lookupAmazonWithPaapi(
  brand?: string,
  product?: string,
  variant?: string
): Promise<{ price: number | null; productType?: string }> {
  const title = [product, variant].filter(Boolean).join(" ").trim();
  
  console.log('[price-lookup] Using Amazon PA-API flow (no Brave/SerpAPI)', {
    brand,
    product,
    variant
  });

  let result: AmazonProductResult | null = null;
  try {
    result = await searchAmazonProduct({
      title: title || '',
      brand,
      upc: undefined // We don't have UPC in current flow, can add later
    });
  } catch (err) {
    console.error('[price-lookup] searchAmazonProduct threw', err);
    return { price: null };
  }

  if (!result || result.price == null) {
    console.warn('[price-lookup] No Amazon price found via PA-API', { brand, product, variant });
    return { price: null };
  }

  console.log(`[Price Lookup] ✓ Found Amazon price $${result.price} from PA-API`, {
    asin: result.asin,
    categories: result.categories.slice(0, 3)
  });

  return {
    price: result.price,
    productType: result.categories?.[0] ?? undefined
  };
}

export async function lookupMarketPrice(
  brand?: string,
  product?: string,
  variant?: string
): Promise<MarketPrices> {
  const signature = makePriceSig(brand, product, variant);
  const empty: MarketPrices = { amazon: null, walmart: null, brand: null, avg: 0 };

  if (!signature) {
    return empty;
  }

  const cached = await getCachedPrice(signature);
  const cachedPrices = toMarketPrices(cached);
  if (cachedPrices) {
    return cachedPrices;
  }

  let amazon: number | null = null;
  let walmart: number | null = null;
  let brandPrice: number | null = null;
  let productType: string | undefined;

  const mapped = await getBrandUrls(signature);
  if (mapped) {
    const amazonData = await priceAndTypeFrom(mapped.amazon);
    amazon = amazonData.price;
    if (!productType && amazonData.productType) productType = amazonData.productType;
    
    const walmartData = await priceAndTypeFrom(mapped.walmart);
    walmart = walmartData.price;
    if (!productType && walmartData.productType) productType = walmartData.productType;
    
    brandPrice = await priceFrom(mapped.brand);
  }

  const queryParts = [cleanQueryPart(brand), cleanQueryPart(product), cleanQueryPart(variant)].filter(Boolean);
  const query = queryParts.join(" ").trim();

  if (query) {
    if (amazon == null) {
      // Use Amazon PA-API for direct, deterministic pricing (no Brave/SerpAPI)
      const amazonResult = await lookupAmazonWithPaapi(brand, product, variant);
      amazon = amazonResult.price;
      if (!productType && amazonResult.productType) productType = amazonResult.productType;
    }

    if (walmart == null) {
      // Try Brave search - try top 3 results
      const braveWalmartUrls = await braveTopUrls(query, "walmart.com", 3);
      for (const url of braveWalmartUrls) {
        const walmartData = await priceAndTypeFrom(url);
        if (walmartData.price != null) {
          walmart = walmartData.price;
          if (!productType && walmartData.productType) productType = walmartData.productType;
          console.log(`[Price Lookup] ✓ Found Walmart price $${walmart} from Brave`);
          break;
        }
      }
      
      if (walmart == null) {
        console.log('[Price Lookup] No Walmart price found via Brave');
      }
    }

    if (brandPrice == null) {
      const braveGeneric = await braveFirstUrl(query);
      const brandUrl = braveGeneric && !isRetailerUrl(braveGeneric) ? braveGeneric : null;
      brandPrice = await priceFrom(brandUrl);
      if (brandPrice != null) {
        console.log(`[Price Lookup] ✓ Found brand price $${brandPrice} from Brave`);
      } else {
        console.log('[Price Lookup] No brand price found via Brave');
      }
    }
  }

  const avg = average([amazon, walmart, brandPrice]);
  const result: MarketPrices = {
    amazon,
    walmart,
    brand: brandPrice,
    avg,
    productType,
  };

  await setCachedPrice(signature, result);

  return result;
}
