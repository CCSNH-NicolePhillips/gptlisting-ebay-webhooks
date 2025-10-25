import fetch from "node-fetch";

const BASE = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const BIND_TTL_SEC = 60 * 60 * 24 * 45; // 45 days
const GLOBAL_INDEX_KEY = "price:bind:index";

if (!BASE || !TOKEN) {
  console.warn("WARNING: Upstash Redis env vars missing. Price bindings will not persist.");
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

  return (await res.json()) as { result: unknown };
}

function bindingKey(jobId: string, groupId: string): string {
  return `price:binding:${jobId}:${groupId}`;
}

function jobIndexKey(jobId: string): string {
  return `price:bind:${jobId}`;
}

function toStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => (typeof item === "string" ? item : String(item ?? "")))
    .map((item) => item.trim())
    .filter(Boolean);
}

type BindingStatus = "updated" | "skipped" | "error";

export type TickSnapshot = {
  at: number;
  status: BindingStatus;
  source?: "http" | "schedule";
  note?: string;
  fromPrice?: number;
  toPrice?: number;
  dueAt?: number | null;
};

export type AutoConfig = {
  reduceBy: number;
  everyDays: number;
  minPrice: number;
};

export type PricingSnapshot = {
  base?: number;
  ebay?: number;
};

export type ListingBinding = {
  jobId: string;
  groupId: string;
  userId: string;
  offerId?: string | null;
  listingId?: string | null;
  sku?: string | null;
  currentPrice: number;
  pricing?: PricingSnapshot | null;
  auto?: AutoConfig | null;
  metadata?: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
  lastReductionAt?: number | null;
  lastTickAt?: number | null;
  lastTick?: TickSnapshot | null;
};

export type BindListingInput = {
  jobId: string;
  groupId: string;
  userId: string;
  offerId?: string | null;
  listingId?: string | null;
  sku?: string | null;
  currentPrice?: number | null;
  pricing?: PricingSnapshot | null;
  auto?: Partial<AutoConfig> | AutoConfig | null;
  metadata?: Record<string, unknown> | null;
  lastReductionAt?: number | null;
};

export type BindingUpdate = {
  userId?: string | null;
  offerId?: string | null;
  listingId?: string | null;
  sku?: string | null;
  currentPrice?: number | null;
  pricing?: PricingSnapshot | null;
  auto?: Partial<AutoConfig> | AutoConfig | null;
  metadata?: Record<string, unknown> | null;
  lastReductionAt?: number | null;
  lastTickAt?: number | null;
  lastTick?: TickSnapshot | null;
};

function sanitizeId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function sanitizePrice(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return 0;
  }
  return Math.round(num * 100) / 100;
}

function sanitizeTimestamp(value: unknown, allowNull = false): number | null {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) {
    return allowNull ? null : Date.now();
  }
  return Math.trunc(num);
}

function normalizePricing(value: unknown): PricingSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const record = value as PricingSnapshot;
  const out: PricingSnapshot = {};
  if (record.base !== undefined) {
    const num = sanitizePrice(record.base);
    if (num > 0) out.base = num;
  }
  if (record.ebay !== undefined) {
    const num = sanitizePrice(record.ebay);
    if (num > 0) out.ebay = num;
  }
  return Object.keys(out).length ? out : null;
}

function normalizeAuto(value: unknown): AutoConfig | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Partial<AutoConfig>;
  const reduceBy = sanitizePrice(obj.reduceBy);
  const everyDaysRaw = typeof obj.everyDays === "number" ? obj.everyDays : Number(obj.everyDays);
  const everyDays = Number.isFinite(everyDaysRaw) ? Math.max(1, Math.trunc(everyDaysRaw)) : 0;
  const minPrice = sanitizePrice(obj.minPrice);
  if (reduceBy <= 0 || everyDays <= 0) return null;
  return {
    reduceBy,
    everyDays,
    minPrice,
  };
}

function normalizeMetadata(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    const cleanKey = typeof key === "string" ? key.trim() : "";
    if (!cleanKey) continue;
    if (val === undefined) continue;
    if (val === null) {
      out[cleanKey] = null;
      continue;
    }
    if (typeof val === "number" || typeof val === "string" || typeof val === "boolean") {
      out[cleanKey] = val;
      continue;
    }
    try {
      out[cleanKey] = JSON.parse(JSON.stringify(val));
    } catch {
      // skip unserializable values
    }
  }
  return Object.keys(out).length ? out : null;
}

function mergeMetadata(current: Record<string, unknown> | null | undefined, next: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!current && !next) return null;
  const merged: Record<string, unknown> = { ...(current || {}) };
  if (next) {
    for (const [key, val] of Object.entries(next)) {
      if (val === null) delete merged[key];
      else merged[key] = val;
    }
  }
  return Object.keys(merged).length ? merged : null;
}

