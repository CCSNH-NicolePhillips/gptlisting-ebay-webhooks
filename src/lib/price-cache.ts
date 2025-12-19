const BASE = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const TTL_DAYS = Number(process.env.PRICE_CACHE_TTL_DAYS ?? "30");
const TTL_SEC = Math.max(1, Number.isFinite(TTL_DAYS) ? TTL_DAYS : 30) * 24 * 60 * 60;

if (!BASE || !TOKEN) {
  console.warn("⚠️ PRICE CACHE DISABLED — missing Upstash credentials");
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

function sanitizeSigPart(part: string | undefined | null): string {
  if (typeof part !== "string") return "";
  return part
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function makePriceSig(brand?: string, product?: string, variant?: string): string {
  const pieces = [sanitizeSigPart(brand), sanitizeSigPart(product), sanitizeSigPart(variant)];
  const joined = pieces.join("|").replace(/\|{2,}/g, "|");
  return joined.replace(/^\|+|\|+$/g, "").trim();
}

export async function getCachedPrice(sig: string): Promise<Record<string, any> | null> {
  if (!sig) return null;
  try {
    const resp = await redisCall("GET", `pricecache:${sig}`);
    const raw = resp?.result;
    if (typeof raw !== "string" || !raw) {
      return null;
    }
    try {
      return JSON.parse(raw);
    } catch (err) {
      console.warn("price-cache parse failed", err);
      return null;
    }
  } catch (err) {
    console.warn("price-cache read failed", err);
    return null;
  }
}

export async function setCachedPrice(sig: string, data: Record<string, any>): Promise<void> {
  if (!sig) return;
  try {
    const payload = JSON.stringify({ ...data, ts: Date.now() });
    await redisCall("SET", `pricecache:${sig}`, payload);
    await redisCall("EXPIRE", `pricecache:${sig}`, `${TTL_SEC}`);
  } catch (err) {
    console.warn("price-cache write failed", err);
  }
}
