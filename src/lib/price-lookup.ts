import { extractPriceFromHtml } from "./html-price.js";
import { braveFirstUrl, serpFirstUrl } from "./search.js";
import { getBrandUrls } from "./brand-map.js";
import { getCachedPrice, setCachedPrice, makePriceSig } from "./price-cache.js";

export type MarketPrices = {
  amazon: number | null;
  walmart: number | null;
  brand: number | null;
  avg: number;
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
  return { amazon, walmart, brand, avg };
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

  const mapped = await getBrandUrls(signature);
  if (mapped) {
    amazon = await priceFrom(mapped.amazon);
    walmart = await priceFrom(mapped.walmart);
    brandPrice = await priceFrom(mapped.brand);
  }

  const queryParts = [cleanQueryPart(brand), cleanQueryPart(product), cleanQueryPart(variant)].filter(Boolean);
  const query = queryParts.join(" ").trim();

  if (query) {
    if (amazon == null) {
      const braveAmazonUrl = await braveFirstUrl(query, "amazon.com");
      amazon = await priceFrom(braveAmazonUrl);
      if (amazon == null) {
        const serpAmazonUrl = await serpFirstUrl(query, "amazon.com");
        amazon = await priceFrom(serpAmazonUrl);
      }
    }

    if (walmart == null) {
      const braveWalmartUrl = await braveFirstUrl(query, "walmart.com");
      walmart = await priceFrom(braveWalmartUrl);
      if (walmart == null) {
        const serpWalmartUrl = await serpFirstUrl(query, "walmart.com");
        walmart = await priceFrom(serpWalmartUrl);
      }
    }

    if (brandPrice == null) {
      const braveGeneric = await braveFirstUrl(query);
      let brandUrl = braveGeneric && !isRetailerUrl(braveGeneric) ? braveGeneric : null;
      if (!brandUrl) {
        const serpGeneric = await serpFirstUrl(query);
        if (serpGeneric && !isRetailerUrl(serpGeneric)) {
          brandUrl = serpGeneric;
        }
      }
      brandPrice = await priceFrom(brandUrl);
    }
  }

  const avg = average([amazon, walmart, brandPrice]);
  const result: MarketPrices = {
    amazon,
    walmart,
    brand: brandPrice,
    avg,
  };

  await setCachedPrice(signature, result);

  return result;
}
