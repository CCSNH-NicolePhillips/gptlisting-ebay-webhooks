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
      engineVersion: "v2-phase1",
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
    log(`[pairing-v2] Too many images for v2 sandbox (images=${allImages.length}, max=${maxImages})`);
    // For now, just bail with empty result.
    const emptyResult: PairingResult = { 
      engineVersion: "v2-phase1",
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

  // Phase 1: delegate to a unified LLM global pairing helper (implemented below)
  const started = Date.now();
  const { pairs, singletons, rawText } = await unifiedGlobalLLMPairing({
    images: allImages,
    client,
    model,
    log,
  });
  const durationMs = Date.now() - started;

  const result: PairingResult = {
    engineVersion: "v2-phase1",
    pairs,
    products: [], // v2 doesn't build products yet
    singletons: singletons.map((url) => ({ url, reason: "not paired by v2 unified LLM" })),
    debugSummary: [`V2 unified LLM pairing: ${pairs.length} pairs, ${singletons.length} singletons`],
  };

  const metrics: PairingMetrics = {
    totals: {
      images: allImages.length,
      fronts: 0, // v2 doesn't care about role yet
      backs: 0,
      candidates: 0,
      autoPairs: 0,
      modelPairs: pairs.length,
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
    `[pairing-v2] pairs=${pairs.length} singletons=${singletons.length} durationMs=${durationMs}`
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
