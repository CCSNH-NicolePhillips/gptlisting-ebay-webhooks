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

// Pick up to N URLs from search results
async function pickTopUrls(results: any, field: "link" | "url" = "link", limit: number = 3): Promise<string[]> {
  if (!results) return [];
  const arr = Array.isArray(results) ? results : [];
  const urls: string[] = [];
  for (const entry of arr) {
    const value = entry?.[field];
    if (typeof value === "string" && value) {
      urls.push(value);
      if (urls.length >= limit) break;
    }
  }
  return urls;
}

export async function braveFirstUrl(query: string, site?: string): Promise<string | null> {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) return null;
  if (!(await canUseBrave())) return null;

  const targetQuery = site ? `${query} site:${site}` : query;
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", targetQuery);
  url.searchParams.set("count", "5"); // Request top 5 results

  try {
    const res = await fetch(url.toString(), {
      headers: { "X-Subscription-Token": apiKey },
    });
    if (!res.ok) return null;
    await incBrave();
    const data: any = await res.json();
    const found = await pickFirstUrl(data?.web?.results, "url");
    console.log(`[Brave Search] Query: "${targetQuery}" → URL: ${found || "(none)"}`);
    return found ?? null;
  } catch (err) {
    console.warn("braveFirstUrl failed", err);
    return null;
  }
}

// Try top N results from Brave search, useful for finding product pages
export async function braveTopUrls(query: string, site?: string, limit: number = 3): Promise<string[]> {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) return [];
  if (!(await canUseBrave())) return [];

  const targetQuery = site ? `${query} site:${site}` : query;
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", targetQuery);
  url.searchParams.set("count", String(Math.min(limit + 2, 10))); // Request a few extra

  try {
    const res = await fetch(url.toString(), {
      headers: { "X-Subscription-Token": apiKey },
    });
    if (!res.ok) return [];
    await incBrave();
    const data: any = await res.json();
    const urls = await pickTopUrls(data?.web?.results, "url", limit);
    console.log(`[Brave Search] Query: "${targetQuery}" → Found ${urls.length} URLs:`);
    urls.forEach((u, i) => console.log(`  [${i + 1}] ${u}`));
    return urls;
  } catch (err) {
    console.warn("braveTopUrls failed", err);
    return [];
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
