import 'dotenv/config';

const BASE = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";

async function redisCall(...parts: string[]): Promise<{ result: unknown } | null> {
  if (!BASE || !TOKEN) {
    console.error('Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN');
    return null;
  }

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

function makePriceSig(brand?: string, product?: string): string {
  const pieces = [sanitizeSigPart(brand), sanitizeSigPart(product)];
  const joined = pieces.join("|").replace(/\|{2,}/g, "|");
  return joined.replace(/^\|+|\|+$/g, "").trim();
}

async function main() {
  const sig = makePriceSig('BetterAlt', 'Electrolyte Gummies Fruit Punch Flavor 60N');
  const key = `pricecache:${sig}`;
  console.log('Key:', key);
  
  // Get cached value
  const resp = await redisCall("GET", key);
  const raw = resp?.result;
  if (typeof raw === 'string' && raw) {
    console.log('Cached value:', JSON.parse(raw));
    // Delete it
    await redisCall("DEL", key);
    console.log('✓ Deleted cache entry');
  } else {
    console.log('No cache entry found');
  }
}

main().catch(console.error);
