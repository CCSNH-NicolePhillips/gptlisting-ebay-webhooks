import {
  CanonicalIdentity,
  extractSize,
  extractPackCount,
  normalizeBrand,
  normalizeCondition,
  tokenize,
} from './identity-model.js';

export interface CompCandidate {
  id: string;
  title: string;
  condition: string;
  priceCents: number;
  shippingCents: number;
  deliveredCents: number;
  url?: string;
}

export type MatchVerdict = 'match' | 'reject' | 'ambiguous';

export interface MatchResult {
  candidate: CompCandidate;
  verdict: MatchVerdict;
  reasons: string[];
  inferredPackCount: number | null;
  inferredSize: { value: number; unit: string } | null;
  score: number;
}

export const BUNDLE_INDICATORS = [
  'bundle', 'lot', 'lot of', 'set of', 'kit', 'wholesale',
  'bulk', 'multipack', 'multi-pack', 'multi pack', 'variety',
  'variety pack', 'assorted', 'assortment', 'combo', 'collection',
];

interface MatchOptions {
  sizeTolerance?: number;
  minTokenOverlap?: number;
}

function areUnitsCompatible(a: string, b: string): boolean {
  if (a === b) return true;
  const set = new Set([a, b]);
  if (set.has('oz') && set.has('fl oz')) return true;
  return false;
}

export function matchComps(
  identity: CanonicalIdentity,
  candidates: CompCandidate[],
  options?: MatchOptions,
): MatchResult[] {
  const sizeTolerance = options?.sizeTolerance ?? 0.03;
  const minTokenOverlap = options?.minTokenOverlap ?? 2;

  return candidates.map(candidate => {
    const reasons: string[] = [];
    let score = 100;
    let hasUnknowns = false;

    const candidateTitle = candidate.title;
    const candidateTokens = tokenize(candidateTitle);
    const candidateCondition = normalizeCondition(candidate.condition);
    const candidatePack = extractPackCount(candidateTitle);
    const candidateSize = extractSize(candidateTitle);

    // Rule 1 — Condition mismatch
    const conditionGroup = (c: string) => {
      if (c === 'new') return 'new';
      return 'other';
    };
    if (conditionGroup(identity.condition) !== conditionGroup(candidateCondition)) {
      reasons.push(`condition mismatch: ${identity.condition} vs ${candidateCondition}`);
      score -= 100;
    }

    // Rule 2 — Pack count
    if (candidatePack !== identity.packCount) {
      reasons.push(`packCount mismatch: ${identity.packCount} vs ${candidatePack}`);
      score -= 100;
    }

    // Rule 3 — Size mismatch
    if (identity.size && candidateSize) {
      if (areUnitsCompatible(identity.size.unit, candidateSize.unit)) {
        const diff = Math.abs(identity.size.value - candidateSize.value);
        const ratio = diff / identity.size.value;
        if (ratio > sizeTolerance) {
          reasons.push(`size mismatch: ${identity.size.value}${identity.size.unit} vs ${candidateSize.value}${candidateSize.unit}`);
          score -= 100;
        } else {
          reasons.push('size match');
        }
      } else {
        // Different incompatible units
        reasons.push(`size mismatch: ${identity.size.value}${identity.size.unit} vs ${candidateSize.value}${candidateSize.unit}`);
        score -= 100;
      }
    } else if (!identity.size && !candidateSize) {
      // Both have no size — fine
    } else {
      // One side missing
      reasons.push('size unknown on one side');
      hasUnknowns = true;
      score -= 10;
    }

    // Rule 4 — Brand match
    const brandTokens = normalizeBrand(identity.brand).split(/\s+/).filter(t => t.length > 0);
    const brandFound = brandTokens.some(bt => candidateTokens.includes(bt));
    if (!brandFound) {
      reasons.push('brand not found in title');
      score -= 100;
    } else {
      reasons.push('brand match');
    }

    // Rule 5 — Product token overlap
    const overlap = identity.keywords.filter(k => candidateTokens.includes(k)).length;
    if (overlap < minTokenOverlap) {
      reasons.push(`insufficient token overlap: ${overlap}/${identity.keywords.length}`);
      score -= 80;
    } else {
      reasons.push(`token overlap: ${overlap}/${identity.keywords.length}`);
    }

    // Rule 6 — Bundle indicators
    if (identity.packCount === 1) {
      const lowerTitle = candidateTitle.toLowerCase();
      for (const indicator of BUNDLE_INDICATORS) {
        if (lowerTitle.includes(indicator)) {
          reasons.push(`bundle indicator: ${indicator}`);
          score -= 100;
          break;
        }
      }
    }

    // Final verdict
    let verdict: MatchVerdict;
    if (score <= 0) {
      verdict = 'reject';
    } else if (score >= 80 && !hasUnknowns) {
      verdict = 'match';
    } else {
      verdict = 'ambiguous';
    }

    return {
      candidate,
      verdict,
      reasons,
      inferredPackCount: candidatePack,
      inferredSize: candidateSize,
      score,
    };
  });
}

export function filterMatches(results: MatchResult[]): MatchResult[] {
  return results.filter(r => r.verdict === 'match');
}

export function filterMatchesAndAmbiguous(results: MatchResult[]): MatchResult[] {
  return results.filter(r => r.verdict !== 'reject');
}
