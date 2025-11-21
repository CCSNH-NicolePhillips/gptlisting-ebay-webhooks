// src/pairing/pairing-v2.ts
// Phase 1: Delegate to existing direct-llm mode in runPairing
// Simple wrapper that reuses the working direct LLM pairing

import type OpenAI from "openai";
import type { FeatureRow } from "./featurePrep.js";
import type { PairingResult } from "./schema.js";
import type { PairingMetrics } from "./metrics.js";
import { runPairing } from "./runPairing.js";

type Analysis = {
  groups: any[];
  imageInsights: any[];
};

export interface PairingV2Config {
  maxImages?: number;
  model?: string;
}

export interface PairingV2Input {
  features: Map<string, FeatureRow>;
  client: OpenAI;
  model?: string;
  log?: (line: string) => void;
  config?: PairingV2Config;
}

export interface PairingV2Output {
  result: PairingResult;
  metrics: PairingMetrics;
  rawText: string;
}

/**
 * Pairing v2 entrypoint - Phase 1: Simple delegation to direct-llm mode
 * 
 * Converts features Map to Analysis format and calls runPairing with mode='direct-llm'
 */
export async function runPairingV2(input: PairingV2Input): Promise<PairingV2Output> {
  const { features, client, model, log = console.log, config } = input;
  const maxImages = config?.maxImages ?? 100;

  const allImages = Array.from(features.values());

  if (allImages.length === 0) {
    const emptyResult: PairingResult = { 
      engineVersion: "v2-phase1-direct",
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
      `[pairing-v2] Too many images for v2 (images=${allImages.length}, max=${maxImages})`
    );
    const emptyResult: PairingResult = { 
      engineVersion: "v2-phase1-direct",
      pairs: [], 
      products: [],
      singletons: allImages.map(img => ({ url: img.url, reason: "too many images" })),
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

  // Phase 1: Convert features to Analysis format and delegate to runPairing
  log(`[pairing-v2] Phase 1: Delegating ${allImages.length} images to direct-llm mode`);

  // Build Analysis object from features
  // The direct-llm mode in runPairing needs { groups, imageInsights }
  // We don't have groups, so pass empty array. ImageInsights can be derived from features.
  const analysis: Analysis = {
    groups: [],
    imageInsights: allImages.map((feature) => ({
      url: feature.url,
      displayUrl: feature.url,
      brand: feature.brandNorm || "",
      brandNorm: feature.brandNorm || "",
      product: feature.productTokens.join(" "),
      productTokens: feature.productTokens,
      variant: feature.variantTokens.join(" "),
      variantTokens: feature.variantTokens,
      size: feature.sizeCanonical || "",
      sizeCanonical: feature.sizeCanonical || "",
      packaging: feature.packagingHint || "",
      color: feature.colorKey || "",
      textExtracted: feature.textExtracted || "",
      role: "unknown", // direct-llm ignores roles anyway
      roleConfidence: 0,
    })),
  };

  const started = Date.now();
  const { result, metrics, rawText } = await runPairing({
    client,
    model: model || config?.model || "gpt-4o-mini",
    analysis,
    log,
    mode: "direct-llm",
  });
  const durationMs = Date.now() - started;

  log(
    `[pairing-v2] Phase 1 complete: pairs=${result.pairs.length} singletons=${result.singletons.length} durationMs=${durationMs}`
  );

  // Update metrics with actual duration
  const updatedMetrics: PairingMetrics = {
    ...metrics,
    durationMs,
  };

  return { result, metrics: updatedMetrics, rawText };
}
