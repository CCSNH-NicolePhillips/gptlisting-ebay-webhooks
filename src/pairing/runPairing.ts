// Copilot: Implement runPairing that:
//  - Accepts { client, model, analysis } where analysis = { groups, imageInsights } from Prompt 1
//  - Builds messages using getPairingSystemPrompt + getPairingUserPrompt
//  - Appends analysis JSON at the end of the user message
//  - Calls the model (temperature 0)
//  - Parses with parsePairingResult
//  - Returns { result, rawText } and logs compact debug lines for each pair/singleton
// 1) import buildFeatures and buildCandidates
// 2) compute features and candidates from analysis
// 3) build a "hints" payload:
//    {
//      featuresByUrl: Record<url, FeatureRow>,
//      candidatesByFront: Record<frontUrl, string[]> // allowedBacks
//    }
// 4) Append "\nHINTS:\n" + JSON.stringify(hints) after the INPUT JSON in the user message.
// 5) Before calling GPT, print candidate tables to console:
//
//  CANDIDATES front=<url>
//   - <backUrl> score=<preScore> brand=<equal?> prodJac=<v> sizeEq=<t/f> pkg=<..> catTailOverlap=<t/f>
//
// (Include your quick pre-score from candidates.ts so I can sanity-check pruning.)
//
// Keep everything else from Phase 1 intact.

import OpenAI from "openai";
import { getPairingSystemPrompt, getPairingUserPrompt } from "../prompt/pairing-prompt.js";
import { parsePairingResult, PairingResult, Pair } from "./schema.js";
import { buildFeatures, FeatureRow } from "./featurePrep.js";
import { buildCandidates, getCandidateScoresForFront, shouldAutoPairHairCosmetic } from "./candidates.js";
import { cfg, getThresholdsSnapshot, ENGINE_VERSION } from "./config.js";
import { buildMetrics, formatMetricsLog, PairingMetrics } from "./metrics.js";
import { groupExtrasWithProducts } from "./groupExtras.js";
import { enrichListingWithAI } from "../services/listing-enrichment.js";
import { resolveSingletons } from "./resolveSingletons.js";
import { solveTwoShot } from "./globalSolver.js";

type Analysis = {
  groups: any[];
  imageInsights: any[];
};

const canon = (u: string) => u.trim().toLowerCase();

