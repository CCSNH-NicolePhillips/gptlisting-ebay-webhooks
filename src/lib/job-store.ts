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

function toStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => (typeof item === "string" ? item : String(item ?? "")))
    .map((item) => item.trim())
    .filter(Boolean);
}

export async function listJobs(limit = 25) {
  const keysResp = await redisCall("KEYS", "job:*");
  const keys = toStringArray(keysResp.result);
  if (!keys.length) return [];

  const jobs: Array<Record<string, any>> = [];
  for (const key of keys) {
    try {
      const jobResp = await redisCall("GET", key);
      const raw = jobResp.result;
      if (typeof raw !== "string" || !raw) continue;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        const jobId = typeof parsed.jobId === "string" && parsed.jobId
          ? parsed.jobId
          : key.startsWith("job:")
            ? key.slice(4)
            : key;
        jobs.push({ key, jobId, ...parsed });
      }
    } catch {
      // ignore malformed job payloads
    }
  }

  return jobs
    .filter((job) => job.state === "complete")
    .sort((a, b) => (Number(b.finishedAt) || 0) - (Number(a.finishedAt) || 0))
    .slice(0, limit);
}
