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

function abortableFetch(url: string, init: RequestInit = {}, timeoutMs = 6000) {
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
    const res = await abortableFetch(url, { method: "HEAD" });

    if (res.ok || (res.status >= 300 && res.status < 400) || res.status === 403) {
      return true;
    }

    // Fallback: many hosts disallow HEAD or respond with non-OK; try a tiny ranged GET
    const getRes = await abortableFetch(
      url,
      {
        method: "GET",
        headers: { Range: "bytes=0-0" },
      }
    );
    return getRes.ok || getRes.status === 206;
  } catch (err) {
    // Final fallback attempt via GET in case HEAD aborted/failed
    try {
      const getRes = await abortableFetch(
        url,
        {
          method: "GET",
          headers: { Range: "bytes=0-0" },
        }
      );
      return getRes.ok || getRes.status === 206;
    } catch (err2) {
      console.warn(`URL verify failed for ${url}:`, (err2 as Error).message);
      return false;
    }
  }
}

const BYPASS_VISION_CACHE = (process.env.VISION_BYPASS_CACHE || "false").toLowerCase() === "true";

async function analyzeBatchViaVision(batch: string[], metadata: Array<{ url: string; name: string; folder: string }>) {
  const cacheEligible = !BYPASS_VISION_CACHE;

  if (cacheEligible) {
    const cached = await getCachedBatch(batch);
    if (cached?.groups) {
      // Ensure images are usable even for cached results
      try {
        const result = { ...cached, _cache: true } as any;
        const validHttp = (u: unknown) => typeof u === "string" && /^https?:\/\//i.test((u as string).trim());
        if (Array.isArray(result?.groups)) {
          for (const g of result.groups) {
            const raw = Array.isArray(g?.images) ? g.images : [];
            let imgs = raw.filter(validHttp);
            const hasPlaceholder = raw.some((u: unknown) => typeof u === "string" && /placeholder/i.test(u as string));
            if (imgs.length === 0 || hasPlaceholder) {
              imgs = batch.slice(0, 12);
            }
            g.images = imgs.map((u: string) => toDirectDropbox(u));
          }
        }
        if (Array.isArray(result?.imageInsights)) {
          result.imageInsights = result.imageInsights
            .map((ins: any) => {
              if (!ins || typeof ins !== "object") return null;
              const rawUrl = typeof ins.url === "string" ? ins.url : "";
              if (!rawUrl) return null;
              return {
                url: toDirectDropbox(rawUrl),
                hasVisibleText: typeof ins.hasVisibleText === "boolean" ? ins.hasVisibleText : undefined,
                dominantColor: typeof ins.dominantColor === "string" ? ins.dominantColor.toLowerCase().trim() : undefined,
                role: typeof ins.role === "string" ? ins.role.toLowerCase().trim() : undefined,
              };
            })
            .filter(Boolean);
        }
        return result;
      } catch {
        return { ...cached, _cache: true };
      }
    }
  }

  const hints = metadata
    .map((meta, idx) => {
      const parts = [meta.folder, meta.name]
        .filter(Boolean)
        .map((part) => part.replace(/\s+/g, " ").trim())
        .filter((part) => part.length > 0)
        .join(" | ");
      return parts ? `#${idx + 1}: ${parts}` : `#${idx + 1}: ${meta.url}`;
    })
    .join("\n");

  const prompt = [
    "You are a product photo analyst.",
    "Group visually identical products (front/back/side).",
    "EXTRA CONTEXT PER IMAGE (filenames, parent folders):",
    hints || "(no hints)",
    "Use those hints and your visual judgement to split groups by product/variant even when packaging looks similar.",
    "Extract: brand, product, variant/flavor, size/servings, best-fit category label, categoryPath (parent > child), options object of item specifics (e.g. { Flavor, Formulation, Features, Ingredients, Dietary Feature }), short claims[].",
    "For EVERY image also include quick insights so downstream code can reason about it: hasVisibleText (true/false), dominantColor (one of: black, white, gray, red, orange, yellow, green, blue, purple, brown, multi), role (front, back, side, detail, accessory, packaging, other).",
    "Return STRICT JSON: { groups: [{ groupId, brand, product, variant, size, category, categoryPath, options, claims, confidence, images[] }], imageInsights: [{ url, hasVisibleText, dominantColor, role }] }.",
    "Ensure group.images entries are strings (exact image URLs). imageInsights.url must match one of those URLs.",
    "If uncertain, group best-guess and lower confidence, but avoid mixing images whose hints differ (e.g. different folder or filename).",
  ].join("\n");

  try {
  const result = await withRetry(() => runVision({ images: batch, prompt }));
    // Post-process images: some providers may return placeholders or omit URLs.
    try {
      const validHttp = (u: unknown) => typeof u === "string" && /^https?:\/\//i.test(u.trim());
      const anyResult = result as any;
      if (Array.isArray(anyResult?.groups)) {
        for (const g of anyResult.groups) {
          const raw = Array.isArray(g?.images) ? g.images : [];
          let imgs = raw.filter(validHttp);
          const hasPlaceholder = raw.some((u: unknown) => typeof u === "string" && /placeholder/i.test(u));
          if (imgs.length === 0 || hasPlaceholder) {
            imgs = batch.slice(0, 12);
          }
          g.images = imgs.map((u: string) => toDirectDropbox(u));
        }
      }
      if (Array.isArray(anyResult?.imageInsights)) {
        anyResult.imageInsights = anyResult.imageInsights
          .map((ins: any) => {
            if (!ins || typeof ins !== "object") return null;
            const rawUrl = typeof ins.url === "string" ? ins.url : "";
            if (!rawUrl) return null;
            return {
              url: toDirectDropbox(rawUrl),
              hasVisibleText: typeof ins.hasVisibleText === "boolean" ? ins.hasVisibleText : undefined,
              dominantColor: typeof ins.dominantColor === "string" ? ins.dominantColor.toLowerCase().trim() : undefined,
              role: typeof ins.role === "string" ? ins.role.toLowerCase().trim() : undefined,
            };
          })
          .filter(Boolean);
      }
    } catch {}
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

export type ImageInsight = {
  url: string;
  hasVisibleText?: boolean;
  dominantColor?: string;
  role?: string;
};

export type AnalysisResult = {
  info: string;
  summary: {
    batches: number;
    totalGroups: number;
  };
  warnings: string[];
  groups: any[];
  imageInsights: Record<string, ImageInsight>;
};

export async function runAnalysis(
  inputUrls: string[],
  rawBatchSize = 12,
  opts: { skipPricing?: boolean; metadata?: Array<{ url: string; name: string; folder: string }> } = {}
): Promise<AnalysisResult> {
  const { skipPricing = false } = opts;
  let images = sanitizeUrls(inputUrls).map(toDirectDropbox);
  const insightMap = new Map<string, ImageInsight>();

  if (images.length === 0) {
    return {
      info: "No valid images",
      summary: { batches: 0, totalGroups: 0 },
      warnings: ["No valid image URLs"],
      groups: [],
      imageInsights: {},
    };
  }

  const batchSize = Math.min(Math.max(Number(rawBatchSize) || 12, 4), 12);

  const checks = await mapLimit(images, 6, (url) => verifyUrl(url));
  let verified = images.filter((_, idx) => {
    const reachable = Boolean(checks[idx]);
    if (!reachable) {
      console.warn(`⚠️ Skipping unreachable image: ${images[idx]}`);
    }
    return reachable;
  });

  const preflightWarnings: string[] = [];
  if (verified.length === 0 && images.length > 0) {
    // If every preflight failed, proceed anyway (providers may still fetch successfully)
    preflightWarnings.push("All image preflight checks failed; proceeding anyway.");
    verified = images.slice();
  } else if (verified.length < images.length) {
    const skipped = images.length - verified.length;
    preflightWarnings.push(`Skipped ${skipped} unreachable image${skipped === 1 ? '' : 's'}.`);
  }

  const metaLookup = new Map<string, { url: string; name: string; folder: string }>();
  if (Array.isArray(opts.metadata)) {
    for (const meta of opts.metadata) {
      if (!meta?.url) continue;
      metaLookup.set(toDirectDropbox(meta.url), {
        url: toDirectDropbox(meta.url),
        name: meta.name || "",
        folder: meta.folder || "",
      });
    }
  }

  const verifiedBatches = chunkArray(verified, batchSize);

  const analyzedResults: any[] = [];
  const warnings: string[] = [...preflightWarnings];

  for (const [idx, batch] of verifiedBatches.entries()) {
    console.log(`🧠 Analyzing batch ${idx + 1}/${verifiedBatches.length} (${batch.length} images)`);
    const metaForBatch = batch.map((url) => metaLookup.get(url) || { url, name: "", folder: "" });
    const result = await analyzeBatchViaVision(batch, metaForBatch);
    if (result?._error) {
      warnings.push(`Batch ${idx + 1}: ${result._error}`);
    }
    if (Array.isArray((result as any)?.imageInsights)) {
      for (const insight of (result as any).imageInsights as ImageInsight[]) {
        if (!insight?.url) continue;
        insightMap.set(insight.url, insight);
      }
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
      imageInsights: Object.fromEntries(insightMap),
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
    imageInsights: Object.fromEntries(insightMap),
  };
}
