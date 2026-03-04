import {
  CanonicalIdentity,
  ExtractedIdentity,
  extractSize,
  extractPackCount,
  normalizeBrand,
  normalizeCondition,
  tokenize,
  extractIdentity,
} from './identity-model.js';

// ─── Strict variant-identity filtering ───────────────────────────────────────

export type RejectionReason =
  | 'COUNT_MISMATCH'
  | 'PACK_MISMATCH'
  | 'SIZE_MISMATCH'
  | 'STRENGTH_MISMATCH'
  | 'CFU_MISMATCH'
  | 'MODEL_MISMATCH';

export interface IdentityFilterResult {
  pass: boolean;
  rejectionReasons: RejectionReason[];
}

/** Percentage tolerance for continuous numeric comparisons (5 %). */
const CONTINUOUS_TOLERANCE = 0.05;
/** Tolerance for CFU comparisons (10 %). */
const CFU_TOLERANCE = 0.10;

function withinTolerance(a: number, b: number, tol: number): boolean {
  if (a === 0 && b === 0) return true;
  const ref = Math.max(Math.abs(a), Math.abs(b));
  return Math.abs(a - b) / ref <= tol;
}

/**
 * Strict identity match: given a query's ExtractedIdentity and a comp title,
 * reject the comp if any present field on the query side has a DIFFERENT (non-null)
 * value on the comp side.
 *
 * Null on EITHER side → "not mentioned" → benefit of doubt → do NOT reject.
 * Same-unit required for size/strength (no unit conversions in v1).
 */
export function strictMatchIdentity(
  query: ExtractedIdentity,
  compTitle: string,
): IdentityFilterResult {
  const comp = extractIdentity(compTitle);
  const rejectionReasons: RejectionReason[] = [];

  // ── Count (supplement units: 90ct vs 30ct) ──
  if (query.count !== null && comp.count !== null && query.count !== comp.count) {
    rejectionReasons.push('COUNT_MISMATCH');
  }

  // ── Pack multiplier (2-pack vs single) ──
  if (query.packMultiplier !== null && comp.packMultiplier !== null
    && query.packMultiplier !== comp.packMultiplier) {
    rejectionReasons.push('PACK_MISMATCH');
  }

  // ── Size (oz/ml/g — same unit required) ──
  if (query.size !== null && comp.size !== null) {
    if (query.size.unit !== comp.size.unit) {
      // Treat 'oz' and 'oz' from 'fl oz' as same (already normalised by extractVolumeSize)
      rejectionReasons.push('SIZE_MISMATCH');
    } else if (!withinTolerance(query.size.value, comp.size.value, CONTINUOUS_TOLERANCE)) {
      rejectionReasons.push('SIZE_MISMATCH');
    }
  }

  // ── Strength (mg/mcg/iu/% — same unit required) ──
  if (query.strength !== null && comp.strength !== null) {
    if (query.strength.unit !== comp.strength.unit) {
      rejectionReasons.push('STRENGTH_MISMATCH');
    } else if (!withinTolerance(query.strength.value, comp.strength.value, CONTINUOUS_TOLERANCE)) {
      rejectionReasons.push('STRENGTH_MISMATCH');
    }
  }

  // ── CFU (probiotics) ──
  if (query.cfuBillions !== null && comp.cfuBillions !== null
    && !withinTolerance(query.cfuBillions, comp.cfuBillions, CFU_TOLERANCE)) {
    rejectionReasons.push('CFU_MISMATCH');
  }

  // ── Model number ──
  if (query.modelNumber !== null
    && !compTitle.toUpperCase().includes(query.modelNumber.toUpperCase())) {
    rejectionReasons.push('MODEL_MISMATCH');
  }

  return { pass: rejectionReasons.length === 0, rejectionReasons };
}

export type { ExtractedIdentity };

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
