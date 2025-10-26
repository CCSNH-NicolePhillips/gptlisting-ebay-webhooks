import { getJob, listJobs } from "./job-store.js";
import { getBindingsForJob, type ListingBinding } from "./price-store.js";

type RawJobRecord = Record<string, unknown>;

type SummaryShape = {
  batches: number;
  totalGroups: number;
};

export type PriceStats = {
  average: number;
  min: number;
  max: number;
  sampleCount: number;
  bindingCount: number;
  autoCount: number;
};

export type JobSummary = {
  jobId: string;
  state: string;
  info: string | null;
  error: string | null;
  createdAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  warningsCount: number;
  summary: SummaryShape | null;
  price: PriceStats;
  lastUpdatedAt: number | null;
};

export type JobDetail = JobSummary & {
  warnings: string[];
  groups: Array<Record<string, unknown>>;
  bindings: ListingBinding[];
};

export async function fetchJobSummaries(limit = 50): Promise<JobSummary[]> {
  const jobs = await listJobs(limit);
  const mapped = await Promise.all(jobs.map((job) => summarizeJob(job as RawJobRecord)));
  return mapped.sort((a, b) => (b.lastUpdatedAt ?? 0) - (a.lastUpdatedAt ?? 0));
}

export async function fetchJobDetail(jobId: string): Promise<JobDetail | null> {
  const trimmed = jobId.trim();
  if (!trimmed) return null;
  const job = await getJob(trimmed);
  if (!job) return null;
  return enrichJobDetail(trimmed, job as RawJobRecord);
}

async function summarizeJob(job: RawJobRecord, preloadedBindings?: ListingBinding[]): Promise<JobSummary> {
  const jobId = extractJobId(job);
  const bindings = preloadedBindings ?? (jobId ? await getBindingsForJob(jobId) : []);
  const createdAt = parseTimestamp(job["createdAt"]);
  const startedAt = parseTimestamp(job["startedAt"]);
  const finishedAt = parseTimestamp(job["finishedAt"]);
  const lastUpdatedAt = finishedAt ?? startedAt ?? createdAt;
  return {
    jobId,
    state: parseState(job["state"]),
    info: parseString(job["info"]),
    error: parseString(job["error"]),
    createdAt,
    startedAt,
    finishedAt,
    durationMs: calcDuration(startedAt, finishedAt),
    warningsCount: countArray(job["warnings"]),
    summary: parseSummary(job["summary"]),
    price: computePriceStats(bindings),
    lastUpdatedAt,
  };
}

async function enrichJobDetail(jobId: string, job: RawJobRecord): Promise<JobDetail> {
  const bindings = await getBindingsForJob(jobId);
  const summary = await summarizeJob({ ...job, jobId }, bindings);
  const warnings = extractStrings(job["warnings"]);
  const groups = enrichGroups(job["groups"], bindings);
  return {
    ...summary,
    warnings,
    groups,
    bindings,
  };
}

function parseSummary(value: unknown): SummaryShape | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const batches = parseInteger(raw.batches);
  const totalGroups = parseInteger(raw.totalGroups);
  if (batches === null && totalGroups === null) return null;
  return {
    batches: batches ?? 0,
    totalGroups: totalGroups ?? 0,
  };
}

function parseInteger(value: unknown): number | null {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.trunc(num));
}

function computePriceStats(bindings: ListingBinding[]): PriceStats {
  const bindingCount = bindings.length;
  const autoCount = bindings.reduce((acc, binding) => (binding.auto ? acc + 1 : acc), 0);
  const prices = bindings
    .map((binding) =>
      typeof binding.currentPrice === "number" ? binding.currentPrice : Number(binding.currentPrice)
    )
    .filter((value): value is number => Number.isFinite(value) && value > 0);

  if (!prices.length) {
    return {
      average: 0,
      min: 0,
      max: 0,
      sampleCount: 0,
      bindingCount,
      autoCount,
    };
  }

  const sum = prices.reduce((acc, value) => acc + value, 0);
  const average = Number((sum / prices.length).toFixed(2));
  const min = Number(Math.min(...prices).toFixed(2));
  const max = Number(Math.max(...prices).toFixed(2));

  return {
    average,
    min,
    max,
    sampleCount: prices.length,
    bindingCount,
    autoCount,
  };
}

function calcDuration(startedAt: number | null, finishedAt: number | null): number | null {
  if (startedAt === null || finishedAt === null) return null;
  const diff = finishedAt - startedAt;
  return Number.isFinite(diff) && diff >= 0 ? diff : null;
}

function parseTimestamp(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.trunc(num);
}

function extractJobId(job: RawJobRecord): string {
  const direct = parseString(job["jobId"]);
  if (direct) return direct;
  const key = parseString(job["key"]);
  if (key?.startsWith("job:")) return key.slice(4);
  return key ?? "unknown";
}

function parseState(value: unknown): string {
  const str = parseString(value);
  if (!str) return "unknown";
  return str;
}

function parseString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function countArray(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  return value.length;
}

function extractStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : String(item ?? "")))
    .map((item) => item.trim())
    .filter(Boolean);
}

function enrichGroups(value: unknown, bindings: ListingBinding[]): Array<Record<string, unknown>> {
  const groups = Array.isArray(value) ? value : [];
  if (!groups.length) return [];
  const map = new Map<string, ListingBinding>();
  bindings.forEach((binding) => {
    if (binding.groupId) {
      map.set(binding.groupId, binding);
    }
  });
  return groups.map((group) => {
    if (group && typeof group === "object") {
      const record = { ...(group as Record<string, unknown>) };
      const groupId = parseString(record["groupId"]);
      if (groupId && map.has(groupId)) {
        record.binding = map.get(groupId) ?? null;
      }
      return record;
    }
    return { value: group } as Record<string, unknown>;
  });
}