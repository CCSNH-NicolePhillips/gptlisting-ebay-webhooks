// HP1: Global Pairing Solver for Two-shot Sets
// Implements one-to-one matching between fronts and backs using a score matrix

import type { FeatureRow } from './featurePrep.js';

export type GlobalPair = {
  f: FeatureRow;
  b: FeatureRow;
  score: number;
};

/**
 * Build a dense score matrix from existing candidates
 * Uses preScore + brand bonus (3 pts) + filename stem bonus (2 pts)
 */
export function buildScoreMatrix(
  fronts: FeatureRow[],
  backs: FeatureRow[]
): GlobalPair[] {
  const pairs: GlobalPair[] = [];

  const stem = (id: string) => id.slice(0, 13);
  const norm = (x: string | null | undefined) => (x || '').toLowerCase();

  for (const f of fronts) {
    const fBrand = norm(f.brandNorm || (f as any).brand);
    const fStem = stem((f as any).imageKey || f.url);

    for (const b of backs) {
      const bBrand = norm(b.brandNorm || (b as any).brand);
      const bStem = stem((b as any).imageKey || b.url);

      const pre = (f as any).candidates?.[(b as any).imageKey || b.url]?.preScore ?? 0;
      const brandBonus = fBrand && bBrand && fBrand === bBrand ? 3 : 0;
      const stemBonus = fStem === bStem ? 2 : 0;

      const score = pre + brandBonus + stemBonus;

      pairs.push({ f, b, score });
    }
  }

  return pairs;
}

/**
 * Greedy global matching (one-to-one) for two-shot case
 * Picks highest-scoring pairs ensuring each front/back used only once
 */
export function solveTwoShot(
  fronts: FeatureRow[],
  backs: FeatureRow[]
): GlobalPair[] {
  const pairs = buildScoreMatrix(fronts, backs);

  pairs.sort((a, b) => b.score - a.score);

  const usedF = new Set<string>();
  const usedB = new Set<string>();
  const result: GlobalPair[] = [];

  for (const p of pairs) {
    if (p.score <= 0) continue;

    const fKey = (p.f as any).imageKey || p.f.url;
    const bKey = (p.b as any).imageKey || p.b.url;

    if (usedF.has(fKey) || usedB.has(bKey)) continue;

    usedF.add(fKey);
    usedB.add(bKey);
    result.push(p);
  }

  return result;
}
