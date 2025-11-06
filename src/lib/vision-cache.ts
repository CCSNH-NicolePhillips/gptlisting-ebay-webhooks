import crypto from "node:crypto";

const BASE = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const TTL_DAYS_RAW = Number(process.env.VISION_CACHE_TTL_DAYS ?? "7");
const TTL_DAYS = Number.isFinite(TTL_DAYS_RAW) && TTL_DAYS_RAW > 0 ? TTL_DAYS_RAW : 7;
const TTL_SEC = TTL_DAYS * 24 * 60 * 60;

if (!BASE || !TOKEN) {
  console.warn("⚠️ Vision cache disabled — missing Upstash credentials");
}

async function redisCall(...parts: string[]): Promise<any> {
  if (!BASE || !TOKEN) return null;

  const encoded = parts.map((part) => encodeURIComponent(part));
  const url = `${BASE}/${encoded.join("/")}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
      },
    });

    if (!res.ok) {
      throw new Error(`Upstash error ${res.status}`);
    }

    return res.json();
  } catch (err) {
    console.warn("vision-cache redis call failed", err);
    return null;
  }
}

export function makeBatchKey(urls: string[]): string {
  const sorted = [...urls]
    .map((url) => (typeof url === "string" ? url.trim() : ""))
    .filter(Boolean)
    .sort();
  const raw = sorted.join("|");
  const sha = crypto.createHash("sha1").update(raw).digest("hex");
  return `visionbatch:${sha}`;
}

export async function getCachedBatch(urls: string[]): Promise<any | null> {
  const key = makeBatchKey(urls);
  const response = await redisCall("GET", key);
  const raw = response?.result;
  if (typeof raw !== "string" || !raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.warn("vision-cache parse failed", err);
    return null;
  }
}

export async function setCachedBatch(urls: string[], data: unknown): Promise<void> {
  const key = makeBatchKey(urls);
  await redisCall("SET", key, JSON.stringify(data));
  await redisCall("EXPIRE", key, `${TTL_SEC}`);
}

export async function deleteCachedBatch(urls: string[]): Promise<void> {
  const key = makeBatchKey(urls);
  console.log(`[vision-cache] Deleting cache key: ${key} for ${urls.length} images`);
  console.log(`[vision-cache] URLs being deleted:`, urls.slice(0, 3).map(u => u.split('/').pop()));
  
  const result = await redisCall("DEL", key);
  const deleted = result?.result ?? 0;
  
  console.log(`[vision-cache] DELETE result: ${deleted} key(s) removed (1=success, 0=not found)`);
  
  // Verify deletion by trying to GET the key
  const verify = await redisCall("GET", key);
  const stillExists = verify?.result !== null && verify?.result !== undefined;
  
  if (stillExists) {
    console.warn(`[vision-cache] ⚠️ Cache key ${key} still exists after deletion!`);
  } else {
    console.log(`[vision-cache] ✅ Confirmed cache key ${key} was deleted`);
  }
}
