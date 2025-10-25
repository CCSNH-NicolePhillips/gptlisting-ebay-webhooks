import { openai } from "./openai.js";

type MarketPrices = {
  amazon: number | null;
  walmart: number | null;
  brand: number | null;
  avg: number;
};

function normalizePrice(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return +numeric.toFixed(2);
}

function averagePrices(parts: Array<number | null>): number {
  const values = parts.filter((val): val is number => typeof val === "number");
  if (!values.length) {
    return 0;
  }
  const sum = values.reduce((total, current) => total + current, 0);
  return +(sum / values.length).toFixed(2);
}

async function requestWithWebAccess(product: string): Promise<MarketPrices> {
  const prompt = `
Search Amazon.com, Walmart.com, and the official brand website for "${product}".
Return exact retail prices if visible. Respond ONLY in JSON:
{"amazon": number|null, "walmart": number|null, "brand": number|null, "avg": number }.
`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "You are a live-price researcher." },
      { role: "user", content: prompt },
    ],
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("No content returned from web-assisted lookup");
  }

  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Web-assisted lookup did not return JSON");
  }

  const amazon = normalizePrice(parsed?.amazon);
  const walmart = normalizePrice(parsed?.walmart);
  const brand = normalizePrice(parsed?.brand);
  const avg = averagePrices([amazon, walmart, brand]);

  return { amazon, walmart, brand, avg };
}

async function fallbackEstimation(product: string): Promise<number> {
  const prompt = `
Estimate an approximate retail price (USD) for "${product}" by comparing
similar supplements or cosmetics on Amazon/Walmart.
Respond as {"avg": number}.
`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: "You are a price estimator using public retail data.",
      },
      { role: "user", content: prompt },
    ],
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content) {
    return 0;
  }

  try {
    const parsed = JSON.parse(content);
    const avg = Number(parsed?.avg);
    return Number.isFinite(avg) && avg > 0 ? +avg.toFixed(2) : 0;
  } catch {
    return 0;
  }
}

/**
 * Hybrid price lookup with live search + fallback estimation.
 */
export async function lookupMarketPrice(product: string): Promise<MarketPrices> {
  const query = (product || "").trim();
  if (!query) {
    return { amazon: null, walmart: null, brand: null, avg: 0 };
  }

  try {
    const market = await requestWithWebAccess(query);

    if (market.avg === 0) {
      const fallbackAvg = await fallbackEstimation(query);
      market.avg = fallbackAvg;
    }

    return market;
  } catch (err) {
    console.error("lookupMarketPrice failed:", err);
    const fallbackAvg = await fallbackEstimation(query);
    return { amazon: null, walmart: null, brand: null, avg: fallbackAvg };
  }
}
