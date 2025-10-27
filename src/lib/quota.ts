import fetch from "node-fetch";

const BASE = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const PER_DAY = Number(process.env.USER_FREE_IMAGES_PER_DAY || "20");
const MAX_RUNNING = Number(process.env.USER_MAX_RUNNING_JOBS || "2");

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

function dayKey(userId: string): string {
  const today = new Date();
  const stamp = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-${String(
    today.getUTCDate()
  ).padStart(2, "0")}`;
  return `quota:${userId}:${stamp}`;
}

export async function canConsumeImages(userId: string, count: number): Promise<boolean> {
  if (count <= 0) return true;
  const key = dayKey(userId);
  const current = Number((await call(["GET", key])) || 0);
  return current + count <= PER_DAY;
}

export async function consumeImages(userId: string, count: number): Promise<void> {
  if (count <= 0) return;
  const key = dayKey(userId);
  await call(["INCRBY", key, String(count)]);
  await call(["EXPIRE", key, String(60 * 60 * 24)]);
}

export async function canStartJob(userId: string): Promise<boolean> {
  const key = `jobsrun:${userId}`;
  const current = Number((await call(["GET", key])) || 0);
  return current < MAX_RUNNING;
}

export async function incRunning(userId: string): Promise<void> {
  const key = `jobsrun:${userId}`;
  await call(["INCR", key]);
  await call(["EXPIRE", key, String(60 * 60 * 2)]);
}

export async function decRunning(userId: string): Promise<void> {
  const key = `jobsrun:${userId}`;
  try {
    await call(["DECR", key]);
  } catch (err) {
    console.warn("Failed to decrement running quota", err);
  }
}
