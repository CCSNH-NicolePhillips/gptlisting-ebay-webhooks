import type { Handler } from "@netlify/functions";
import {
  listAllBindings,
  updateBinding,
  type ListingBinding,
  type TickSnapshot,
} from "../../src/lib/price-store.js";
import { updateOfferPrice, type EbayTokenCache } from "../../src/lib/ebay-adapter.js";
import { getOrigin, isAuthorized, isOriginAllowed, jsonResponse } from "../../src/lib/http.js";

type TickSource = "schedule" | "http";

type TickResult = {
  jobId: string;
  groupId: string;
  offerId?: string | null;
  sku?: string | null;
  action: "updated" | "skipped" | "error";
  reason?: string;
  previousPrice?: number | null;
  nextPrice?: number;
  dueAt?: number | null;
};

type TickExecution = {
  startedAt: number;
  finishedAt: number;
  dryRun: boolean;
  source: TickSource;
  totalBindings: number;
  evaluated: number;
  summary: {
    updated: number;
    skipped: number;
    errors: number;
  };
  results: TickResult[];
};

const HTTP_METHODS = "POST, OPTIONS";

function parseBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const norm = value.trim().toLowerCase();
    if (!norm) return undefined;
    if (["1", "true", "yes", "y", "on"].includes(norm)) return true;
    if (["0", "false", "no", "n", "off"].includes(norm)) return false;
  }
  return undefined;
}

function daysToMs(days: number): number {
  return Math.max(1, days) * 24 * 60 * 60 * 1000;
}

function toSnapshot(update: {
  status: TickSnapshot["status"];
  source: TickSource;
  note?: string;
  from?: number | null;
  to?: number;
  dueAt?: number | null;
}): TickSnapshot {
  return {
    at: Date.now(),
    status: update.status,
    source: update.source,
    note: update.note,
    fromPrice: update.from ?? undefined,
    toPrice: update.to,
    dueAt: update.dueAt ?? null,
  };
}

function sanitizePrice(value: number | null | undefined): number | null {
  if (!Number.isFinite(value ?? NaN)) return null;
  const num = value as number;
  if (num <= 0) return null;
  return Math.round(num * 100) / 100;
}

function computeNextPrice(binding: ListingBinding): { nextPrice: number | null; floor: number } {
  const current = sanitizePrice(binding.currentPrice) ?? 0;
  const auto = binding.auto;
  if (!auto) return { nextPrice: null, floor: 0 };
  const floor = Math.max(0, sanitizePrice(auto.minPrice) ?? 0);
  const reduced = Math.round((current - auto.reduceBy) * 100) / 100;
  const next = Math.max(floor, reduced);
  return { nextPrice: next < current ? next : current <= floor ? floor : null, floor };
}

function intervalDue(binding: ListingBinding, now: number): { due: boolean; dueAt: number } {
  const auto = binding.auto;
  if (!auto) return { due: false, dueAt: 0 };
  const last = binding.lastReductionAt ?? binding.createdAt;
  const lastMs = Number.isFinite(last) && last ? last : 0;
  const dueAt = lastMs + daysToMs(auto.everyDays);
  return { due: now >= dueAt, dueAt };
}

