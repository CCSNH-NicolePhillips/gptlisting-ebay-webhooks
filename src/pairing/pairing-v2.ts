// src/pairing/pairing-v2.ts
// Phase 1: Standalone pairing v2 sandbox
// Pure addition - no modifications to existing files
// Evolve pairing logic without touching runPairing.ts

import type OpenAI from "openai";
import type { FeatureRow } from "./featurePrep.js";
import type { Pair, PairingResult } from "./schema.js";
import type { PairingMetrics } from "./metrics.js";

export interface PairingV2Config {
  // later we'll add knobs like thresholds, maxImages, etc.
  maxImages?: number;
}

export interface PairingV2Input {
  features: Map<string, FeatureRow>;
  client: OpenAI;
  model: string;
  log?: (line: string) => void;
  config?: PairingV2Config;
}

export interface PairingV2Output {
  result: PairingResult;
  metrics: PairingMetrics;
  rawText: string;
}

/**
 * Phase 2: Normalized feature representation for deterministic matching
 */
interface V2Feature {
  key: string; // unique image key, usually url
  filename: string;
  basename: string;
  brandKey: string;
  colorKey: string;
  packagingKey: string;
  sizeText: string;
  productText: string;
}

function buildV2Feature(img: FeatureRow, idx: number): V2Feature | null {
  const filename = img.url || `img-${idx + 1}`;
  const basename = filename.split("/").pop() || filename;
  const key = img.url || filename;
  if (!key) return null;

  const norm = (s?: string | null) =>
    (s || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();

  const brandKey = norm(img.brandNorm);
  const colorKey = norm(img.colorKey);
  const packagingKey = norm(img.packagingHint);
  const sizeText = norm(img.sizeCanonical);
  const productTokens = Array.isArray(img.productTokens) ? img.productTokens.join(" ") : "";
  const productText = norm(productTokens);

  return {
    key,
    filename,
    basename,
    brandKey,
    colorKey,
    packagingKey,
    sizeText,
    productText,
  };
}

/**
 * Phase 2.2: Deterministic pre-match result
 */
interface V2PreMatchResult {
  pairs: Pair[];
  remaining: FeatureRow[];
  debug: string[];
}

/**
 * Phase 2.2: Deterministic pre-matching
 * 
 * Bucket images by brand + packaging, auto-pair size-2 buckets with strong similarity.
 * Leave the rest for LLM fallback.
 */
function deterministicPreMatch(
  images: FeatureRow[],
  log: (line: string) => void
): V2PreMatchResult {
  const debug: string[] = [];
  const features: V2Feature[] = [];

  images.forEach((img, idx) => {
    const f = buildV2Feature(img, idx);
    if (f) features.push(f);
  });

  if (features.length === 0) {
    return { pairs: [], remaining: images, debug };
  }

  // Bucket by brand + packaging
  const buckets = new Map<string, V2Feature[]>();

  for (const f of features) {
    const brand = f.brandKey || "unknown";
    const pkg = f.packagingKey || "unknown";
    const key = `${brand}||${pkg}`;
    const arr = buckets.get(key) || [];
    arr.push(f);
    buckets.set(key, arr);
  }

  const used = new Set<string>();
  const pairs: Pair[] = [];

  const featureByKey = new Map<string, { img: FeatureRow; f: V2Feature }>();
  images.forEach((img, idx) => {
    const f = buildV2Feature(img, idx);
    if (f) featureByKey.set(f.key, { img, f });
  });

  for (const [bucketKey, list] of buckets.entries()) {
    if (list.length !== 2) {
      debug.push(`[v2-pre] skip bucket=${bucketKey} size=${list.length}`);
      continue;
    }

    const [a, b] = list;

    // Very conservative: require same brandKey (non-empty) and same packagingKey, and at least one of:
    // - similar productText
    // - similar colorKey
    const sameBrand = a.brandKey && a.brandKey === b.brandKey;
    const samePkg = a.packagingKey && a.packagingKey === b.packagingKey;

    if (!sameBrand || !samePkg) {
      debug.push(
        `[v2-pre] bucket=${bucketKey} size=2 but brand/pkg mismatch: a.brand=${a.brandKey} b.brand=${b.brandKey} a.pkg=${a.packagingKey} b.pkg=${b.packagingKey}`
      );
      continue;
    }

    const productOverlap = jaccardSimilarity(a.productText, b.productText);
    const colorMatch = !!(a.colorKey && a.colorKey === b.colorKey);

    if (productOverlap < 0.2 && !colorMatch) {
      debug.push(
        `[v2-pre] bucket=${bucketKey} size=2 but weak product/color: productOverlap=${productOverlap.toFixed(
          2
        )} colorMatch=${colorMatch}`
      );
      continue;
    }

    const aMeta = featureByKey.get(a.key);
    const bMeta = featureByKey.get(b.key);

    if (!aMeta || !bMeta) continue;

    if (used.has(aMeta.img.url) || used.has(bMeta.img.url)) {
      debug.push(
        `[v2-pre] skip pair (already used) a=${a.basename} b=${b.basename}`
      );
      continue;
    }

    // Arbitrarily treat the lexicographically smaller basename as "front"
    const [frontMeta, backMeta] =
      a.basename <= b.basename ? [aMeta, bMeta] : [bMeta, aMeta];

    used.add(frontMeta.img.url);
    used.add(backMeta.img.url);

    debug.push(
      `[v2-pre] AUTO-PAIR brand=${a.brandKey} pkg=${a.packagingKey} front=${frontMeta.f.basename} back=${backMeta.f.basename} productOverlap=${productOverlap.toFixed(
        2
      )} colorMatch=${colorMatch}`
    );

    pairs.push({
      frontUrl: frontMeta.img.url,
      backUrl: backMeta.img.url,
      matchScore: 0.95,
      brand: frontMeta.img.brandNorm || "",
      product: frontMeta.f.productText || "",
      variant: frontMeta.f.colorKey || null,
      sizeFront: frontMeta.img.sizeCanonical || null,
      sizeBack: backMeta.img.sizeCanonical || null,
      evidence: ["PAIRING-V2-PRE-HEURISTIC"],
      confidence: 0.95,
    });
  }

  const remaining: FeatureRow[] = [];
  for (const img of images) {
    if (!img.url || !used.has(img.url)) {
      remaining.push(img);
    }
  }

  debug.push(
    `[v2-pre] summary: images=${images.length} autoPairs=${pairs.length} remaining=${remaining.length}`
  );

  debug.forEach((line) => log(line));

  return { pairs, remaining, debug };
}

/**
 * Simple Jaccard similarity over whitespace tokens
 */
function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(
    a
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean)
  );
  const setB = new Set(
    b
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean)
  );
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}

