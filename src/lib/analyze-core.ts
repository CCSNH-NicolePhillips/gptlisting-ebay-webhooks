import { mergeGroups, sanitizeUrls, toDirectDropbox } from "./merge.js";
import { lookupMarketPrice } from "./price-lookup.js";
import { applyPricingFormula } from "./price-formula.js";
import { runVision } from "./vision-router.js";
import { getCachedBatch, setCachedBatch } from "./vision-cache.js";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type RetryOptions = {
  maxRetries?: number;
  baseDelayMs?: number;
  factor?: number;
  jitterPct?: number;
};

async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 300;
  const factor = opts.factor ?? 2;
  const jitterPct = opts.jitterPct ?? 0.25;

  let attempt = 0;
  let lastErr: unknown;

  while (attempt <= maxRetries) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      attempt++;

      const status = err?.status ?? err?.response?.status;
      const retryable =
        status === 429 ||
        (typeof status === "number" && status >= 500 && status < 600) ||
        err?.code === "ETIMEDOUT" ||
        err?.code === "ECONNRESET" ||
        err?.name === "FetchError";

      if (!retryable || attempt > maxRetries) {
        break;
      }

      const delay = Math.round(baseDelayMs * Math.pow(factor, attempt - 1));
      const jitter = Math.round(delay * (Math.random() * 2 * jitterPct - jitterPct));
      await sleep(Math.max(50, delay + jitter));
    }
  }

  throw lastErr;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

function abortableFetch(url: string, init: RequestInit = {}, timeoutMs = 2000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await fn(items[current], current);
    }
  }

  const workers = new Array(Math.min(limit, items.length)).fill(0).map(() => worker());
  await Promise.all(workers);
  return results;
}

async function verifyUrl(url: string): Promise<boolean> {
  try {
    const res = await abortableFetch(url, { method: "HEAD" }, 2000);

    if (res.ok || (res.status >= 300 && res.status < 400) || res.status === 403) {
      return true;
    }

    if (res.status === 405) {
      const getRes = await abortableFetch(
        url,
        {
          method: "GET",
          headers: { Range: "bytes=0-0" },
        },
        2000
      );
      return getRes.ok || getRes.status === 206;
    }

    return false;
  } catch (err) {
    console.warn(`HEAD failed for ${url}:`, (err as Error).message);
    return false;
  }
}

const BYPASS_VISION_CACHE = (process.env.VISION_BYPASS_CACHE || "false").toLowerCase() === "true";

async function analyzeBatchViaVision(batch: string[]) {
  const cacheEligible = !BYPASS_VISION_CACHE;

  if (cacheEligible) {
    const cached = await getCachedBatch(batch);
    if (cached?.groups) {
      return { ...cached, _cache: true };
    }
  }

  const prompt = [
    "You are a product photo analyst.",
    "Group visually identical products (front/back/side).",
    "Extract: brand, product, variant/flavor, size/servings, best-fit category label, categoryPath (parent > child), options object of item specifics (e.g. { Flavor, Formulation, Features, Ingredients, Dietary Feature }), short claims[].",
    "Return STRICT JSON: { groups: [{ groupId, brand, product, variant, size, category, categoryPath, options, claims, confidence, images[] }] }.",
    "If uncertain, group best-guess and lower confidence.",
  ].join("\n");

  try {
    const result = await withRetry(() => runVision({ images: batch, prompt }));
    if (cacheEligible) {
      await setCachedBatch(batch, result);
    }
    return result;
  } catch (err: any) {
    const status = err?.status ?? err?.response?.status;
    console.error("❌ Vision batch failed permanently:", status, err?.message || err);
    return {
      groups: [],
      _error: `Vision failed: status=${status ?? "n/a"} msg=${err?.message ?? "unknown"}`,
    };
  }
}

export type AnalysisResult = {
  info: string;
  summary: {
    batches: number;
    totalGroups: number;
  };
  warnings: string[];
  groups: any[];
};

export async function runAnalysis(
  inputUrls: string[],
  rawBatchSize = 12,
  opts: { skipPricing?: boolean } = {}
): Promise<AnalysisResult> {
  const { skipPricing = false } = opts;
  let images = sanitizeUrls(inputUrls).map(toDirectDropbox);

  if (images.length === 0) {
    return {
      info: "No valid images",
      summary: { batches: 0, totalGroups: 0 },
      warnings: ["No valid image URLs"],
      groups: [],
    };
  }

  const batchSize = Math.min(Math.max(Number(rawBatchSize) || 12, 4), 12);

  const checks = await mapLimit(images, 6, (url) => verifyUrl(url));
  const verified = images.filter((_, idx) => {
    const reachable = Boolean(checks[idx]);
    if (!reachable) {
      console.warn(`⚠️ Skipping unreachable image: ${images[idx]}`);
    }
    return reachable;
  });

  const verifiedBatches = chunkArray(verified, batchSize);

  const analyzedResults: any[] = [];
  const warnings: string[] = [];

  for (const [idx, batch] of verifiedBatches.entries()) {
    console.log(`🧠 Analyzing batch ${idx + 1}/${verifiedBatches.length} (${batch.length} images)`);
    const result = await analyzeBatchViaVision(batch);
    if (result?._error) {
      warnings.push(`Batch ${idx + 1}: ${result._error}`);
    }
    analyzedResults.push(result);
  }

  const merged = mergeGroups(analyzedResults);
  console.log("🧩 Merge complete. Groups:", merged.groups.length);
  console.log(
    JSON.stringify({
      evt: "analyze-images.done",
      batches: verifiedBatches.length,
      groups: merged.groups.length,
      warningsCount: warnings.length,
    })
  );

  if (skipPricing) {
    return {
      info: "Image analysis complete (pricing skipped)",
      summary: {
        batches: verifiedBatches.length,
        totalGroups: merged.groups.length,
      },
      warnings,
      groups: merged.groups,
    };
  }

  const finalGroups: any[] = [];

  for (const group of merged.groups) {
    const brand = typeof group.brand === "string" ? group.brand.trim() : "";
    const product = typeof group.product === "string" ? group.product.trim() : "";
    const variant = typeof group.variant === "string" ? group.variant.trim() : "";
    const parts = [brand, product, variant].filter(Boolean);
    const label = parts.join(" ").trim();

    if (!label) {
      warnings.push(`Pricing skipped: insufficient product details for group ${group.groupId || "unknown"}`);
      finalGroups.push({ ...group, market: null, pricing: null });
      continue;
    }

    try {
      const market = await lookupMarketPrice(brand, product, variant);

      if (!market.avg || market.avg === 0) {
        warnings.push(`No live price found for "${label}".`);
        finalGroups.push({ ...group, market, pricing: null });
        continue;
      }

      const pricing = applyPricingFormula(market.avg);
      if (!pricing) {
        warnings.push(`Pricing unavailable for "${label}" (avg=${market.avg || 0})`);
        finalGroups.push({ ...group, market, pricing: null });
        continue;
      }

      finalGroups.push({ ...group, market, pricing });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`Price lookup failed for "${label}": ${message}`);
      finalGroups.push({ ...group, market: null, pricing: null });
    }
  }

  return {
    info: "Full analysis with market pricing and auto-reduction schedule.",
    summary: {
      batches: verifiedBatches.length,
      totalGroups: finalGroups.length,
    },
    warnings,
    groups: finalGroups,
  };
}
