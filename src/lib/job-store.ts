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

type JobStoreOptions = {
  key?: string;
};

function defaultJobKey(jobId: string): string {
  return `job:${jobId}`;
}

async function setWithTtl(key: string, serialized: string) {
  await redisCall("SETEX", key, `${TTL_SEC}`, serialized);
}

export async function putJob(jobId: string, data: unknown, options?: JobStoreOptions) {
  const serialized = JSON.stringify(data);
  const primaryKey = options?.key || defaultJobKey(jobId);
  await setWithTtl(primaryKey, serialized);

  const fallbackKey = defaultJobKey(jobId);
  if (options?.key && options.key !== fallbackKey) {
    await setWithTtl(fallbackKey, serialized);
  }
}

export async function getJob(jobId: string, options?: JobStoreOptions) {
  const keys = [] as string[];
  if (options?.key) keys.push(options.key);
  const fallback = defaultJobKey(jobId);
  if (!keys.includes(fallback)) keys.push(fallback);

  for (const key of keys) {
    try {
      const resp = await redisCall("GET", key);
      const val = resp.result;
      if (typeof val !== "string" || !val) continue;
      try {
        return JSON.parse(val);
      } catch {
        return null;
      }
    } catch {
      // ignore missing keys
    }
  }

  return null;
}

function toStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => (typeof item === "string" ? item : String(item ?? "")))
    .map((item) => item.trim())
    .filter(Boolean);
}

export async function listJobs(limit = 50) {
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
    .filter((job) => ["complete", "error", "running", "pending"].includes(job.state))
    .sort((a, b) => {
      const aTime = Number(a.finishedAt ?? a.startedAt ?? a.createdAt ?? 0);
      const bTime = Number(b.finishedAt ?? b.startedAt ?? b.createdAt ?? 0);
      return bTime - aTime;
    })
    .slice(0, limit);
}
