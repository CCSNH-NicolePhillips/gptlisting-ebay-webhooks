/* robust-stats.ts – pure-math helpers for pricing comp analysis */

// ── Types ────────────────────────────────────────────────────────────────────

export interface CompSample {
  itemCents: number;
  shipCents: number;
  deliveredCents: number; // itemCents + shipCents
}

export interface RobustStats {
  count: number;                  // after outlier removal
  rawCount: number;               // before outlier removal
  min: number;                    // cents, after outlier removal
  max: number;                    // cents, after outlier removal
  p20: number;
  p35: number;
  p50: number;                    // median
  p65: number;
  iqr: number;                    // Q3 - Q1 (from RAW sorted array)
  coefficientOfVariation: number; // std / mean, 0 if mean is 0
  outliersBelowCount: number;
  outliersAboveCount: number;
  freeShippingRate: number;       // 0-1, percent of comps with ship=0 from RAW samples
}

// ── Percentile ───────────────────────────────────────────────────────────────

/**
 * Compute a single percentile from a SORTED ascending array.
 * Uses ceiling interpolation: index = ceil(length * p) - 1, clamped to [0, length-1].
 * @param sorted – already sorted ascending numbers
 * @param p – 0-1 (e.g. 0.35 for P35)
 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(sorted.length * p) - 1;
  const clamped = Math.max(0, Math.min(idx, sorted.length - 1));
  return sorted[clamped];
}

// ── Compute Robust Stats ─────────────────────────────────────────────────────

export function computeRobustStats(samples: CompSample[]): RobustStats {
  const zero: RobustStats = {
    count: 0,
    rawCount: 0,
    min: 0,
    max: 0,
    p20: 0,
    p35: 0,
    p50: 0,
    p65: 0,
    iqr: 0,
    coefficientOfVariation: 0,
    outliersBelowCount: 0,
    outliersAboveCount: 0,
    freeShippingRate: 0,
  };

  if (samples.length === 0) return zero;

  // Step 1: raw metrics
  const rawCount = samples.length;
  const freeShipCount = samples.filter((s) => s.shipCents === 0).length;
  const freeShippingRate = freeShipCount / rawCount;

  // Step 2: extract deliveredCents, sort ascending
  const rawSorted = samples.map((s) => s.deliveredCents).sort((a, b) => a - b);

  // Step 3: Q1 (P25) and Q3 (P75) on raw sorted
  const q1 = percentile(rawSorted, 0.25);
  const q3 = percentile(rawSorted, 0.75);

  // Step 4: IQR (kept from raw for the result)
  const iqr = q3 - q1;

  // Step 5: Remove IQR outliers
  const lowerFence = q1 - 1.5 * iqr;
  const upperFence = q3 + 1.5 * iqr;
  const afterIqr = rawSorted.filter((v) => v >= lowerFence && v <= upperFence);

  // Step 6: Compute P35 on IQR-cleaned array (for too-good-to-be-true threshold)
  const p35Ref = percentile(afterIqr, 0.35);

  // Step 7: Drop "too-good-to-be-true" (< 0.70 * P35)
  const tgtbThreshold = 0.70 * p35Ref;
  const cleaned = afterIqr.filter((v) => v >= tgtbThreshold);

  // Step 8: Outlier counts
  const outliersBelowCount = rawCount - cleaned.length - rawSorted.filter((v) => v > upperFence).length;
  const outliersAboveCount = rawCount - cleaned.length - rawSorted.filter((v) => v < lowerFence || (v >= lowerFence && v <= upperFence && v < tgtbThreshold)).length;

  // Recompute accurately: below = raw values removed that were below, above = raw values removed above
  const belowCount = rawSorted.filter((v) => v < lowerFence || (v >= lowerFence && v <= upperFence && v < tgtbThreshold)).length;
  const aboveCount = rawSorted.filter((v) => v > upperFence).length;

  // Step 9: Percentiles, min, max on cleaned
  const count = cleaned.length;

  if (count === 0) {
    return { ...zero, rawCount, freeShippingRate, iqr };
  }

  const min = cleaned[0];
  const max = cleaned[count - 1];
  const p20 = percentile(cleaned, 0.20);
  const p35 = percentile(cleaned, 0.35);
  const p50 = percentile(cleaned, 0.50);
  const p65 = percentile(cleaned, 0.65);

  // Step 10: coefficientOfVariation = population stddev / mean
  let cv = 0;
  if (count > 1) {
    const mean = cleaned.reduce((a, b) => a + b, 0) / count;
    if (mean !== 0) {
      const variance = cleaned.reduce((sum, v) => sum + (v - mean) ** 2, 0) / count;
      cv = Math.sqrt(variance) / mean;
    }
  }

  // Step 11: IQR in result is from the ORIGINAL raw sorted array
  return {
    count,
    rawCount,
    min,
    max,
    p20,
    p35,
    p50,
    p65,
    iqr,
    coefficientOfVariation: cv,
    outliersBelowCount: belowCount,
    outliersAboveCount: aboveCount,
    freeShippingRate,
  };
}

// ── Convenience predicates ───────────────────────────────────────────────────

export function isFloorOutlier(stats: RobustStats, threshold = 0.80): boolean {
  return stats.count >= 3 && stats.min < threshold * stats.p20;
}

export function isSoldStrong(stats: RobustStats, minCount = 10): boolean {
  return stats.count >= minCount;
}

export function isActiveStrong(stats: RobustStats, minCount = 12): boolean {
  return stats.count >= minCount;
}

export function sellThrough(soldCount: number, activeCount: number): number | null {
  if (soldCount === 0 && activeCount === 0) return null;
  return soldCount / (soldCount + activeCount);
}