/**
 * Pairing v2 entrypoint.
 *
 * Phase 1: simply delegates to a unified direct-LLM global pairing
 * so we have a standalone sandbox that we can evolve without touching
 * the existing runPairing logic.
 */
export async function runPairingV2(input: PairingV2Input): Promise<PairingV2Output> {
  const { features, client, model, log = console.log, config } = input;
  const maxImages = config?.maxImages ?? 100;

  const allImages = Array.from(features.values());

  if (allImages.length === 0) {
    const emptyResult: PairingResult = { 
      engineVersion: "v2-phase2",
      pairs: [], 
      products: [],
      singletons: [],
      debugSummary: [],
    };
    const emptyMetrics: PairingMetrics = {
      totals: {
        images: 0,
        fronts: 0,
        backs: 0,
        candidates: 0,
        autoPairs: 0,
        modelPairs: 0,
        globalPairs: 0,
        singletons: 0,
      },
      byBrand: {},
      reasons: {},
      thresholds: {
        minPreScore: 0,
        autoPairScore: 0,
        autoPairGap: 0,
        autoPairHairScore: 0,
        autoPairHairGap: 0,
      },
      timestamp: new Date().toISOString(),
      durationMs: 0,
    };

    return { result: emptyResult, metrics: emptyMetrics, rawText: "" };
  }

  if (allImages.length > maxImages) {
    log(
      `[pairing-v2] Too many images for v2 sandbox (images=${allImages.length}, max=${maxImages})`
    );
    const emptyResult: PairingResult = { 
      engineVersion: "v2-phase2",
      pairs: [], 
      products: [],
      singletons: [],
      debugSummary: [`Too many images: ${allImages.length} > ${maxImages}`],
    };
    const emptyMetrics: PairingMetrics = {
      totals: {
        images: allImages.length,
        fronts: 0,
        backs: 0,
        candidates: 0,
        autoPairs: 0,
        modelPairs: 0,
        globalPairs: 0,
        singletons: allImages.length,
      },
      byBrand: {},
      reasons: { tooManyImages: allImages.length },
      thresholds: {
        minPreScore: 0,
        autoPairScore: 0,
        autoPairGap: 0,
        autoPairHairScore: 0,
        autoPairHairGap: 0,
      },
      timestamp: new Date().toISOString(),
      durationMs: 0,
    };
    return { result: emptyResult, metrics: emptyMetrics, rawText: "" };
  }

  // Phase 2: deterministic pre-match + LLM fallback
  const pre = deterministicPreMatch(allImages, log);
  log(
    `[pairing-v2] pre-match: autoPairs=${pre.pairs.length} remaining=${pre.remaining.length}`
  );

  const started = Date.now();
  const { pairs: llmPairs, singletons, rawText } = await unifiedGlobalLLMPairing({
    images: pre.remaining,
    client,
    model,
    log,
  });
  const durationMs = Date.now() - started;

  const combinedPairs = [...pre.pairs, ...llmPairs];

  const result: PairingResult = {
    engineVersion: "v2-phase2",
    pairs: combinedPairs,
    products: [], // v2 doesn't build products yet
    singletons: singletons.map((url) => ({ url, reason: "not paired by v2" })),
    debugSummary: [
      `V2 Phase 2: ${pre.pairs.length} heuristic pairs, ${llmPairs.length} LLM pairs, ${singletons.length} singletons`,
      ...pre.debug,
    ],
  };

  const metrics: PairingMetrics = {
    totals: {
      images: allImages.length,
      fronts: 0,
      backs: 0,
      candidates: 0,
      autoPairs: pre.pairs.length,
      modelPairs: llmPairs.length,
      globalPairs: 0,
      singletons: singletons.length,
    },
    byBrand: {},
    reasons: {},
    thresholds: {
      minPreScore: 0,
      autoPairScore: 0,
      autoPairGap: 0,
      autoPairHairScore: 0,
      autoPairHairGap: 0,
    },
    timestamp: new Date().toISOString(),
    durationMs,
  };

  log(
    `[pairing-v2] summary: totalPairs=${combinedPairs.length} singletons=${singletons.length} durationMs=${durationMs}`
  );

  return { result, metrics, rawText };
}

