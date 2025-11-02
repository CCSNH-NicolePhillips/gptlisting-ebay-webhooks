import { mergeGroups, sanitizeUrls, toDirectDropbox } from "./merge.js";
import { lookupMarketPrice } from "./price-lookup.js";
import { applyPricingFormula } from "./price-formula.js";
import { runVision } from "./vision-router.js";
import { getCachedBatch, setCachedBatch } from "./vision-cache.js";
import type { ImageInsight } from "./image-insight.js";
import { clipImageEmbedding, cosine } from "./clip-client-split.js";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function envFlag(value?: string | null): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && ["1", "true", "yes", "on"].includes(normalized);
}

type RoleInfo = { role?: "front" | "back"; hasVisibleText?: boolean; ocr?: string };

function base(u: string): string {
  if (!u) return "";
  try {
    const trimmed = u.trim();
    if (!trimmed) return "";
    const withoutQuery = trimmed.split("?")[0];
    const idx = withoutQuery.lastIndexOf("/");
    return idx >= 0 ? withoutQuery.slice(idx + 1) : withoutQuery;
  } catch {
    return u;
  }
}

function normalizeFolder(value: string | null | undefined): string {
  if (!value) return "";
  return value.replace(/^[\\/]+/, "").trim();
}

function extractInsightOcr(insight: ImageInsight | undefined): string {
  if (!insight) return "";
  const payload: any = insight;
  const parts: string[] = [];
  const push = (entry: unknown) => {
    if (typeof entry === "string" && entry.trim()) parts.push(entry.trim());
  };
  push(payload?.ocrText);
  if (Array.isArray(payload?.textBlocks)) push(payload.textBlocks.join(" "));
  push(payload?.text);
  if (typeof payload?.ocr?.text === "string") push(payload.ocr.text);
  if (Array.isArray(payload?.ocr?.lines)) push(payload.ocr.lines.join(" "));
  return parts.join(" ").trim();
}

