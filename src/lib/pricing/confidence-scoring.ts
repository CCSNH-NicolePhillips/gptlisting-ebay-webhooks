/**
 * Pricing v2 Confidence Scoring
 * 
 * Computes a 0-100 confidence score for a pricing decision.
 * Defines hard and soft review triggers.
 * 
 * Based on: eBay Pricing System Plan v2, §Confidence scoring.
 */

import type { RobustStats } from './robust-stats.js';

// ============================================================================
// Types
// ============================================================================

export interface ConfidenceInputs {
  /** Was UPC/barcode used for identity? */
  upcMatch: boolean;

  /** How was the identity parsed? */
  identitySource: 'upc' | 'structured-attributes' | 'title-only';

  /** Robust stats from sold comps (null if no sold data). */
  soldStats: RobustStats | null;

  /** Robust stats from active comps (null if no active data). */
  activeStats: RobustStats | null;

  /** Sold P35 within 15% of Active P35? */
  crossSignalAgreement: boolean | null;  // null if either is missing

  /** Is there a trusted retail anchor within reasonable range? */
  hasRetailAnchor: boolean;

  /** Did LLM matching return 'low' overall confidence? */
  llmConfidenceLow: boolean;

  /** Was pack count / size ambiguous (couldn't resolve deterministically)? */
  packSizeAmbiguous: boolean;

  /** Safety floor forced uplift percent (0 if not binding). */
  safetyFloorUpliftPercent: number;

  /** Estimated shipping cost vs displayed shipping charge gap in cents. */
  shippingGapCents: number;

  /** Max allowed shipping subsidy in cents. */
  shippingSubsidyCapCents: number;
}

export interface ConfidenceResult {
  /** 0-100 confidence score. */
  score: number;

  /** Breakdown of score components for audit trail. */
  breakdown: {
    identityStrength: number;    // 0-35
    sampleStrength: number;      // 0-35
    dispersionPenalty: number;   // 0 to -15
    crossSignalBonus: number;    // -10 to +10
    retailSanity: number;        // 0 to +5
  };

  /** Hard triggers: if any are true, block auto-listing. */
  hardTriggers: string[];

  /** Soft triggers: allow listing but warn. */
  softTriggers: string[];

  /** Should this listing be blocked from auto-listing? */
  requiresManualReview: boolean;
}

// ============================================================================
// Score Computation
// ============================================================================

/**
 * Compute confidence score and review triggers.
 */