// Internal types for LLM payload
interface UnifiedLLMImagePayload {
  id: string;
  filename: string;
  brand: string;
  product: string;
  variant: string;
  ocrSummary: string;
  color: string;
  packaging: string;
}

interface UnifiedLLMPair {
  front: string;
  back: string;
}

async function unifiedGlobalLLMPairing({
  images,
  client,
  model,
  log = console.log,
}: {
  images: FeatureRow[];
  client: OpenAI;
  model: string;
  log?: (line: string) => void;
}): Promise<{ pairs: Pair[]; singletons: string[]; rawText: string }> {
  if (!images.length) {
    return { pairs: [], singletons: [], rawText: "" };
  }

  const payload: UnifiedLLMImagePayload[] = images.map((img, idx) => {
    const filename = img.url || `img-${idx + 1}`;
    const basename = filename.split("/").pop() || filename;

    return {
      id: `IMG${idx + 1}`,
      filename: basename,
      brand: img.brandNorm || "",
      product: (img.productTokens || []).join(" "),
      variant: (img.variantTokens || []).join(" "),
      ocrSummary: img.textExtracted?.slice(0, 400) || "",
      color: img.colorKey || "",
      packaging: img.packagingHint || "",
    };
  });

  const systemPrompt = `
You are pairing product images (front and back).

Each product has exactly:
- one front image
- one back image

You receive a flat list of images. Your tasks:

1. Decide which images are fronts and which are backs.
2. Pair each front with its corresponding back.
3. Use brand, product name, flavor, size, color, packaging, and OCR text to match.
4. Some brands may differ slightly between front and back (e.g. "evereden" vs "Barbie x Evereden"). Treat them as the same product if the product details clearly match.
5. Some backs may have missing brand. Still try to match them to the correct front using text, packaging, and color.

Return ONLY valid front/back pairs. Do NOT leave images unpaired unless absolutely impossible.

Return strict JSON of the form:

{
  "pairs": [
    { "front": "20251115_142814.jpg", "back": "20251115_142824.jpg" }
  ]
}
`.trim();

  const userContent = { images: payload };

  log(`[pairing-v2] [LLM-unified] Sending ${payload.length} images to model for global pairing`);

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: JSON.stringify(userContent, null, 2) },
    ],
    temperature: 0,
    response_format: { type: "json_object" },
  });

  const content = response.choices[0]?.message?.content || "{}";
  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    log(`[pairing-v2] [LLM-unified] Failed to parse JSON: ${String(err)} content=${content.slice(0, 200)}`);
    return { pairs: [], singletons: images.map((img) => img.url), rawText: content };
  }

  const pairsRaw: UnifiedLLMPair[] = Array.isArray(parsed.pairs) ? parsed.pairs : [];
  log(`[pairing-v2] [LLM-unified] Model returned ${pairsRaw.length} pairs`);

  const byBasename = new Map<string, FeatureRow>();
  for (const img of images) {
    const filename = img.url || "";
    const basename = filename.split("/").pop() || filename;
    if (!byBasename.has(basename)) {
      byBasename.set(basename, img);
    }
  }

  const used = new Set<string>();
  const pairs: Pair[] = [];

  for (const p of pairsRaw) {
    if (!p || !p.front || !p.back) continue;

    const frontBase = p.front.split("/").pop() || p.front;
    const backBase = p.back.split("/").pop() || p.back;

    const frontRow = byBasename.get(frontBase);
    const backRow = byBasename.get(backBase);

    if (!frontRow || !backRow) {
      log(
        `[pairing-v2] [LLM-unified] Skipping pair front=${p.front} back=${p.back} (no matching feature rows)`
      );
      continue;
    }

    const frontKey = frontRow.url;
    const backKey = backRow.url;

    if (!frontKey || !backKey) {
      continue;
    }
    if (used.has(frontKey) || used.has(backKey)) {
      log(
        `[pairing-v2] [LLM-unified] Skipping pair front=${frontBase} back=${backBase} (already used)`
      );
      continue;
    }

    used.add(frontKey);
    used.add(backKey);

    pairs.push({
      frontUrl: frontKey,
      backUrl: backKey,
      matchScore: 1.0,
      brand: frontRow.brandNorm || "",
      product: frontRow.productTokens.join(" ") || "",
      variant: frontRow.variantTokens.join(" ") || null,
      sizeFront: frontRow.sizeCanonical || null,
      sizeBack: backRow.sizeCanonical || null,
      evidence: ["PAIRING-V2-LLM-GLOBAL"],
      confidence: 0.95,
    });
  }

  const singletons: string[] = [];
  for (const img of images) {
    const key = img.url;
    if (!key) continue;
    if (!used.has(key)) {
      singletons.push(key);
    }
  }

  return { pairs, singletons, rawText: content };
}
