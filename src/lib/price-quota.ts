const BASE = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const LIMIT_SERP = Number(process.env.PRICE_QUOTA_SERPAPI ?? "200");
const LIMIT_BRAVE = Number(process.env.PRICE_QUOTA_BRAVE ?? "2000");

if (!BASE || !TOKEN) {
  console.warn("⚠️ PRICE QUOTAS DISABLED — missing Upstash credentials");
}

async function redisCall(...parts: string[]): Promise<{ result: unknown } | null> {
  if (!BASE || !TOKEN) return null;

  const encoded = parts.map((part) => encodeURIComponent(part));
  const url = `${BASE}/${encoded.join("/")}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Redis error ${res.status}: ${text}`);
  }

  return res.json();
}

function monthKey(service: "serpapi" | "brave"): string {
  const now = new Date();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `pricequota:${service}:${now.getUTCFullYear()}-${month}`;
}

async function getCount(key: string): Promise<number> {
  try {
    const resp = await redisCall("GET", key);
    return Number(resp?.result ?? 0) || 0;
  } catch (err) {
    console.warn("price-quota read failed", err);
    return 0;
  }
}

async function increment(key: string): Promise<void> {
  try {
    await redisCall("INCR", key);
    await redisCall("EXPIRE", key, `${40 * 24 * 60 * 60}`);
  } catch (err) {
    console.warn("price-quota write failed", err);
  }
}

export async function canUseSerp(): Promise<boolean> {
  if (!BASE || !TOKEN || !Number.isFinite(LIMIT_SERP) || LIMIT_SERP <= 0) {
    return Boolean(process.env.SERPAPI_KEY);
  }
  const used = await getCount(monthKey("serpapi"));
  return used < LIMIT_SERP;
}

export async function incSerp(): Promise<void> {
  if (!BASE || !TOKEN) return;
  await increment(monthKey("serpapi"));
}

export async function canUseBrave(): Promise<boolean> {
  if (!BASE || !TOKEN || !Number.isFinite(LIMIT_BRAVE) || LIMIT_BRAVE <= 0) {
    return Boolean(process.env.BRAVE_API_KEY);
  }
  const used = await getCount(monthKey("brave"));
  return used < LIMIT_BRAVE;
}

export async function incBrave(): Promise<void> {
  if (!BASE || !TOKEN) return;
  await increment(monthKey("brave"));
}
