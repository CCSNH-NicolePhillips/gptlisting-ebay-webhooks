// Safety floor pricing: ensures every listing covers fees, shipping, reserve, and min payout.

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface FeeModel {
  /** Total effective fee rate (eBay final value fee + payment processing).
   *  Conservative default: 0.16 (16%). */
  feeRate: number;
  /** Fixed per-transaction fee in cents. Default: 30 ($0.30). */
  fixedFeeCents: number;
}

export interface SafetyFloorInputs {
  /** What the business/consignor must receive net of ALL costs, in cents.
   *  Default: 499 ($4.99). */
  minNetPayoutCents: number;

  /** Fee model to use for calculations. */
  feeModel: FeeModel;

  /** Estimated carrier shipping cost in cents.
   *  Use max(soldShippingMedian, sizeBandEstimate). */
  shippingCostEstimateCents: number;

  /** Reserve buffer as a rate of delivered total (for returns/adjustments).
   *  Default: 0.03 (3%). */
  reserveRate: number;

  /** Minimum reserve in cents. Default: 50 ($0.50). */
  minReserveCents: number;
}

export interface SafetyFloorResult {
  /** Minimum delivered total (cents) that satisfies all safety constraints. */
  minDeliveredCents: number;

  /** Breakdown of costs at the ACTUAL delivered price (which is max(proposed, minDelivered)). */
  breakdown: {
    feesCents: number;
    shippingCostCents: number;
    reserveCents: number;
    netPayoutCents: number;
  };

  /** Whether the floor was binding (floor > proposed target). */
  floorWasBinding: boolean;

  /** How much delivered was increased (0 if floor not binding). */
  upliftCents: number;

  /** Uplift as percentage of original target (0 if floor not binding or original was 0). */
  upliftPercent: number;
}

