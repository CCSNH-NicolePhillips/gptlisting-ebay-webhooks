import { canUseBrave, incBrave, canUseSerp, incSerp } from "./price-quota.js";

async function pickFirstUrl(results: any, field: "link" | "url" = "link"): Promise<string | null> {
  if (!results) return null;
  const arr = Array.isArray(results) ? results : [];
  for (const entry of arr) {
    const value = entry?.[field];
    if (typeof value === "string" && value) {
      return value;
    }
  }
  return null;
}

export async function braveFirstUrl(query: string, site?: string): Promise<string | null> {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) return null;
  if (!(await canUseBrave())) return null;

  const targetQuery = site ? `${query} site:${site}` : query;
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", targetQuery);

  try {
    const res = await fetch(url.toString(), {
      headers: { "X-Subscription-Token": apiKey },
    });
    if (!res.ok) return null;
    await incBrave();
    const data: any = await res.json();
    const found = await pickFirstUrl(data?.web?.results, "url");
    return found ?? null;
  } catch (err) {
    console.warn("braveFirstUrl failed", err);
    return null;
  }
}

export async function serpFirstUrl(query: string, site?: string): Promise<string | null> {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) return null;
  if (!(await canUseSerp())) return null;

  const targetQuery = site ? `${query} site:${site}` : query;
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google");
  url.searchParams.set("q", targetQuery);
  url.searchParams.set("num", "6");
  url.searchParams.set("api_key", apiKey);

  try {
    const res = await fetch(url.toString());
    if (!res.ok) return null;
    await incSerp();
    const data: any = await res.json();
    const found = await pickFirstUrl(data?.organic_results, "link");
    return found ?? null;
  } catch (err) {
    console.warn("serpFirstUrl failed", err);
    return null;
  }
}