async function runTick(options: {
  source: TickSource;
  jobId?: string;
  groupId?: string;
  dryRun: boolean;
}): Promise<TickExecution> {
  const startedAt = Date.now();
  const bindings = await listAllBindings();
  const scoped = bindings.filter((binding) => {
    if (options.jobId && binding.jobId !== options.jobId) return false;
    if (options.groupId && binding.groupId !== options.groupId) return false;
    return true;
  });
  const tokenCache: EbayTokenCache = new Map();
  const now = Date.now();
  const results: TickResult[] = [];
  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const binding of scoped) {
    const auto = binding.auto;
    if (!auto) {
      skipped++;
      results.push({
        jobId: binding.jobId,
        groupId: binding.groupId,
        offerId: binding.offerId,
        sku: binding.sku ?? undefined,
        action: "skipped",
        reason: "auto-pricing disabled",
      });
      await updateBinding(binding.jobId, binding.groupId, {
        lastTickAt: now,
        lastTick: toSnapshot({
          status: "skipped",
          source: options.source,
          note: "auto-pricing disabled",
        }),
      }).catch(() => undefined);
      continue;
    }

    if (!binding.offerId) {
      skipped++;
      results.push({
        jobId: binding.jobId,
        groupId: binding.groupId,
        action: "skipped",
        reason: "missing offerId",
      });
      await updateBinding(binding.jobId, binding.groupId, {
        lastTickAt: now,
        lastTick: toSnapshot({
          status: "skipped",
          source: options.source,
          note: "missing offerId",
        }),
      }).catch(() => undefined);
      continue;
    }

    const { due, dueAt } = intervalDue(binding, now);
    if (!due) {
      skipped++;
      results.push({
        jobId: binding.jobId,
        groupId: binding.groupId,
        offerId: binding.offerId,
        sku: binding.sku ?? undefined,
        action: "skipped",
        reason: "interval not reached",
        dueAt,
      });
      await updateBinding(binding.jobId, binding.groupId, {
        lastTickAt: now,
        lastTick: toSnapshot({
          status: "skipped",
          source: options.source,
          note: "interval not reached",
          dueAt,
        }),
      }).catch(() => undefined);
      continue;
    }

    const currentPrice = sanitizePrice(binding.currentPrice);
    if (currentPrice === null) {
      skipped++;
      results.push({
        jobId: binding.jobId,
        groupId: binding.groupId,
        offerId: binding.offerId,
        sku: binding.sku ?? undefined,
        action: "skipped",
        reason: "current price unavailable",
      });
      await updateBinding(binding.jobId, binding.groupId, {
        lastTickAt: now,
        lastTick: toSnapshot({
          status: "skipped",
          source: options.source,
          note: "current price unavailable",
        }),
      }).catch(() => undefined);
      continue;
    }

    const { nextPrice, floor } = computeNextPrice(binding);
    const floorReached =
      nextPrice !== null && Math.abs(nextPrice - floor) < 0.011 && currentPrice <= floor + 0.011;
    if (nextPrice === null || nextPrice >= currentPrice - 0.009) {
      skipped++;
      const reason = nextPrice === null || floorReached ? "at floor" : "no change";
      results.push({
        jobId: binding.jobId,
        groupId: binding.groupId,
        offerId: binding.offerId,
        sku: binding.sku ?? undefined,
        action: "skipped",
        reason,
        previousPrice: currentPrice,
        nextPrice: nextPrice ?? floor,
      });
      await updateBinding(binding.jobId, binding.groupId, {
        lastTickAt: now,
        lastTick: toSnapshot({
          status: "skipped",
          source: options.source,
          note: reason,
          from: currentPrice,
          to: nextPrice ?? floor,
        }),
      }).catch(() => undefined);
      continue;
    }

    if (options.dryRun) {
      skipped++;
      results.push({
        jobId: binding.jobId,
        groupId: binding.groupId,
        offerId: binding.offerId,
        sku: binding.sku ?? undefined,
        action: "skipped",
        reason: "dry-run",
        previousPrice: currentPrice,
        nextPrice,
      });
      await updateBinding(binding.jobId, binding.groupId, {
        lastTickAt: now,
        lastTick: toSnapshot({
          status: "skipped",
          source: options.source,
          note: `dry-run to ${nextPrice.toFixed(2)}`,
          from: currentPrice,
          to: nextPrice,
        }),
      }).catch(() => undefined);
      continue;
    }

    try {
      const update = await updateOfferPrice(binding.userId, binding.offerId, nextPrice, {
        tokenCache,
      });
      updated++;
      results.push({
        jobId: binding.jobId,
        groupId: binding.groupId,
        offerId: binding.offerId,
        sku: binding.sku ?? undefined,
        action: "updated",
        previousPrice: update.priceBefore ?? currentPrice,
        nextPrice: update.priceAfter,
      });
      await updateBinding(binding.jobId, binding.groupId, {
        currentPrice: update.priceAfter,
        lastReductionAt: now,
        lastTickAt: now,
        lastTick: toSnapshot({
          status: "updated",
          source: options.source,
          note: `price reduced to ${update.priceAfter.toFixed(2)}`,
          from: update.priceBefore ?? currentPrice,
          to: update.priceAfter,
        }),
      }).catch(() => undefined);
    } catch (err) {
      errors++;
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        jobId: binding.jobId,
        groupId: binding.groupId,
        offerId: binding.offerId,
        sku: binding.sku ?? undefined,
        action: "error",
        reason: message,
        previousPrice: currentPrice,
        nextPrice,
      });
      await updateBinding(binding.jobId, binding.groupId, {
        lastTickAt: now,
        lastTick: toSnapshot({
          status: "error",
          source: options.source,
          note: message,
          from: currentPrice,
          to: nextPrice,
        }),
      }).catch(() => undefined);
    }
  }

  return {
    startedAt,
    finishedAt: Date.now(),
    dryRun: options.dryRun,
    source: options.source,
    totalBindings: bindings.length,
    evaluated: scoped.length,
    summary: { updated, skipped, errors },
    results,
  };
}

async function handleScheduledInvocation(): Promise<{ statusCode: number; body: string }> {
  try {
    const result = await runTick({
      source: "schedule",
      dryRun: false,
    });
    console.log("price-tick", JSON.stringify({
      source: result.source,
      dryRun: result.dryRun,
      summary: result.summary,
      evaluated: result.evaluated,
      total: result.totalBindings,
    }));
    return { statusCode: 200, body: JSON.stringify({ ok: true, ...result }) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("price-tick schedule failed", err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: message }) };
  }
}

export const handler: Handler = async (event) => {
  if (!event.httpMethod) {
    return handleScheduledInvocation();
  }

  const headers = event.headers as Record<string, string | undefined>;
  const originHdr = getOrigin(headers);

  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(200, {}, originHdr, HTTP_METHODS);
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" }, originHdr, HTTP_METHODS);
  }

  if (!isOriginAllowed(originHdr)) {
    return jsonResponse(403, { error: "Forbidden" }, originHdr, HTTP_METHODS);
  }

  if (!isAuthorized(headers)) {
    return jsonResponse(401, { error: "Unauthorized" }, originHdr, HTTP_METHODS);
  }

  let payload: any;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return jsonResponse(400, { error: "Invalid JSON" }, originHdr, HTTP_METHODS);
  }

  const dryParam = payload.dryRun ?? payload.preview;
  const dryRun = parseBoolean(dryParam) ?? false;
  const jobId = typeof payload.jobId === "string" ? payload.jobId.trim() : undefined;
  const groupId = typeof payload.groupId === "string" ? payload.groupId.trim() : undefined;

  try {
    const result = await runTick({
      source: "http",
      dryRun,
      jobId,
      groupId,
    });
    return jsonResponse(200, { ok: true, ...result }, originHdr, HTTP_METHODS);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse(500, { error: "Failed to execute price tick", detail: message }, originHdr, HTTP_METHODS);
  }
};
