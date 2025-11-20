// HP1: Global Pairing Solver for Two-shot Sets
// Implements one-to-one matching between fronts and backs using a score matrix

import type { FeatureRow } from './featurePrep.js';

export type GlobalPair = {
  front: FeatureRow;
  back: FeatureRow;
  score: number;
};

/**
 * Build a dense score matrix from existing candidates
 * Uses preScore + brand bonus + filename stem bonus
 */
export function buildScoreMatrix(
  fronts: FeatureRow[],
  backs: FeatureRow[],
): { pairs: GlobalPair[] } {
  const pairs: GlobalPair[] = [];

  for (const f of fronts) {
    for (const b of backs) {
      // Base score: existing preScore / similarity if we have it
      // Fallback to 0 if missing
      const preScore = (f as any).candidates?.[b.url]?.preScore ?? 0;

      // Brand bonus
      const fb = (f.brandNorm || '').toLowerCase();
      const bb = (b.brandNorm || '').toLowerCase();
      const brandBonus = fb && bb && fb === bb ? 2 : 0;

      // Filename stem bonus (timestamp prefix, e.g. 20251115_1433)
      const stem = (url: string) => {
        const parts = url.split('/');
        const filename = parts[parts.length - 1] || '';
        return filename.slice(0, 13); // First 13 chars of filename
      };
      const fs = stem(f.url);
      const bs = stem(b.url);
      const stemBonus = fs && bs && fs === bs ? 1 : 0;

      const score = preScore + brandBonus + stemBonus;

      pairs.push({ front: f, back: b, score });
    }
  }

  return { pairs };
}

/**
 * Greedy global matching (one-to-one) for two-shot case
 * Picks highest-scoring pairs ensuring each front/back used only once
 */
export function solveGlobalPairsTwoShot(
  fronts: FeatureRow[],
  backs: FeatureRow[],
): GlobalPair[] {
  const { pairs } = buildScoreMatrix(fronts, backs);

  // Sort all possible front-back pairs by score descending
  pairs.sort((a, b) => b.score - a.score);

  const usedFronts = new Set<string>();
  const usedBacks = new Set<string>();
  const result: GlobalPair[] = [];

  for (const p of pairs) {
    if (p.score <= 0) continue; // ignore totally useless matches

    const fKey = p.front.url;
    const bKey = p.back.url;

    if (usedFronts.has(fKey) || usedBacks.has(bKey)) continue;

    usedFronts.add(fKey);
    usedBacks.add(bKey);
    result.push(p);
  }

  return result;
}
