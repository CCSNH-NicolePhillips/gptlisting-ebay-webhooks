import * as cheerio from "cheerio";

function toNumber(value: unknown): number | null {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return +num.toFixed(2);
}

type ExtractedData = {
  price: number | null;
  productType?: string;
};

function extractFromJsonLd($: cheerio.CheerioAPI): ExtractedData {
  const scripts = $('script[type="application/ld+json"]').toArray();
  for (const node of scripts) {
    try {
      const raw = $(node).text().trim();
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const type = String((item as any)["@type"] || "").toLowerCase();
        if (!type.includes("product")) continue;
        
        // Extract category/type information
        let productType: string | undefined;
        const category = (item as any).category;
        if (category && typeof category === "string") {
          productType = category;
        } else if (Array.isArray(category) && category.length > 0) {
          productType = String(category[0]);
        }
        // Also try breadcrumb for category
        if (!productType) {
          const breadcrumb = (item as any).breadcrumb || (item as any)["@graph"]?.find((g: any) => g["@type"] === "BreadcrumbList");
          if (breadcrumb?.itemListElement) {
            const items = breadcrumb.itemListElement;
            const lastCrumb = Array.isArray(items) ? items[items.length - 1] : null;
            if (lastCrumb?.name) {
              productType = String(lastCrumb.name);
            }
          }
        }
        
        const offers = (item as any).offers;
        if (!offers) continue;
        const offer = Array.isArray(offers) ? offers[0] : offers;
        if (!offer || typeof offer !== "object") continue;
        const priceFromOffer =
          toNumber((offer as any).price) ??
          toNumber((offer as any).priceSpecification?.price) ??
          toNumber((offer as any).lowPrice);
        if (priceFromOffer) return { price: priceFromOffer, productType };
      }
    } catch {
      // ignore invalid JSON blobs
    }
  }
  return { price: null };
}

function extractFromOpenGraph($: cheerio.CheerioAPI): number | null {
  const og =
    $(
      'meta[property="product:price:amount"], meta[property="og:price:amount"], meta[name="product:price:amount"], meta[name="og:price:amount"]'
    ).attr("content") || "";
  return og ? toNumber(og) : null;
}

function extractFromBody($: cheerio.CheerioAPI): number | null {
  const bodyText = $.root().text().replace(/\s+/g, " ");
  const targeted = bodyText.match(/(?:price|buy|order|sale)[^$]{0,60}\$\s?(\d{1,4}(?:\.\d{2})?)/i);
  if (targeted) {
    return toNumber(targeted[1]);
  }
  const match = bodyText.match(/\$\s?(\d{1,4}(?:\.\d{2})?)/);
  return match ? toNumber(match[1]) : null;
}

export function extractPriceFromHtml(html: string): number | null {
  try {
    const $ = cheerio.load(html);
    const data = extractFromJsonLd($);
    return data.price ?? extractFromOpenGraph($) ?? extractFromBody($);
  } catch {
    return null;
  }
}

export function extractPriceAndTypeFromHtml(html: string): ExtractedData {
  try {
    const $ = cheerio.load(html);
    const data = extractFromJsonLd($);
    if (data.price) return data;
    const price = extractFromOpenGraph($) ?? extractFromBody($);
    return { price };
  } catch {
    return { price: null };
  }
}