function normalizeTick(value: unknown): TickSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Partial<TickSnapshot>;
  const status = obj.status;
  if (status !== "updated" && status !== "skipped" && status !== "error") return null;
  const at = sanitizeTimestamp(obj.at, false) || Date.now();
  const note = typeof obj.note === "string" ? obj.note : undefined;
  const source = obj.source === "http" || obj.source === "schedule" ? obj.source : undefined;
  const fromPrice = obj.fromPrice !== undefined ? sanitizePrice(obj.fromPrice) : undefined;
  const toPrice = obj.toPrice !== undefined ? sanitizePrice(obj.toPrice) : undefined;
  const dueAt = obj.dueAt !== undefined ? sanitizeTimestamp(obj.dueAt, true) : undefined;
  return {
    at,
    status,
    note,
    source,
    fromPrice,
    toPrice,
    dueAt: dueAt === undefined ? obj.dueAt ?? null : dueAt,
  };
}

function normalizeBinding(raw: unknown): ListingBinding | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Partial<ListingBinding> & Record<string, unknown>;
  const jobId = typeof obj.jobId === "string" ? obj.jobId : null;
  const groupId = typeof obj.groupId === "string" ? obj.groupId : null;
  const userId = typeof obj.userId === "string" ? obj.userId : null;
  if (!jobId || !groupId || !userId) return null;
  const binding: ListingBinding = {
    jobId,
    groupId,
    userId,
    offerId: sanitizeId(obj.offerId),
    listingId: sanitizeId(obj.listingId),
    sku: sanitizeId(obj.sku),
    currentPrice: sanitizePrice(obj.currentPrice),
    pricing: normalizePricing(obj.pricing),
    auto: normalizeAuto(obj.auto),
    metadata: normalizeMetadata(obj.metadata),
    createdAt: sanitizeTimestamp(obj.createdAt, false) || Date.now(),
    updatedAt: sanitizeTimestamp(obj.updatedAt, false) || Date.now(),
    lastReductionAt: sanitizeTimestamp(obj.lastReductionAt, true),
    lastTickAt: sanitizeTimestamp(obj.lastTickAt, true),
    lastTick: normalizeTick(obj.lastTick),
  };
  return binding;
}

function parseBinding(raw: unknown): ListingBinding | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return normalizeBinding(parsed);
  } catch {
    return null;
  }
}

function dissectKey(key: string): { jobId: string; groupId: string } | null {
  const parts = key.split(":");
  if (parts.length < 3) return null;
  const jobId = parts[2];
  const groupId = parts.slice(3).join(":");
  if (!jobId || !groupId) return null;
  return { jobId, groupId };
}

async function saveBinding(binding: ListingBinding): Promise<void> {
  const key = bindingKey(binding.jobId, binding.groupId);
  const serialized = JSON.stringify(binding);
  await redisCall("SETEX", key, `${BIND_TTL_SEC}`, serialized);
  await Promise.all([
    redisCall("SADD", jobIndexKey(binding.jobId), key),
    redisCall("EXPIRE", jobIndexKey(binding.jobId), `${BIND_TTL_SEC}`),
    redisCall("SADD", GLOBAL_INDEX_KEY, key),
    redisCall("EXPIRE", GLOBAL_INDEX_KEY, `${BIND_TTL_SEC}`),
  ]);
}

async function cleanupKey(key: string): Promise<void> {
  const info = dissectKey(key);
  const tasks = [redisCall("SREM", GLOBAL_INDEX_KEY, key).catch(() => undefined)];
  if (info) {
    tasks.push(redisCall("SREM", jobIndexKey(info.jobId), key).catch(() => undefined));
  }
  await Promise.all(tasks);
}

function applyUpdate(binding: ListingBinding, update: BindingUpdate): ListingBinding {
  const next: ListingBinding = { ...binding };
  if (update.userId !== undefined) {
    next.userId = sanitizeId(update.userId) || binding.userId;
  }
  if (update.offerId !== undefined) {
    next.offerId = sanitizeId(update.offerId);
  }
  if (update.listingId !== undefined) {
    next.listingId = sanitizeId(update.listingId);
  }
  if (update.sku !== undefined) {
    next.sku = sanitizeId(update.sku);
  }
  if (update.currentPrice !== undefined) {
    next.currentPrice = sanitizePrice(update.currentPrice);
  }
  if (update.pricing !== undefined) {
    next.pricing = normalizePricing(update.pricing);
  }
  if (update.auto !== undefined) {
    next.auto = normalizeAuto(update.auto);
  }
  if (update.metadata !== undefined) {
    next.metadata = mergeMetadata(next.metadata, normalizeMetadata(update.metadata));
  }
  if (update.lastReductionAt !== undefined) {
    next.lastReductionAt = sanitizeTimestamp(update.lastReductionAt, true);
  }
  if (update.lastTickAt !== undefined) {
    next.lastTickAt = sanitizeTimestamp(update.lastTickAt, true);
  }
  if (update.lastTick !== undefined) {
    next.lastTick = normalizeTick(update.lastTick);
  }
  next.updatedAt = Date.now();
  return next;
}

