import crypto from "node:crypto";

const BASE = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const TTL_DAYS_RAW = Number(process.env.SMARTDRAFT_CACHE_TTL_DAYS ?? "2");
const TTL_DAYS = Number.isFinite(TTL_DAYS_RAW) && TTL_DAYS_RAW > 0 ? TTL_DAYS_RAW : 2;
const TTL_SEC = TTL_DAYS * 24 * 60 * 60;

if (!BASE || !TOKEN) {
  console.warn("⚠️ SmartDraft cache disabled — missing Upstash credentials");
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
    console.warn("smartdrafts-store redis call failed", err);
    return null;
  }
}

export type SmartDraftGroupCache = {
  signature: string;
  groups: any[];
  warnings?: string[];
  updatedAt: number;
};

export function makeCacheKey(userId: string, folder: string): string {
  const normalized = (folder || "/").trim().toLowerCase();
  const hash = crypto.createHash("sha1").update(`${userId}|${normalized}`).digest("hex");
  return `smartdrafts:${hash}`;
}

export async function getCachedSmartDraftGroups(key: string): Promise<SmartDraftGroupCache | null> {
  const response = await redisCall("GET", key);
  const raw = response?.result;
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.signature !== "string" || !parsed.signature) return null;
    return {
      signature: parsed.signature,
      groups: Array.isArray(parsed.groups) ? parsed.groups : [],
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings : undefined,
      updatedAt: Number(parsed.updatedAt) || Date.now(),
    };
  } catch (err) {
    console.warn("smartdrafts cache parse failed", err);
    return null;
  }
}

export async function setCachedSmartDraftGroups(key: string, payload: SmartDraftGroupCache): Promise<void> {
  const safePayload = {
    signature: payload.signature,
    groups: Array.isArray(payload.groups) ? payload.groups : [],
    warnings: Array.isArray(payload.warnings) ? payload.warnings : undefined,
    updatedAt: payload.updatedAt || Date.now(),
  };
  await redisCall("SET", key, JSON.stringify(safePayload));
  await redisCall("EXPIRE", key, `${TTL_SEC}`);
}
