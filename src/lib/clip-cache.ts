import crypto from "crypto";

const BASE = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const DEFAULT_TTL_SEC = 30 * 24 * 60 * 60;

if (!BASE || !TOKEN) {
  console.warn("⚠️ CLIP cache disabled — missing Upstash credentials");
}

async function redisCall(command: string, ...args: string[]): Promise<any | null> {
  if (!BASE || !TOKEN) return null;
  const encoded = [command, ...args].map((part) => encodeURIComponent(part));
  const url = `${BASE}/${encoded.join("/")}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
      },
    });
    if (!res.ok) {
      console.warn("[clip-cache] Upstash error", res.status);
      return null;
    }
    return res.json().catch(() => null);
  } catch (err) {
    console.warn("[clip-cache] call failed", err);
    return null;
  }
}

export async function getCached(key: string): Promise<number[] | null> {
  const response = await redisCall("GET", key);
  const raw = response?.result;
  if (typeof raw !== "string" || !raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.warn("[clip-cache] parse error", err);
    return null;
  }
}

export async function putCached(key: string, vector: number[], ttlSeconds: number = DEFAULT_TTL_SEC): Promise<void> {
  if (!BASE || !TOKEN) return;
  await redisCall("SET", key, JSON.stringify(vector));
  await redisCall("EXPIRE", key, `${ttlSeconds}`);
}

const sha1 = (input: string) => crypto.createHash("sha1").update(input).digest("hex");

export function textKey(text: string): string {
  return `cliptxt:${sha1(text)}`;
}

export function imageKey(url: string): string {
  return `clipimg:${sha1(url)}`;
}