export async function bindListing(input: BindListingInput): Promise<ListingBinding> {
  const jobId = input.jobId.trim();
  const groupId = input.groupId.trim();
  const userId = input.userId.trim();
  if (!jobId || !groupId || !userId) {
    throw new Error("Missing jobId, groupId, or userId for binding");
  }
  const existing = await getListingBinding(jobId, groupId);
  const base: ListingBinding = existing ?? {
    jobId,
    groupId,
    userId,
    offerId: null,
    listingId: null,
    sku: null,
    currentPrice: 0,
    pricing: null,
    auto: null,
    metadata: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastReductionAt: null,
    lastTickAt: null,
    lastTick: null,
  };

  const merged = applyUpdate(base, {
    userId,
    offerId: input.offerId,
    listingId: input.listingId,
    sku: input.sku,
    currentPrice:
      input.currentPrice != null
        ? input.currentPrice
        : input.pricing?.ebay ?? base.currentPrice,
    pricing: input.pricing ?? base.pricing ?? null,
    auto: input.auto !== undefined ? input.auto : base.auto ?? null,
    metadata: input.metadata ?? undefined,
    lastReductionAt:
      input.lastReductionAt !== undefined
        ? input.lastReductionAt
        : existing?.lastReductionAt ?? null,
  });

  if (!merged.lastReductionAt && merged.currentPrice > 0) {
    merged.lastReductionAt = Date.now();
  }

  await saveBinding(merged);
  return merged;
}

export async function getListingBinding(jobId: string, groupId: string): Promise<ListingBinding | null> {
  const key = bindingKey(jobId, groupId);
  const resp = await redisCall("GET", key);
  const binding = parseBinding(resp.result);
  if (!binding) return null;
  return binding;
}

export async function getBindingsForJob(jobId: string): Promise<ListingBinding[]> {
  const setResp = await redisCall("SMEMBERS", jobIndexKey(jobId));
  const keys = toStringArray(setResp.result);
  if (!keys.length) return [];
  const valuesResp = await redisCall("MGET", ...keys);
  const rawValues = Array.isArray(valuesResp.result) ? valuesResp.result : [];
  const out: ListingBinding[] = [];
  const missing: string[] = [];
  rawValues.forEach((raw, idx) => {
    const binding = parseBinding(raw);
    if (binding) out.push(binding);
    else missing.push(keys[idx]);
  });
  if (missing.length) {
    await Promise.all(missing.map((key) => cleanupKey(key))).catch(() => undefined);
  }
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function listAllBindings(): Promise<ListingBinding[]> {
  const setResp = await redisCall("SMEMBERS", GLOBAL_INDEX_KEY);
  const keys = toStringArray(setResp.result);
  if (!keys.length) return [];
  const valuesResp = await redisCall("MGET", ...keys);
  const rawValues = Array.isArray(valuesResp.result) ? valuesResp.result : [];
  const out: ListingBinding[] = [];
  const missing: string[] = [];
  rawValues.forEach((raw, idx) => {
    const binding = parseBinding(raw);
    if (binding) out.push(binding);
    else missing.push(keys[idx]);
  });
  if (missing.length) {
    await Promise.all(missing.map((key) => cleanupKey(key))).catch(() => undefined);
  }
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function updateBinding(jobId: string, groupId: string, update: BindingUpdate): Promise<ListingBinding | null> {
  const existing = await getListingBinding(jobId, groupId);
  if (!existing) return null;
  const merged = applyUpdate(existing, update);
  await saveBinding(merged);
  return merged;
}

export async function removeBinding(jobId: string, groupId: string): Promise<boolean> {
  const key = bindingKey(jobId, groupId);
  const res = await redisCall("DEL", key);
  await cleanupKey(key);
  const result = typeof res.result === "number" ? res.result : Number(res.result || 0);
  return result > 0;
}

export type PriceState = {
  key: string;
  current: number;
  auto: AutoConfig | null;
  binding: ListingBinding;
};

function extractJobIdFromPrefix(prefix: string): string | null {
  if (!prefix.startsWith("price:")) return null;
  const trimmed = prefix.slice("price:".length).replace(/:+$/, "");
  return trimmed || null;
}

export async function getAllPriceKeys(prefix = ""): Promise<string[]> {
  const normalizedPrefix = typeof prefix === "string" ? prefix : "";
  const jobId = normalizedPrefix ? extractJobIdFromPrefix(normalizedPrefix) : null;

  if (jobId) {
    const bindings = await getBindingsForJob(jobId);
    return bindings.map((binding) => bindingKey(binding.jobId, binding.groupId));
  }

  const setResp = await redisCall("SMEMBERS", GLOBAL_INDEX_KEY);
  const keys = toStringArray(setResp.result);
  if (!normalizedPrefix) return keys;
  return keys.filter((key) => key.startsWith(normalizedPrefix));
}

export async function getPriceState(key: string): Promise<PriceState | null> {
  const trimmed = typeof key === "string" ? key.trim() : "";
  if (!trimmed) return null;
  const resp = await redisCall("GET", trimmed);
  const binding = parseBinding(resp.result);
  if (!binding) return null;
  return {
    key: trimmed,
    current: sanitizePrice(binding.currentPrice),
    auto: binding.auto ?? null,
    binding,
  };
}
