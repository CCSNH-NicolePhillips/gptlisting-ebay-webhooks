import * as cheerio from "cheerio";

function toNumber(value: unknown): number | null {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return +num.toFixed(2);
}

function extractFromJsonLd($: cheerio.CheerioAPI): number | null {
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
        const offers = (item as any).offers;
        if (!offers) continue;
        const offer = Array.isArray(offers) ? offers[0] : offers;
        if (!offer || typeof offer !== "object") continue;
        const priceFromOffer =
          toNumber((offer as any).price) ??
          toNumber((offer as any).priceSpecification?.price) ??
          toNumber((offer as any).lowPrice);
        if (priceFromOffer) return priceFromOffer;
      }
    } catch {
      // ignore invalid JSON blobs
    }
  }
  return null;
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
    return extractFromJsonLd($) ?? extractFromOpenGraph($) ?? extractFromBody($);
  } catch {
    return null;
  }
}