function normalizeTextArray(source: unknown): string[] | undefined {
  if (!Array.isArray(source)) return undefined;
  const normalized = (source as unknown[])
    .map((entry) => (typeof entry === "string" ? entry : String(entry ?? "")))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return normalized.length ? normalized : undefined;
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

const BYPASS_VISION_CACHE = envFlag(process.env.VISION_BYPASS_CACHE);
const LOG_VISION_RESPONSES = envFlag(process.env.VISION_LOG_RESPONSES || process.env.SMARTDRAFT_LOG_VISION);

async function analyzeBatchViaVision(
  batch: string[],
  metadata: Array<{ url: string; name: string; folder: string }>,
  debugLog = false
) {
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
              const normalizedUrl = toDirectDropbox(rawUrl);
              const hasVisibleText = typeof ins.hasVisibleText === "boolean" ? ins.hasVisibleText : undefined;
              const dominantColor =
                typeof ins.dominantColor === "string" ? ins.dominantColor.toLowerCase().trim() : undefined;
              const role = typeof ins.role === "string" ? ins.role.toLowerCase().trim() : undefined;
              const textBlocks = normalizeTextArray(ins.textBlocks);
              const ocrText = typeof ins.ocrText === "string" ? ins.ocrText : undefined;
              const text = typeof ins.text === "string" ? ins.text : undefined;
              const ocrLines = normalizeTextArray(ins?.ocr?.lines);
              const ocrTextField = typeof ins?.ocr?.text === "string" ? ins.ocr.text : undefined;
              const ocrPayload = ocrTextField || (ocrLines && ocrLines.length)
                ? {
                    text: ocrTextField,
                    lines: ocrLines,
                  }
                : undefined;
              return {
                url: normalizedUrl,
                hasVisibleText,
                dominantColor,
                role,
                ocrText,
                textBlocks,
                text,
                ocr: ocrPayload,
              };
            })
            .filter(Boolean);
        }
        if (debugLog || LOG_VISION_RESPONSES) {
          try {
            console.log("🤖 Vision cached response:", JSON.stringify(result, null, 2));
          } catch {
            console.log("🤖 Vision cached response (non-serializable):", result);
          }
        }
        return result;
      } catch {
        const fallback = { ...cached, _cache: true } as any;
        if (debugLog || LOG_VISION_RESPONSES) {
          try {
            console.log("🤖 Vision cached response:", JSON.stringify(fallback, null, 2));
          } catch {
            console.log("🤖 Vision cached response (non-serializable):", fallback);
          }
        }
        return fallback;
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
    "Return STRICT JSON: { groups: [{ groupId, brand, product, variant, size, category, categoryPath, options, claims, confidence, images[], primaryImageUrl, secondaryImageUrl, supportingImageUrls }], imageInsights: [{ url, hasVisibleText, dominantColor, role }] }.",
    "primaryImageUrl must point to the best hero/front image (always include when available). secondaryImageUrl should reference the clearest back/label view. supportingImageUrls is an array of other helpful angles (use [] or omit when none).",
    "Ensure every listed URL is an exact image URL and appears in group.images. imageInsights.url must match one of those URLs.",
    "If uncertain, group best-guess and lower confidence, but avoid mixing images whose hints differ (e.g. different folder or filename).",
  ].join("\n");

  try {
    const result = await withRetry(() => runVision({ images: batch, prompt }));
    if (debugLog || LOG_VISION_RESPONSES) {
      try {
        console.log("🤖 Vision raw response:", JSON.stringify(result, null, 2));
      } catch {
        console.log("🤖 Vision raw response (non-serializable):", result);
      }
    }
    // Post-process images: some providers may return placeholders or omit URLs.
    try {
      const validHttp = (u: unknown) => typeof u === "string" && /^https?:\/\//i.test(u.trim());
      const normalizeUrl = (value: unknown): string | null => {
        if (typeof value !== "string") return null;
        const trimmed = value.trim();
        if (!trimmed) return null;
        try {
          return toDirectDropbox(trimmed);
        } catch {
          return null;
        }
      };
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
          const imageSet = new Set<string>(g.images);

          const maybePrimary =
            normalizeUrl(g?.primaryImageUrl) ||
            normalizeUrl(g?.primary_image_url) ||
            normalizeUrl(g?.heroImageUrl) ||
            normalizeUrl(g?.heroUrl);
          if (maybePrimary) {
            g.primaryImageUrl = maybePrimary;
            if (!g.heroUrl) g.heroUrl = maybePrimary;
            if (!imageSet.has(maybePrimary)) {
              g.images.unshift(maybePrimary);
              imageSet.add(maybePrimary);
            }
          } else if (g?.primaryImageUrl !== undefined) {
            delete g.primaryImageUrl;
          }

          const maybeSecondary =
            normalizeUrl(g?.secondaryImageUrl) ||
            normalizeUrl(g?.secondary_image_url) ||
            normalizeUrl(g?.backImageUrl) ||
            normalizeUrl(g?.backUrl);
          if (maybeSecondary && maybeSecondary !== g.primaryImageUrl) {
            g.secondaryImageUrl = maybeSecondary;
            if (!g.backUrl) g.backUrl = maybeSecondary;
            if (!imageSet.has(maybeSecondary)) {
              g.images.push(maybeSecondary);
              imageSet.add(maybeSecondary);
            }
          } else if (g?.secondaryImageUrl !== undefined) {
            delete g.secondaryImageUrl;
          }

          if (typeof g?.heroUrl === "string") {
            const normalizedHero = normalizeUrl(g.heroUrl);
            if (normalizedHero) {
              g.heroUrl = normalizedHero;
              if (!imageSet.has(normalizedHero)) {
                g.images.unshift(normalizedHero);
                imageSet.add(normalizedHero);
              }
            } else {
              delete g.heroUrl;
            }
          }

          if (typeof g?.backUrl === "string") {
            const normalizedBack = normalizeUrl(g.backUrl);
            if (normalizedBack) {
              g.backUrl = normalizedBack;
              if (!imageSet.has(normalizedBack)) {
                g.images.push(normalizedBack);
                imageSet.add(normalizedBack);
              }
            } else {
              delete g.backUrl;
            }
          }

          const supportingRaw = Array.isArray(g?.supportingImageUrls)
            ? (g.supportingImageUrls as unknown[])
            : Array.isArray(g?.supporting_image_urls)
            ? (g.supporting_image_urls as unknown[])
            : null;
          if (supportingRaw) {
            const supporting: string[] = supportingRaw
              .map((value: unknown) => normalizeUrl(value))
              .filter((value): value is string => Boolean(value));
            const deduped = Array.from(new Set<string>(supporting.filter((url: string) => imageSet.has(url))));
            if (deduped.length) {
              g.supportingImageUrls = deduped;
            } else {
              delete g.supportingImageUrls;
            }
          }
        }
      }
      if (Array.isArray(anyResult?.imageInsights)) {
        anyResult.imageInsights = anyResult.imageInsights
          .map((ins: any) => {
            if (!ins || typeof ins !== "object") return null;
            const rawUrl = typeof ins.url === "string" ? ins.url : "";
            if (!rawUrl) return null;
            const normalizedUrl = toDirectDropbox(rawUrl);
            const hasVisibleText = typeof ins.hasVisibleText === "boolean" ? ins.hasVisibleText : undefined;
            const dominantColor =
              typeof ins.dominantColor === "string" ? ins.dominantColor.toLowerCase().trim() : undefined;
            const role = typeof ins.role === "string" ? ins.role.toLowerCase().trim() : undefined;
            const textBlocks = normalizeTextArray(ins.textBlocks);
            const ocrText = typeof ins.ocrText === "string" ? ins.ocrText : undefined;
            const text = typeof ins.text === "string" ? ins.text : undefined;
            const ocrLines = normalizeTextArray(ins?.ocr?.lines);
            const ocrTextField = typeof ins?.ocr?.text === "string" ? ins.ocr.text : undefined;
            const ocrPayload = ocrTextField || (ocrLines && ocrLines.length)
              ? {
                  text: ocrTextField,
                  lines: ocrLines,
                }
              : undefined;
            return {
              url: normalizedUrl,
              hasVisibleText,
              dominantColor,
              role,
              ocrText,
              textBlocks,
              text,
              ocr: ocrPayload,
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

export type AnalysisResult = {
  info: string;
  summary: {
    batches: number;
    totalGroups: number;
  };
  warnings: string[];
  groups: any[];
  imageInsights: Record<string, ImageInsight>;
  orphans: Array<{ url: string; name?: string; folder?: string }>;
};

export async function runAnalysis(
  inputUrls: string[],
  rawBatchSize = 12,
  opts: {
    skipPricing?: boolean;
    metadata?: Array<{ url: string; name: string; folder: string }>;
    debugVisionResponse?: boolean;
  } = {}
): Promise<AnalysisResult> {
  const { skipPricing = false, metadata, debugVisionResponse = false } = opts;
  let images = sanitizeUrls(inputUrls).map(toDirectDropbox);
  const insightMap = new Map<string, ImageInsight>();
  const useLegacyAssignment = envFlag(process.env.USE_LEGACY_IMAGE_ASSIGNMENT);

  const ensureInsightEntry = (value: string | null | undefined) => {
    if (!value) return;
    const normalized = toDirectDropbox(value);
    if (!normalized) return;
    const existing = insightMap.get(normalized);
    if (existing) {
      if (!existing.url) existing.url = normalized;
      return;
    }
    insightMap.set(normalized, { url: normalized });
  };

  if (images.length === 0) {
    return {
      info: "No valid images",
      summary: { batches: 0, totalGroups: 0 },
      warnings: ["No valid image URLs"],
      groups: [],
      imageInsights: {},
      orphans: [],
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
  const metadataList: Array<{ url: string; name: string; folder: string }> = [];
  if (Array.isArray(metadata)) {
    for (const meta of metadata) {
      if (!meta?.url) continue;
      const normalizedUrl = toDirectDropbox(meta.url);
      const entry = {
        url: normalizedUrl,
        name: meta.name || "",
        folder: meta.folder || "",
      };
      metaLookup.set(normalizedUrl, entry);
      metadataList.push(entry);
    }
  }

  const verifiedBatches = chunkArray(verified, batchSize);

  const analyzedResults: any[] = [];
  const warnings: string[] = [...preflightWarnings];

  for (const [idx, batch] of verifiedBatches.entries()) {
    console.log(`🧠 Analyzing batch ${idx + 1}/${verifiedBatches.length} (${batch.length} images)`);
  const metaForBatch = batch.map((url) => metaLookup.get(url) || { url, name: "", folder: "" });
  const result = await analyzeBatchViaVision(batch, metaForBatch, debugVisionResponse);
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
  let orphanDetails: Array<{ url: string; name?: string; folder?: string }> = [];

  const uniqueImages = new Set(images);
  uniqueImages.forEach((url) => ensureInsightEntry(url));

  if (!useLegacyAssignment && merged.groups.length) {
    type FolderState = {
      key: string;
      label: string;
      urls: string[];
      remaining: Set<string>;
    };

    type SnapshotCandidate = {
      url: string;
      name: string;
      folderKey: string;
      _role?: "front" | "back";
      _ocr: string;
      _hasText: boolean;
    };

    const metaByUrl = new Map<string, { name: string; folder: string }>();
    const folderState = new Map<string, FolderState>();
    const folderOrder: string[] = [];

    const ensureFolderState = (key: string, label?: string): FolderState => {
      const normalizedKey = normalizeFolder(key);
      if (!folderState.has(normalizedKey)) {
        folderState.set(normalizedKey, {
          key: normalizedKey,
          label: label ?? key ?? "",
          urls: [],
          remaining: new Set<string>(),
        });
        folderOrder.push(normalizedKey);
      } else if (label && !folderState.get(normalizedKey)!.label) {
        folderState.get(normalizedKey)!.label = label;
      }
      return folderState.get(normalizedKey)!;
    };

    const registerUrl = (rawUrl: string, name = "", folderLabel = "") => {
      if (!rawUrl) return;
      const url = toDirectDropbox(rawUrl);
      if (!url) return;
      const key = normalizeFolder(folderLabel);
      const state = ensureFolderState(key, folderLabel);
      if (!state.remaining.has(url)) {
        state.urls.push(url);
        state.remaining.add(url);
      }
      if (!metaByUrl.has(url)) {
        metaByUrl.set(url, { name, folder: folderLabel });
      }
    };

    if (metadataList.length) {
      for (const meta of metadataList) {
        registerUrl(meta.url, meta.name, meta.folder);
      }
    }

    for (const url of verified) {
      if (!metaByUrl.has(url)) {
        const meta = metaLookup.get(url);
        registerUrl(url, meta?.name || "", meta?.folder || "");
      }
    }

    if (!folderState.size) {
      ensureFolderState("");
      for (const url of verified) {
        registerUrl(url, "", "");
      }
    }

    const roleByBase = new Map<string, RoleInfo>();
    for (const insight of insightMap.values()) {
      if (!insight?.url) continue;
      const key = base(insight.url).toLowerCase();
      const rawRole = typeof insight.role === "string" ? insight.role.toLowerCase().trim() : "";
      const role = rawRole === "front" || rawRole === "back" ? (rawRole as "front" | "back") : undefined;
      roleByBase.set(key, {
        role,
        hasVisibleText: insight.hasVisibleText === true,
        ocr: extractInsightOcr(insight),
      });
    }

    const infoFor = (url: string): RoleInfo => {
      const key = base(url).toLowerCase();
      return roleByBase.get(key) || {};
    };

    const vectorCache = new Map<string, Promise<number[] | null>>();
    const getImageVector = (url: string): Promise<number[] | null> => {
      const normalized = toDirectDropbox(url);
      if (!normalized) return Promise.resolve(null);
      if (!vectorCache.has(normalized)) {
        vectorCache.set(
          normalized,
          clipImageEmbedding(normalized)
            .then((vec) => (Array.isArray(vec) ? vec : null))
            .catch((err) => {
              console.warn("[vision-role] clip embedding failed", normalized, err);
              return null;
            })
        );
      }
      return vectorCache.get(normalized)!;
    };

    const looksBack = (text: string | undefined, name: string | undefined): boolean => {
      const lowerText = (text || "").toLowerCase();
      const lowerName = (name || "").toLowerCase();
      return (
        lowerText.includes("supplement facts") ||
        lowerText.includes("nutrition facts") ||
        lowerText.includes("ingredients") ||
        lowerText.includes("drug facts") ||
        lowerText.includes("directions") ||
        lowerName.includes("back") ||
        lowerName.includes("facts") ||
        lowerName.includes("ingredients") ||
        lowerName.includes("supplement")
      );
    };

    const debugSelection: {
      groups: Array<{
        groupId?: string;
        name?: string;
        heroUrl: string | null;
        backUrl: string | null;
        roles: Array<{ url: string; role: string | null }>;
      }>;
    } = { groups: [] };

    const backMinEnv = Number(process.env.BACK_MIN_SIM);
    const BACK_MIN_SIM = Number.isFinite(backMinEnv) ? backMinEnv : 0.35;

    const folderKeysWithRemaining = (): string[] =>
      folderOrder.filter((key) => (folderState.get(key)?.remaining.size ?? 0) > 0);

    for (const group of merged.groups) {
      const preferredFolders: string[] = [];
      if (typeof group.folder === "string" && group.folder.trim()) {
        preferredFolders.push(normalizeFolder(group.folder));
      }

      const hintedUrls = [group.primaryImageUrl, group.heroUrl, group.secondaryImageUrl, group.backUrl]
        .map((value) => (typeof value === "string" ? toDirectDropbox(value) : ""))
        .filter(Boolean);
      for (const url of hintedUrls) {
        const meta = metaByUrl.get(url);
        if (meta?.folder) {
          preferredFolders.push(normalizeFolder(meta.folder));
        }
      }

      let folderKey: string | undefined;
      const uniquePreferred = preferredFolders.filter((value, index, array) => array.indexOf(value) === index);
      for (const key of uniquePreferred) {
        const state = folderState.get(key);
        if (state && state.remaining.size) {
          folderKey = key;
          break;
        }
      }

      if (!folderKey) {
        const availableKeys = folderKeysWithRemaining();
        folderKey = availableKeys[0] ?? folderOrder[0] ?? "";
      }

      const state = ensureFolderState(folderKey || "");
      const snapshot = state.urls.filter((url) => state.remaining.has(url));

      const candidates: SnapshotCandidate[] = snapshot.map((url) => {
        const info = infoFor(url);
        const role = info.role === "front" || info.role === "back" ? info.role : undefined;
        const meta = metaByUrl.get(url);
        const name = meta?.name || base(url);
        return {
          url,
          name,
          folderKey: state.key,
          _role: role,
          _ocr: info.ocr || "",
          _hasText: info.hasVisibleText === true,
        };
      });

      const brand = typeof group.brand === "string" ? group.brand.toLowerCase() : "";
      const product = typeof group.product === "string" ? group.product.toLowerCase() : "";
      const tokens = [brand, product].filter(Boolean);
      const brandScore = (text: string): number => {
        const lower = (text || "").toLowerCase();
        let score = 0;
        for (const token of tokens) {
          if (token && lower.includes(token)) score++;
        }
        return score;
      };

      let heroCandidate: SnapshotCandidate | undefined = candidates
        .filter((candidate) => candidate._role === "front")
        .sort((a, b) => brandScore(b._ocr) - brandScore(a._ocr))[0];

      if (!heroCandidate && candidates.length) {
        heroCandidate = candidates
          .slice()
          .sort((a, b) => {
            const brandDelta = brandScore(b._ocr) - brandScore(a._ocr);
            if (brandDelta !== 0) return brandDelta;
            const textDelta = Number(b._hasText) - Number(a._hasText);
            if (textDelta !== 0) return textDelta;
            return 0;
          })[0];
      }

      if (!heroCandidate) {
        heroCandidate = candidates[0];
      }

      const heroUrl = heroCandidate?.url ?? null;

      let backCandidate: SnapshotCandidate | undefined = candidates.find(
        (candidate) => candidate.url !== heroUrl && candidate._role === "back"
      );

      if (!backCandidate) {
        backCandidate = candidates
          .filter((candidate) => candidate.url !== heroUrl)
          .sort((a, b) => {
            const looksDelta = Number(looksBack(b._ocr, b.name)) - Number(looksBack(a._ocr, a.name));
            if (looksDelta !== 0) return looksDelta;
            return brandScore(b._ocr) - brandScore(a._ocr);
          })[0];
      }

      if (!backCandidate && heroUrl) {
        const heroVec = await getImageVector(heroUrl);
        if (heroVec) {
          const scored = await Promise.all(
            candidates
              .filter((candidate) => candidate.url !== heroUrl)
              .map(async (candidate) => {
                const vec = await getImageVector(candidate.url);
                const score = vec && heroVec && vec.length === heroVec.length ? cosine(vec, heroVec) : 0;
                return { candidate, score };
              })
          );
          scored.sort((a, b) => b.score - a.score);
          if (scored[0] && scored[0].score >= BACK_MIN_SIM) {
            backCandidate = scored[0].candidate;
          }
        }
      }

      const backUrl = backCandidate?.url ?? null;

      const finalTwo = [heroUrl, backUrl]
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .filter((url, index, array) => array.indexOf(url) === index)
        .slice(0, 2);

      group.heroUrl = heroUrl || null;
      group.primaryImageUrl = heroUrl || null;
      group.backUrl = backUrl || null;
      group.secondaryImageUrl = backUrl || null;
      group.images = finalTwo;
      if (group.supportingImageUrls) delete group.supportingImageUrls;
      if (!group.folder) {
        group.folder = folderState.get(state.key)?.label || "";
      }

      for (const url of finalTwo) {
        state.remaining.delete(url);
      }

      debugSelection.groups.push({
        groupId: typeof group.groupId === "string" ? group.groupId : undefined,
        name: typeof group.product === "string" ? group.product : undefined,
        heroUrl,
        backUrl,
        roles: candidates.map((candidate) => ({
          url: candidate.url,
          role: candidate._role ?? null,
        })),
      });
    }

    if (debugVisionResponse) {
      console.log(JSON.stringify({ evt: "vision-role-selection", groups: debugSelection.groups }));
    }

    const orphanSet = new Set<string>();
    for (const state of folderState.values()) {
      for (const url of state.remaining) {
        orphanSet.add(url);
      }
    }

    orphanDetails = Array.from(orphanSet).map((url) => {
      const meta = metaByUrl.get(url);
      return {
        url,
        name: meta?.name,
        folder: meta?.folder,
      };
    });
  } else {
    orphanDetails = [];
    for (const group of merged.groups) {
      const seen = new Set<string>();
      const imgs = Array.isArray(group?.images) ? group.images : [];
      const unique: string[] = [];
      for (const raw of imgs) {
        if (typeof raw !== "string") continue;
        const normalized = toDirectDropbox(raw);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        unique.push(normalized);
      }
      group.images = unique;
    }
  }

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
      orphans: orphanDetails,
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
    orphans: orphanDetails,
  };
}