export function computeConfidence(inputs: ConfidenceInputs): ConfidenceResult {
  const hardTriggers: string[] = [];
  const softTriggers: string[] = [];

  // --- Identity strength (0-35) ---
  let identityStrength = 0;
  if (inputs.upcMatch) {
    identityStrength = 35;
  } else if (inputs.identitySource === 'structured-attributes') {
    identityStrength = 25;
  } else {
    identityStrength = 10;  // title-only
  }

  // --- Sample strength (0-35) ---
  let sampleStrength = 0;
  const soldCount = inputs.soldStats?.count ?? 0;
  const activeCount = inputs.activeStats?.count ?? 0;
  const soldStrong = soldCount >= 10;
  const activeStrong = activeCount >= 12;

  if (soldStrong) sampleStrength += 20;
  if (activeStrong) sampleStrength += 15;

  // --- Dispersion penalty (0 to -15) ---
  let dispersionPenalty = 0;
  // Use the worst dispersion from either sold or active
  const soldCV = inputs.soldStats?.coefficientOfVariation ?? 0;
  const activeCV = inputs.activeStats?.coefficientOfVariation ?? 0;
  const worstCV = Math.max(soldCV, activeCV);

  if (worstCV > 0.5) {
    dispersionPenalty = -15;
  } else if (worstCV > 0.35) {
    dispersionPenalty = -10;
  } else if (worstCV > 0.20) {
    dispersionPenalty = -5;
  }

  // --- Cross-signal agreement (-10 to +10) ---
  let crossSignalBonus = 0;
  if (inputs.crossSignalAgreement === true) {
    crossSignalBonus = 10;
  } else if (inputs.crossSignalAgreement === false) {
    crossSignalBonus = -10;
  }
  // null = can't compute, no bonus or penalty

  // --- Retail sanity (0 to +5) ---
  let retailSanity = 0;
  if (inputs.hasRetailAnchor) {
    retailSanity = 5;
  }

  // --- Total score ---
  const score = Math.max(0, Math.min(100,
    identityStrength + sampleStrength + dispersionPenalty + crossSignalBonus + retailSanity
  ));

  // ========================================================================
  // Hard triggers (block auto-listing)
  // ========================================================================
  if (inputs.llmConfidenceLow) {
    hardTriggers.push('llmConfidenceLow');
  }

  if (!soldStrong && !activeStrong) {
    hardTriggers.push('noReliableMarketSignal');
  }

  if (inputs.packSizeAmbiguous) {
    hardTriggers.push('packSizeAmbiguous');
  }

  // Sold vs Active mismatch
  if (inputs.soldStats && inputs.activeStats && soldStrong && activeStrong) {
    const soldP35 = inputs.soldStats.p35;
    const activeP35 = inputs.activeStats.p35;
    if (activeP35 > 0) {
      const ratio = soldP35 / activeP35;
      if (ratio > 1.25) {
        hardTriggers.push(`soldActiveRatioHigh:${ratio.toFixed(2)}`);
      } else if (ratio < 0.70) {
        hardTriggers.push(`soldActiveRatioLow:${ratio.toFixed(2)}`);
      }
    }
  }

  // Safety floor uplift > 15%
  if (inputs.safetyFloorUpliftPercent > 15) {
    hardTriggers.push(`safetyFloorUplift:${inputs.safetyFloorUpliftPercent.toFixed(1)}%`);
  }

  // Shipping loss risk
  if (inputs.shippingGapCents > inputs.shippingSubsidyCapCents) {
    hardTriggers.push(`shippingLossRisk:${inputs.shippingGapCents}c>${inputs.shippingSubsidyCapCents}c`);
  }

  // ========================================================================
  // Soft triggers (warn but allow)
  // ========================================================================
  if (soldCount >= 5 && soldCount < 10) {
    softTriggers.push('weakSoldData');
  }

  if (activeCount >= 6 && activeCount < 12) {
    softTriggers.push('weakActiveData');
  }

  if (inputs.hasRetailAnchor && inputs.identitySource === 'title-only') {
    softTriggers.push('retailAnchorMediumConfidence');
  }

  // High dispersion
  if (inputs.soldStats && inputs.soldStats.count > 0) {
    const soldIQRMedianRatio = inputs.soldStats.p50 > 0
      ? inputs.soldStats.iqr / inputs.soldStats.p50
      : 0;
    if (soldIQRMedianRatio > 0.35) {
      softTriggers.push(`highSoldDispersion:IQR/median=${soldIQRMedianRatio.toFixed(2)}`);
    }
  }

  if (inputs.activeStats && inputs.activeStats.count > 0) {
    const activeIQRMedianRatio = inputs.activeStats.p50 > 0
      ? inputs.activeStats.iqr / inputs.activeStats.p50
      : 0;
    if (activeIQRMedianRatio > 0.35) {
      softTriggers.push(`highActiveDispersion:IQR/median=${activeIQRMedianRatio.toFixed(2)}`);
    }
  }

  const requiresManualReview = hardTriggers.length > 0;

  return {
    score,
    breakdown: {
      identityStrength,
      sampleStrength,
      dispersionPenalty,
      crossSignalBonus,
      retailSanity,
    },
    hardTriggers,
    softTriggers,
    requiresManualReview,
  };
}

/**
 * Check cross-signal agreement: SoldP35 within 15% of ActiveP35.
 * Returns null if either is missing.
 */
export function checkCrossSignal(
  soldStats: RobustStats | null,
  activeStats: RobustStats | null
): boolean | null {
  if (!soldStats || !activeStats) return null;
  if (soldStats.count === 0 || activeStats.count === 0) return null;

  const soldP35 = soldStats.p35;
  const activeP35 = activeStats.p35;
  if (activeP35 === 0) return null;

  const ratio = soldP35 / activeP35;
  return ratio >= 0.85 && ratio <= 1.15;
}
