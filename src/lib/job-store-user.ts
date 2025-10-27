import fetch from "node-fetch";
import { k as keys } from "./user-keys.js";

const BASE = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

function ensureConfigured() {
  if (!BASE || !TOKEN) {
    throw new Error("Upstash Redis not configured");
  }
}

async function call(parts: string[]) {
  ensureConfigured();
  const url = `${BASE}/${parts.map(encodeURIComponent).join("/")}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Upstash ${res.status}: ${text}`);
  }

  const data: any = await res.json();
  return data?.result;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item : String(item ?? "")))
    .map((item) => item.trim())
    .filter(Boolean);
}

export async function listJobsForUser(userId: string, limit = 50) {
  const pattern = keys.job(userId, "*");
  const keyResp = await call(["KEYS", pattern]);
  const jobKeys = toStringArray(keyResp);
  if (!jobKeys.length) return [];

  const jobs: any[] = [];
  for (const key of jobKeys) {
    try {
      const raw = await call(["GET", key]);
      if (typeof raw !== "string" || !raw) continue;
      const parsed = JSON.parse(raw);
      const jobId = typeof parsed?.jobId === "string" && parsed.jobId ? parsed.jobId : key.split(":").pop();
      jobs.push({ key, jobId, ...parsed });
    } catch {
      continue;
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
