import fetch from "node-fetch";

const BASE = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const TTL_SEC = 172800; // 48 hours

if (!BASE || !TOKEN) {
  console.warn("⚠️ Upstash Redis env vars missing. Background jobs will fail until configured.");
}

async function redisCall(...parts: string[]) {
  if (!BASE || !TOKEN) {
    throw new Error("Upstash Redis not configured");
  }

  const encoded = parts.map((p) => encodeURIComponent(p));
  const url = `${BASE}/${encoded.join("/")}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Redis error ${res.status}: ${text}`);
  }

  return res.json() as Promise<{ result: unknown }>;
}

export async function putJob(jobId: string, data: unknown) {
  await redisCall("SETEX", `job:${jobId}`, `${TTL_SEC}`, JSON.stringify(data));
}

export async function getJob(jobId: string) {
  const resp = await redisCall("GET", `job:${jobId}`);
  const val = resp.result;
  if (typeof val !== "string" || !val) {
    return null;
  }

  try {
    return JSON.parse(val);
  } catch {
    return null;
  }
}
