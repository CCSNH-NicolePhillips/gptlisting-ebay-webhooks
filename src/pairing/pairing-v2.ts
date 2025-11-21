// src/pairing/pairing-v2.ts
// Phase 2: Wrapper pattern - delegate to direct-llm mode
// Main export is now a simple wrapper, experimental logic preserved separately

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
 * Pairing v2 entrypoint - Phase 2: Wrapper pattern
 * 
 * Delegates to direct-llm mode in runPairing.
 * Experimental v2 logic preserved in runPairingV2Experimental (unused).
 */
export async function runPairingV2(input: PairingV2Input): Promise<PairingV2Output> {
  return runPairingV2Direct(input);
}

/**
 * Phase 2: Direct delegation to runPairing with mode='direct-llm'
 */
async function runPairingV2Direct(input: PairingV2Input): Promise<PairingV2Output> {
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
    `[pairing-v2] Direct delegation complete: pairs=${result.pairs.length} singletons=${result.singletons.length} durationMs=${durationMs}`
  );

  // Update result to indicate v2 wrapper
  result.engineVersion = "v2-direct-wrapper";
  result.debugSummary = [
    "V2 wrapper delegating to direct-llm mode",
    ...(result.debugSummary || []),
  ];

  // Update metrics with actual duration
  const updatedMetrics: PairingMetrics = {
    ...metrics,
    durationMs,
  };

  return { result, metrics: updatedMetrics, rawText };
}

/**
 * Phase 2: Experimental v2 logic (preserved but unused)
 * 
 * This was the original Phase 1 implementation before we switched to wrapper pattern.
 * Kept for reference but not currently called.
 */
async function runPairingV2Experimental(input: PairingV2Input): Promise<PairingV2Output> {
  const { features, client, model, log = console.log, config } = input;
  const maxImages = config?.maxImages ?? 100;

  const allImages = Array.from(features.values());

  if (allImages.length === 0) {
    const emptyResult: PairingResult = { 
      engineVersion: "v2-experimental",
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
      `[pairing-v2] Too many images for v2 experimental (images=${allImages.length}, max=${maxImages})`
    );
    const emptyResult: PairingResult = { 
      engineVersion: "v2-experimental",
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

  // Original Phase 1 implementation preserved here
  log(`[pairing-v2] Experimental: Delegating ${allImages.length} images to direct-llm mode`);

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
      role: "unknown",
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
    `[pairing-v2] Experimental complete: pairs=${result.pairs.length} singletons=${result.singletons.length} durationMs=${durationMs}`
  );

  // Update metrics with actual duration
  const updatedMetrics: PairingMetrics = {
    ...metrics,
    durationMs,
  };

  return { result, metrics: updatedMetrics, rawText };
}