export async function runPairing(opts: {
  client: OpenAI;
  model?: string; // default gpt-4o-mini (or from cfg)
  analysis: Analysis;
  log?: (line: string) => void;
}): Promise<{ result: PairingResult; rawText: string; metrics: PairingMetrics }> {
  const { client, analysis, log = console.log, model = cfg.model } = opts;
  const startTime = Date.now();

  // Build features and candidates
  const features = buildFeatures(analysis);
  
  // Collect front and back features for analysis
  const frontFeatures = Array.from(features.values()).filter(f => f.role === 'front');
  const backFeatures = Array.from(features.values()).filter(f => f.role === 'back');
  
  // HP1.1: Detect "two-shot" dataset (equal fronts and backs, no extras)
  const isTwoShotCandidate =
    frontFeatures.length === backFeatures.length &&
    frontFeatures.length > 0 &&
    features.size === frontFeatures.length + backFeatures.length;
  
  console.log('[globalSolver] twoShot?', {
    fronts: frontFeatures.length,
    backs: backFeatures.length,
    images: features.size,
    isTwoShotCandidate,
  });
  
  // Phase 5b.3: Promote "other" to "back" for lone front groups
  // Group features by their group ID to analyze role distribution
  const groupFeatures = new Map<string, FeatureRow[]>();
  for (const feat of features.values()) {
    // Find the group this feature belongs to
    const group = analysis.groups.find(g => 
      g.images?.includes(feat.url) || 
      g.primaryImageUrl === feat.url ||
      g.id?.includes(feat.url)
    );
    if (group) {
      const gid = group.id || group.base || 'unknown';
      if (!groupFeatures.has(gid)) {
        groupFeatures.set(gid, []);
      }
      groupFeatures.get(gid)!.push(feat);
    }
  }
  
  // Check each group for "1 front + 0 backs + 1 other" pattern
  for (const [groupId, groupFeats] of groupFeatures.entries()) {
    const fronts = groupFeats.filter(f => f.role === 'front');
    const backs = groupFeats.filter(f => f.role === 'back');
    const others = groupFeats.filter(f => f.role === 'other');
    
    if (fronts.length === 1 && backs.length === 0 && others.length === 1) {
      log(`[pairing] Promoting other->back for lone front group: groupId=${groupId} front=${fronts[0].url} other=${others[0].url}`);
      // Mutate the feature to change role from 'other' to 'back'
      others[0].role = 'back';
    }
  }
  
  const buildStart = Date.now();
  const candidatesMap = buildCandidates(features, 4);
  const buildDurationMs = Date.now() - buildStart;
  
  // Safety: warn if candidate building took too long
  if (buildDurationMs > cfg.maxCandidateBuildMs) {
    log(`WARN: Candidate building took ${buildDurationMs}ms (threshold: ${cfg.maxCandidateBuildMs}ms)`);
  }
  
  // Safety: detect backs that appear under too many fronts
  const backFrontCounts = new Map<string, string[]>();
  for (const [frontUrl, candidates] of Object.entries(candidatesMap)) {
    for (const cand of candidates) {
      const fronts = backFrontCounts.get(cand.backUrl) || [];
      fronts.push(frontUrl);
      backFrontCounts.set(cand.backUrl, fronts);
    }
  }
  for (const [backUrl, fronts] of backFrontCounts.entries()) {
    if (fronts.length >= cfg.maxBackFrontRatio) {
      log(`WARN back=${backUrl} appears under ${fronts.length} fronts; consider lowering thresholds or enabling filename proximity`);
    }
  }
  
  // Auto-pair fallback: identify slam-dunk candidates before calling GPT
  const autoPairs: Pair[] = [];
  const usedBacks = new Set<string>();
  const autoPairedFronts = new Set<string>(); // Track fronts that were auto-paired
  const frontsForGPT = new Set<string>();
  
  // General auto-pair (supplements/food with strong signals)
  for (const [frontUrl, candidates] of Object.entries(candidatesMap)) {
    // Use already-computed scores from candidatesMap (no re-scoring!)
    const scores = candidates.filter(s => s.preScore >= cfg.minPreScore);
    
    if (scores.length > 0) {
      const best = scores[0];
      const runnerUp = scores[1];
      const gap = best.preScore - (runnerUp?.preScore ?? -Infinity);
      
      // Auto-pair if: preScore >= cfg threshold AND gap >= cfg threshold
      if (best.preScore >= cfg.autoPair.score && gap >= cfg.autoPair.gap && !usedBacks.has(best.backUrl)) {
        const group = analysis.groups.find(g => g.images?.includes(frontUrl) || g.primaryImageUrl === frontUrl);
        autoPairs.push({
          frontUrl: canon(frontUrl),
          backUrl: canon(best.backUrl),
          matchScore: Math.round(best.preScore * 10) / 10,
          brand: group?.brand || 'unknown',
          product: group?.product || '',
          variant: group?.variant || '',
          sizeFront: group?.size || '',
          sizeBack: group?.size || '',
          evidence: [
            `AUTO-PAIRED: preScore=${best.preScore.toFixed(2)}`,
            `gap=${gap.toFixed(2)}`,
            `brand=${best.brandFlag}`,
            `packaging=${best.packaging} boost=${best.packagingBoost}`,
            `prodJac=${best.prodJac.toFixed(2)} varJac=${best.varJac.toFixed(2)}`,
            `sizeEq=${best.sizeEq} catTailOverlap=${best.catTailOverlap}`,
            `cosmeticBackCue=${best.cosmeticBackCue}`
          ],
          confidence: 0.95
        });
        usedBacks.add(best.backUrl);
        autoPairedFronts.add(frontUrl); // Mark this front as auto-paired
        log(`AUTOPAIR front=${frontUrl} back=${best.backUrl} preScore=${best.preScore.toFixed(1)} Δ=${gap.toFixed(1)} brand=${best.brandFlag} pkg=${best.packaging} sizeEq=${best.sizeEq} prodJac=${best.prodJac.toFixed(2)} varJac=${best.varJac.toFixed(2)}`);
      } else {
        frontsForGPT.add(frontUrl);
      }
    }
  }
  
  // Domain-specific fallback for hair/cosmetics (lower threshold, INCI-based)
  for (const [frontUrl, candidates] of Object.entries(candidatesMap)) {
    if (autoPairedFronts.has(frontUrl)) continue; // Skip already auto-paired
    
    // Use already-computed scores from candidatesMap (no re-scoring!)
    const scores = candidates.filter(s => s.preScore >= 1.5);
    if (scores.length === 0) continue;
    
    const [top, second] = [scores[0], scores[1]];
    const frontFeat = features.get(frontUrl);
    const isHairCosmetic = /hair|cosmetic|skin|styling|beauty/i.test(frontFeat?.categoryPath || '');
    
    if (isHairCosmetic && shouldAutoPairHairCosmetic(top, second) && !usedBacks.has(top.backUrl)) {
      const group = analysis.groups.find(g => g.images?.includes(frontUrl) || g.primaryImageUrl === frontUrl);
      autoPairs.push({
        frontUrl: canon(frontUrl),
        backUrl: canon(top.backUrl),
        matchScore: Math.round(top.preScore * 10) / 10,
        brand: group?.brand || 'unknown',
        product: group?.product || '',
        variant: group?.variant || '',
        sizeFront: group?.size || '',
        sizeBack: group?.size || '',
        evidence: [
          `AUTO-PAIRED[hair]: preScore=${top.preScore.toFixed(2)}`,
          `gap=${(top.preScore - (second?.preScore ?? -Infinity)).toFixed(2)}`,
          `brand=${top.brandFlag}`,
          `packaging=${top.packaging} boost=${top.packagingBoost}`,
          `INCI=${top.cosmeticBackCue}`,
          `prodJac=${top.prodJac.toFixed(2)} varJac=${top.varJac.toFixed(2)}`,
          `sizeEq=${top.sizeEq}`
        ],
        confidence: 0.90
      });
      usedBacks.add(top.backUrl);
      autoPairedFronts.add(frontUrl); // Mark this front as auto-paired
      frontsForGPT.delete(frontUrl);
      log(`AUTOPAIR[hair] front=${frontUrl} back=${top.backUrl} preScore=${top.preScore.toFixed(2)} Δ=${(top.preScore - (second?.preScore ?? -Infinity)).toFixed(2)} pkg=${top.packaging} INCI=${top.cosmeticBackCue} brand=${top.brandFlag} sizeEq=${top.sizeEq}`);
    }
  }
  
  // Print candidate tables with enhanced details (only for fronts going to GPT)
  for (const [frontUrl, candidates] of Object.entries(candidatesMap)) {
    if (autoPairedFronts.has(frontUrl)) continue; // Skip auto-paired fronts
    log(`CANDIDATES front=${frontUrl}`);
    for (const cand of candidates) {
      const details: string[] = [];
      details.push(`preScore=${cand.score.toFixed(1)}`);
      details.push(`brand=${cand.brandMatch ? 'equal' : 'mismatch'}`);
      details.push(`prodJac=${cand.prodJaccard.toFixed(2)}`);
      details.push(`sizeEq=${cand.sizeEq}`);
      details.push(`pkg=${cand.pkgMatch ? 'match' : 'nomatch'}`);
      details.push(`catTailOverlap=${cand.catTailOverlap}`);
      log(`  - back=${cand.backUrl} ${details.join(' ')}`);
    }
  }
  
  // Build hints payload with canonical URLs (exclude auto-paired fronts, filter used backs)
  const featuresByUrl: Record<string, FeatureRow> = {};
  for (const [url, feat] of features.entries()) {
    featuresByUrl[canon(url)] = feat;
  }
  
  const candidatesByFront: Record<string, string[]> = {};
  for (const [frontUrl, candidates] of Object.entries(candidatesMap)) {
    // Skip auto-paired fronts
    if (autoPairedFronts.has(frontUrl)) continue;
    
    // Filter out already-used backs
    const availableBacks = candidates
      .map(c => canon(c.backUrl))
      .filter(b => !usedBacks.has(b));
    
    if (availableBacks.length > 0) {
      candidatesByFront[canon(frontUrl)] = availableBacks;
    }
  }
  
  // If all fronts were auto-paired, skip GPT call
  if (Object.keys(candidatesByFront).length === 0) {
    // Group extras before returning
    const products = groupExtrasWithProducts(autoPairs, features);
    
    const durationMs = Date.now() - startTime;
    const metrics = buildMetrics({
      features,
      candidatesMap,
      autoPairs,
      modelPairs: [],
      globalPairs: [],
      singletons: [],
      thresholds: getThresholdsSnapshot(),
      durationMs
    });
    log(formatMetricsLog(metrics));
    log(`SUMMARY frontsWithCandidates=${Object.keys(candidatesMap).length}/${Array.from(features.values()).filter(f => f.role === 'front').length} autoPairs=${autoPairs.length} modelPairs=0 globalPairs=0 singletons=0`);
    return {
      result: {
        engineVersion: ENGINE_VERSION,
        pairs: autoPairs,
        products,
        singletons: [],
        debugSummary: []
      },
      rawText: '{}',
      metrics
    };
  }
  
  // Some fronts need GPT tie-breaking
  if (cfg.disableTiebreak) {
    log('WARN: GPT tie-breaking disabled (PAIR_DISABLE_TIEBREAK=1), treating remaining fronts as singletons');
    const remainingSingletons = Object.keys(candidatesByFront).map(frontUrl => ({
      url: frontUrl,
      reason: 'tiebreak_disabled'
    }));
    
    const products = groupExtrasWithProducts(autoPairs, features);
    const durationMs = Date.now() - startTime;
    const metrics = buildMetrics({
      features,
      candidatesMap,
      autoPairs,
      modelPairs: [],
      globalPairs: [],
      singletons: remainingSingletons,
      thresholds: getThresholdsSnapshot(),
      durationMs
    });
    log(formatMetricsLog(metrics));
    log(`SUMMARY frontsWithCandidates=${Object.keys(candidatesMap).length}/${Array.from(features.values()).filter(f => f.role === 'front').length} autoPairs=${autoPairs.length} modelPairs=0 globalPairs=0 singletons=${remainingSingletons.length}`);
    return {
      result: {
        engineVersion: ENGINE_VERSION,
        pairs: autoPairs,
        products,
        singletons: remainingSingletons,
        debugSummary: ['TieBreakDisabled due to PAIR_DISABLE_TIEBREAK=1']
      },
      rawText: '{}',
      metrics
    };
  }
  
  // Canonicalize URLs in analysis shallow copy, filtering to only fronts needing GPT
  const frontsNeedingGPT = new Set(Object.keys(candidatesByFront).map(canon));
  const canonAnalysis = {
    groups: analysis.groups
      .filter(g => {
        const primaryUrl = canon(g.primaryImageUrl || g.images?.[0] || '');
        return frontsNeedingGPT.has(primaryUrl);
      })
      .map(g => ({
        ...g,
        primaryImageUrl: canon(g.primaryImageUrl || g.images?.[0] || ''),
        images: (g.images || []).map(canon)
      })),
    imageInsights: analysis.imageInsights
      .filter(ins => {
        const insUrl = canon(ins.url);
        // Include if it's a front needing GPT OR a back that's a candidate
        if (frontsNeedingGPT.has(insUrl)) return true;
        // Check if this back appears in any candidate list
        for (const backs of Object.values(candidatesByFront)) {
          if (backs.map(canon).includes(insUrl)) return true;
        }
        return false;
      })
      .map(ins => ({
        ...ins,
        url: canon(ins.url)
      }))
  };
  
  const hints = { featuresByUrl, candidatesByFront };

  const system = getPairingSystemPrompt();
  const user = getPairingUserPrompt() + "\n\nINPUT:\n" + JSON.stringify(canonAnalysis) + "\n\nHINTS:\n" + JSON.stringify(hints);

  const res = await client.chat.completions.create({
    model,
    temperature: 0,
    messages: [
      { role: "system", content: system },
      { role: "user",   content: user }
    ]
  });

  const rawText = res.choices[0]?.message?.content || "{}";
  let parsed: PairingResult;
  try {
    parsed = parsePairingResult(JSON.parse(rawText));
  } catch (e) {
    // Try to recover if model wrapped code fences
    const cleaned = rawText.replace(/```json|```/g, "").trim();
    parsed = parsePairingResult(JSON.parse(cleaned));
  }
  
  // Enforce contract: validate pairs use allowed backs
  const allowed = new Map(Object.entries(candidatesByFront));
  const rejectedPairs: Pair[] = []; // Phase 5a.5: Track rejected low-score pairs
  
  for (const p of parsed.pairs) {
    const f = canon(p.frontUrl), b = canon(p.backUrl);
    const list = allowed.get(f);
    
    // Reject hallucinated fronts - GPT returned a pair for a front we didn't send
    if (!list) {
      throw new Error(`Model returned pair for front not in input: front=${p.frontUrl} (may have been auto-paired already)`);
    }
    
    // Validate back is in the candidate list for this front
    if (!list.map(canon).includes(b)) {
      throw new Error(`Model chose back not in candidates: front=${p.frontUrl} back=${p.backUrl}`);
    }
    
    // Phase 5a.5: Reject model pairs with score < 3.0 (likely wrong pairs)
    if (p.matchScore < 3.0) {
      log(`[model-pairing] REJECTED low-score pair: front=${p.frontUrl} back=${p.backUrl} score=${p.matchScore.toFixed(2)} (threshold=3.0)`);
      rejectedPairs.push(p);
      // Treat this front as a singleton instead
      parsed.singletons.push({
        url: p.frontUrl,
        reason: `declined despite candidates (model-pair rejected: score=${p.matchScore.toFixed(2)} < 3.0 threshold)`
      });
      continue; // Skip adding to usedBacks
    }
    
    // Check uniqueness (no back used twice)
    if (usedBacks.has(b)) {
      throw new Error(`Model reused back: back=${p.backUrl} already used in auto-pair`);
    }
    usedBacks.add(b);
  }
  
  // Filter out rejected pairs from parsed.pairs
  parsed.pairs = parsed.pairs.filter(p => !rejectedPairs.includes(p));
  
  // Enforce contract: check singleton reasons and missing decisions
  const frontsSeen = new Set(parsed.pairs.map(p => canon(p.frontUrl)));
  for (const s of parsed.singletons) {
    const f = canon(s.url);
    const list = allowed.get(f);
    if (list && list.length) {
      if (!/^declined despite candidates/i.test(s.reason)) {
        throw new Error(`Model claimed "no candidates" despite candidates: url=${s.url} reason=${s.reason}`);
      }
      frontsSeen.add(f);
    }
  }
  
  // Check for missing decisions
  for (const frontUrl of allowed.keys()) {
    if (!frontsSeen.has(frontUrl)) {
      throw new Error(`contract violation: missing decision for front ${frontUrl}`);
    }
  }

  // Merge auto-pairs + model pairs
  let allPairs = [...autoPairs, ...parsed.pairs];
  let singletons = parsed.singletons;
  
  // HP1.4: Apply global solver for two-shot datasets
  if (isTwoShotCandidate) {
    log('[globalSolver] running two-shot solver');
    
    const global = solveTwoShot(frontFeatures, backFeatures);
    
    log('[globalSolver] result pair count', global.length);
    
    // For the two-shot case, we treat these as the final authoritative pairs
    // and ignore autoPairs/modelPairs. We can still log their counts for debugging.
    allPairs = global.map((g, idx) => ({
      frontUrl: canon(g.f.url),
      backUrl: canon(g.b.url),
      matchScore: Math.round(g.score * 10) / 10,
      brand: g.f.brandNorm || g.b.brandNorm || 'unknown',
      product: '', // Will be enriched later
      variant: null,
      sizeFront: g.f.sizeCanonical || null,
      sizeBack: g.b.sizeCanonical || null,
      evidence: [
        `GLOBAL-PAIRED: score=${g.score.toFixed(2)}`,
        `brand=${g.f.brandNorm === g.b.brandNorm ? 'equal' : 'mismatch'}`,
      ],
      confidence: 0.98
    }));
    
    // In strict two-shot mode, we expect no singletons
    singletons = [];
    
    log('[globalSolver] metrics', {
      autoPairsOriginal: autoPairs.length,
      modelPairsOriginal: parsed.pairs.length,
      globalPairsFinal: allPairs.length,
      productsExpected: allPairs.length,
      singletonsExpected: 0
    });
  }
  
  // Group extras with products
  let products = groupExtrasWithProducts(allPairs, features);
  
  // ENRICH LISTINGS: Generate SEO-optimized titles and descriptions with ChatGPT
  log(`📝 Enriching ${products.length} products with AI-generated titles and descriptions...`);
  await Promise.all(products.map(async (product) => {
    try {
      // Get feature data for front/back images
      const frontFeature = features.get(product.frontUrl);
      const backFeature = features.get(product.backUrl);
      
      const enriched = await enrichListingWithAI({
        brand: product.evidence.brand,
        product: product.evidence.product,
        variant: product.evidence.variant || undefined,
        size: frontFeature?.sizeCanonical || backFeature?.sizeCanonical || undefined,
        category: frontFeature?.categoryTail || backFeature?.categoryTail || undefined,
        categoryPath: frontFeature?.categoryPath || backFeature?.categoryPath || undefined,
        claims: [], // TODO: Extract claims from features if available
        options: {} // TODO: Extract options from features if available
      });
      
      // Add enriched fields to product (extend the type)
      (product as any).title = enriched.title;
      (product as any).description = enriched.description;
      
      log(`  ✓ ${product.evidence.brand} ${product.evidence.product} - "${enriched.title.slice(0, 50)}..."`);
    } catch (error) {
      log(`  ⚠️ Failed to enrich ${product.evidence.brand} ${product.evidence.product}: ${error}`);
      // Fallback: use simple concatenation
      (product as any).title = [product.evidence.brand, product.evidence.product, product.evidence.variant]
        .filter(p => p)
        .join(' ')
        .slice(0, 80);
    }
  }));
  log(`✅ Listing enrichment complete`);
  
  // Hydrate display URLs for products
  const displayUrlByKey = new Map<string, string>();
  for (const insight of analysis.imageInsights || []) {
    const key = (insight as any).key || (insight as any)._key || (insight as any).urlKey || insight.url;
    const displayUrl = (insight as any).displayUrl;
    if (key && displayUrl) {
      displayUrlByKey.set(key.toLowerCase(), displayUrl);
    }
  }
  
  for (const p of products) {
    const frontKey = p.frontUrl?.toLowerCase() || '';
    const backKey = p.backUrl?.toLowerCase() || '';
    p.heroDisplayUrl = displayUrlByKey.get(frontKey) || p.frontUrl;
    p.backDisplayUrl = displayUrlByKey.get(backKey) || p.backUrl;
    
    // Convert extras URLs to display URLs
    if (p.extras && p.extras.length > 0) {
      p.extras = p.extras.map(extraUrl => {
        const extraKey = extraUrl?.toLowerCase() || '';
        return displayUrlByKey.get(extraKey) || extraUrl;
      });
    }
  }
  
  // Filter out singletons for images that were auto-paired
  const autoPairedUrls = new Set([
    ...autoPairs.map(p => canon(p.frontUrl)),
    ...autoPairs.map(p => canon(p.backUrl))
  ]);
  const filteredSingletons = singletons.filter(s => !autoPairedUrls.has(canon(s.url)));
  
  // HP1.5: Skip singleton resolution in strict two-shot mode
  let finalSingletons: Array<{ url: string; reason: string }>;
  
  if (isTwoShotCandidate) {
    log('[globalSolver] skipping extras/solos in two-shot mode');
    
    // Build products directly from global pairs - no extras, no solos
    products = allPairs.map((p, idx) => ({
      productId: `gs-${idx}`,
      frontUrl: p.frontUrl,
      backUrl: p.backUrl,
      heroDisplayUrl: '', // Will be hydrated below
      backDisplayUrl: '', // Will be hydrated below
      extras: [],
      evidence: {
        brand: p.brand,
        product: p.product || '',
        variant: p.variant,
        matchScore: p.matchScore,
        confidence: p.confidence,
        triggers: p.evidence || []
      }
    }));
    
    finalSingletons = [];
    
    log('[globalSolver] products built', {
      products: products.length,
      singletons: 0
    });
  } else {
    // Phase 5b.4: Resolve singletons - promote to solo products or attach as extras
    const singletonFeatures = filteredSingletons
      .map(s => features.get(canon(s.url)))
      .filter((f): f is FeatureRow => f !== undefined);
    
    const { products: resolvedProducts, remainingSingletons } = resolveSingletons(singletonFeatures, products);
    products = resolvedProducts;
    
    // Convert remaining singletons back to original singleton format
    finalSingletons = remainingSingletons.map(f => ({
      url: f.url,
      reason: 'no matching product or unique brand'
    }));
  }
  
  const mergedResult: PairingResult = {
    engineVersion: ENGINE_VERSION,
    pairs: allPairs,
    products,
    singletons: finalSingletons,
    debugSummary: parsed.debugSummary || []
  };

  // Debug logs
  for (const p of allPairs) {
    log(`PAIR  front=${p.frontUrl}  back=${p.backUrl}  score=${p.matchScore.toFixed(2)}  brand=${p.brand}  product=${p.product}`);
    if (p.evidence?.length) log(`EVID  ${p.evidence.join(" | ")}`);
  }
  for (const s of finalSingletons) {
    log(`SINGLETON url=${s.url} reason=${s.reason}`);
  }

  // Build metrics
  const durationMs = Date.now() - startTime;
  const metrics = buildMetrics({
    features,
    candidatesMap,
    autoPairs: isTwoShotCandidate ? [] : autoPairs,
    modelPairs: isTwoShotCandidate ? [] : parsed.pairs,
    globalPairs: isTwoShotCandidate ? allPairs : [],
    singletons: finalSingletons,
    thresholds: getThresholdsSnapshot(),
    durationMs
  });
  
  // Summary
  log(formatMetricsLog(metrics));
  log(`SUMMARY frontsWithCandidates=${Object.keys(candidatesMap).length}/${Array.from(features.values()).filter(f => f.role === 'front').length} autoPairs=${isTwoShotCandidate ? 0 : autoPairs.length} modelPairs=${isTwoShotCandidate ? 0 : parsed.pairs.length} globalPairs=${isTwoShotCandidate ? allPairs.length : 0} singletons=${finalSingletons.length} products=${products.length}`);

  return { result: mergedResult, rawText, metrics };
}