export interface ProfitEstimate {
  deliveredCents: number;
  feesCents: number;
  shippingCostCents: number;
  reserveCents: number;
  netPayoutCents: number;
  /** If COGS provided, compute actual profit. Otherwise null. */
  profitCents: number | null;
  /** profitCents / deliveredCents, or null if no COGS. */
  profitMargin: number | null;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

export const DEFAULT_FEE_MODEL: FeeModel = {
  feeRate: 0.16,
  fixedFeeCents: 30,
};

export const DEFAULT_SAFETY_INPUTS: SafetyFloorInputs = {
  minNetPayoutCents: 499,
  feeModel: DEFAULT_FEE_MODEL,
  shippingCostEstimateCents: 600,
  reserveRate: 0.03,
  minReserveCents: 50,
};

/* ------------------------------------------------------------------ */
/*  Core helpers                                                       */
/* ------------------------------------------------------------------ */

/**
 * Compute eBay fees (final-value + fixed) for a given delivered price.
 * Returns value in cents.
 */
export function computeFees(deliveredCents: number, feeModel: FeeModel): number {
  if (deliveredCents <= 0) {
    return feeModel.fixedFeeCents;
  }
  return Math.ceil(deliveredCents * feeModel.feeRate) + feeModel.fixedFeeCents;
}

/**
 * Compute reserve (returns/adjustments buffer) for a given delivered price.
 * Returns value in cents, never below `minReserveCents`.
 */
export function computeReserve(
  deliveredCents: number,
  reserveRate: number,
  minReserveCents: number,
): number {
  return Math.max(Math.ceil(deliveredCents * reserveRate), minReserveCents);
}

/* ------------------------------------------------------------------ */
/*  Safety floor                                                       */
/* ------------------------------------------------------------------ */

/**
 * Compute the minimum delivered price (in cents) that satisfies:
 *   delivered − fees(delivered) − shipping − reserve(delivered) ≥ minNetPayout
 */
export function computeSafetyFloor(inputs: SafetyFloorInputs): SafetyFloorResult {
  const { minNetPayoutCents, feeModel, shippingCostEstimateCents, reserveRate, minReserveCents } =
    inputs;

  // Path A – proportional reserve: d*(1 - feeRate - reserveRate) ≥ minNet + fixedFee + ship
  const denomA = 1 - feeModel.feeRate - reserveRate;
  const floorA =
    denomA > 0
      ? Math.ceil((minNetPayoutCents + feeModel.fixedFeeCents + shippingCostEstimateCents) / denomA)
      : Infinity;

  // Path B – fixed minReserve: d*(1 - feeRate) ≥ minNet + fixedFee + ship + minReserve
  const denomB = 1 - feeModel.feeRate;
  const floorB =
    denomB > 0
      ? Math.ceil(
          (minNetPayoutCents +
            feeModel.fixedFeeCents +
            shippingCostEstimateCents +
            minReserveCents) /
            denomB,
        )
      : Infinity;

  const minDeliveredCents = Math.max(floorA, floorB);

  const feesCents = computeFees(minDeliveredCents, feeModel);
  const reserveCents = computeReserve(minDeliveredCents, reserveRate, minReserveCents);
  const netPayoutCents = minDeliveredCents - feesCents - shippingCostEstimateCents - reserveCents;

  return {
    minDeliveredCents,
    breakdown: {
      feesCents,
      shippingCostCents: shippingCostEstimateCents,
      reserveCents,
      netPayoutCents,
    },
    floorWasBinding: false,
    upliftCents: 0,
    upliftPercent: 0,
  };
}

/**
 * Enforce the safety floor against a proposed target price.
 * If the target is below the floor the result is lifted to the floor.
 */
export function enforceSafetyFloor(
  targetDeliveredCents: number,
  inputs: SafetyFloorInputs,
): SafetyFloorResult {
  const floor = computeSafetyFloor(inputs);

  if (targetDeliveredCents >= floor.minDeliveredCents) {
    // Target is safe – compute breakdown at the target price.
    const feesCents = computeFees(targetDeliveredCents, inputs.feeModel);
    const reserveCents = computeReserve(
      targetDeliveredCents,
      inputs.reserveRate,
      inputs.minReserveCents,
    );
    const netPayoutCents =
      targetDeliveredCents - feesCents - inputs.shippingCostEstimateCents - reserveCents;

    return {
      minDeliveredCents: targetDeliveredCents,
      breakdown: {
        feesCents,
        shippingCostCents: inputs.shippingCostEstimateCents,
        reserveCents,
        netPayoutCents,
      },
      floorWasBinding: false,
      upliftCents: 0,
      upliftPercent: 0,
    };
  }

  // Floor is binding – use floor price & breakdown.
  const upliftCents = floor.minDeliveredCents - targetDeliveredCents;
  const upliftPercent =
    targetDeliveredCents > 0 ? (upliftCents / targetDeliveredCents) * 100 : 100;

  return {
    ...floor,
    floorWasBinding: true,
    upliftCents,
    upliftPercent,
  };
}

/* ------------------------------------------------------------------ */
/*  Profit estimation                                                  */
/* ------------------------------------------------------------------ */

/**
 * Estimate net payout and optional profit for a given delivered price.
 */
export function estimateProfit(
  deliveredCents: number,
  inputs: SafetyFloorInputs,
  cogsCents?: number,
): ProfitEstimate {
  const feesCents = computeFees(deliveredCents, inputs.feeModel);
  const shippingCostCents = inputs.shippingCostEstimateCents;
  const reserveCents = computeReserve(deliveredCents, inputs.reserveRate, inputs.minReserveCents);
  const netPayoutCents = deliveredCents - feesCents - shippingCostCents - reserveCents;

  let profitCents: number | null = null;
  let profitMargin: number | null = null;

  if (cogsCents !== undefined) {
    profitCents = netPayoutCents - cogsCents;
    profitMargin = deliveredCents > 0 ? profitCents / deliveredCents : 0;
  }

  return {
    deliveredCents,
    feesCents,
    shippingCostCents,
    reserveCents,
    netPayoutCents,
    profitCents,
    profitMargin,
  };
}
