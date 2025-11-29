const BASE = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";

if (!BASE || !TOKEN) {
  console.warn("⚠️ BRAND MAP DISABLED — missing Upstash credentials");
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

export type BrandUrls = {
  brand?: string;
  amazon?: string;
  walmart?: string;
  requiresJs?: boolean; // True if brand website prices are JavaScript-rendered
  lastChecked?: number; // Timestamp of last price check
};

export type BrandMetadata = {
  productType?: string; // e.g., "skincare beauty", "vitamin supplement", "sports nutrition supplement"
  category?: string; // Optional: specific eBay category hint
  notes?: string; // Optional: any additional metadata
};

export async function setBrandUrls(sig: string, urls: BrandUrls): Promise<void> {
  if (!sig) return;
  try {
    await redisCall("SET", `brandmap:${sig}`, JSON.stringify(urls));
  } catch (err) {
    console.warn("brand-map write failed", err);
  }
}

export async function getBrandUrls(sig: string): Promise<BrandUrls | null> {
  if (!sig) return null;
  try {
    const resp = await redisCall("GET", `brandmap:${sig}`);
    const raw = resp?.result;
    if (typeof raw !== "string" || !raw) return null;
    try {
      return JSON.parse(raw);
    } catch (err) {
      console.warn("brand-map parse failed", err);
      return null;
    }
  } catch (err) {
    console.warn("brand-map read failed", err);
    return null;
  }
}

/**
 * Store brand metadata (product type, category hints, etc.)
 */
export async function setBrandMetadata(brandName: string, metadata: BrandMetadata): Promise<void> {
  if (!brandName) return;
  try {
    const key = `brandmeta:${brandName.toLowerCase().trim()}`;
    await redisCall("SET", key, JSON.stringify(metadata));
  } catch (err) {
    console.warn("brand-metadata write failed", err);
  }
}

/**
 * Retrieve brand metadata
 */
export async function getBrandMetadata(brandName: string): Promise<BrandMetadata | null> {
  if (!brandName) return null;
  try {
    const key = `brandmeta:${brandName.toLowerCase().trim()}`;
    const resp = await redisCall("GET", key);
    const raw = resp?.result;
    if (typeof raw !== "string" || !raw) return null;
    try {
      return JSON.parse(raw);
    } catch (err) {
      console.warn("brand-metadata parse failed", err);
      return null;
    }
  } catch (err) {
    console.warn("brand-metadata read failed", err);
    return null;
  }
}
