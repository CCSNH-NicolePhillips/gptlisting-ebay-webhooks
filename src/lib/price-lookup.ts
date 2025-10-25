import { openai } from "./openai.js";

type MarketPrices = {
  amazon: number | null;
  walmart: number | null;
  brand: number | null;
  avg: number;
};

function normalizePrice(input: unknown): number | null {
  const num = Number(input);
  if (!Number.isFinite(num) || num <= 0) {
    return null;
  }
  return +num.toFixed(2);
}

/**
 * Look up live market prices for a product across major retailers.
 */
export async function lookupMarketPrice(product: string): Promise<MarketPrices> {
  const query = (product || "").trim();
  if (!query) {
    return { amazon: null, walmart: null, brand: null, avg: 0 };
  }

  const prompt = `
Search Amazon.com, Walmart.com, and the product's official site for
"${query}". Return only numeric prices (in USD). Use the lowest "Buy It Now"
or retail prices if multiple results exist.
Respond in strict JSON:
{"amazon": number | null, "walmart": number | null, "brand": number | null, "avg": number}.
`;

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: "You are a price-comparison assistant that uses live web results.",
      },
      { role: "user", content: prompt },
    ],
  });

  const raw = res.choices?.[0]?.message?.content;
  if (!raw) {
    throw new Error("Price lookup returned no content");
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error("Price lookup response was not valid JSON");
  }

  const amazon = normalizePrice(parsed?.amazon);
  const walmart = normalizePrice(parsed?.walmart);
  const brand = normalizePrice(parsed?.brand);

  const values = [amazon, walmart, brand].filter((v): v is number => typeof v === "number");
  const avg = values.length ? +((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)) : 0;

  return { amazon, walmart, brand, avg };
}
