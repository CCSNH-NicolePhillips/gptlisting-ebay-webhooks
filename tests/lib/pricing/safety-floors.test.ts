import {
  computeFees,
  computeReserve,
  computeSafetyFloor,
  enforceSafetyFloor,
  estimateProfit,
  DEFAULT_FEE_MODEL,
  DEFAULT_SAFETY_INPUTS,
  FeeModel,
  SafetyFloorInputs,
} from '../../../src/lib/pricing/safety-floors.js';

/* ------------------------------------------------------------------ */
/*  computeFees                                                        */
/* ------------------------------------------------------------------ */
describe('computeFees', () => {
  it('1. 1000 cents with default model → 190', () => {
    expect(computeFees(1000, DEFAULT_FEE_MODEL)).toBe(190);
  });

  it('2. 2500 cents with default model → 430', () => {
    expect(computeFees(2500, DEFAULT_FEE_MODEL)).toBe(430);
  });

  it('3. 0 cents → fixedFee only (30)', () => {
    expect(computeFees(0, DEFAULT_FEE_MODEL)).toBe(30);
  });

  it('4. 1 cent → ceil(0.16)+30 = 31', () => {
    expect(computeFees(1, DEFAULT_FEE_MODEL)).toBe(31);
  });

  it('5. custom feeModel: 13% rate, no fixed fee → 130', () => {
    const custom: FeeModel = { feeRate: 0.13, fixedFeeCents: 0 };
    expect(computeFees(1000, custom)).toBe(130);
  });
});

/* ------------------------------------------------------------------ */
/*  computeReserve                                                     */
/* ------------------------------------------------------------------ */
describe('computeReserve', () => {
  it('6. 1000 @ 3% (min 50) → 50 (min kicks in)', () => {
    expect(computeReserve(1000, 0.03, 50)).toBe(50);
  });

  it('7. 5000 @ 3% (min 50) → 150', () => {
    expect(computeReserve(5000, 0.03, 50)).toBe(150);
  });

  it('8. 0 @ 3% (min 50) → 50', () => {
    expect(computeReserve(0, 0.03, 50)).toBe(50);
  });

  it('9. 2000 @ 3% (min 50) → 60', () => {
    expect(computeReserve(2000, 0.03, 50)).toBe(60);
  });
});

/* ------------------------------------------------------------------ */
/*  computeSafetyFloor                                                 */
/* ------------------------------------------------------------------ */
describe('computeSafetyFloor', () => {
  it('10. DEFAULT_SAFETY_INPUTS floor ≈ 1404', () => {
    const result = computeSafetyFloor(DEFAULT_SAFETY_INPUTS);
    // Path A: ceil((499+30+600)/0.81) = ceil(1393.83) = 1394
    // Path B: ceil((499+30+600+50)/0.84) = ceil(1403.57) = 1404
    // max = 1404
    expect(result.minDeliveredCents).toBe(1404);
    // Verify breakdown adds up
    const { feesCents, shippingCostCents, reserveCents, netPayoutCents } = result.breakdown;
    expect(feesCents + shippingCostCents + reserveCents + netPayoutCents).toBe(
      result.minDeliveredCents,
    );
    // Net should be >= minNetPayout
    expect(netPayoutCents).toBeGreaterThanOrEqual(DEFAULT_SAFETY_INPUTS.minNetPayoutCents);
  });

  it('11. higher shipping → higher floor', () => {
    const higherShip: SafetyFloorInputs = {
      ...DEFAULT_SAFETY_INPUTS,
      shippingCostEstimateCents: 1200,
    };
    const base = computeSafetyFloor(DEFAULT_SAFETY_INPUTS);
    const higher = computeSafetyFloor(higherShip);
    expect(higher.minDeliveredCents).toBeGreaterThan(base.minDeliveredCents);
  });

  it('12. minNetPayout=0 → floor covers fees + ship + reserve only', () => {
    const zeroPayout: SafetyFloorInputs = { ...DEFAULT_SAFETY_INPUTS, minNetPayoutCents: 0 };
    const result = computeSafetyFloor(zeroPayout);
    // Floor should be much lower than default
    expect(result.minDeliveredCents).toBeLessThan(DEFAULT_SAFETY_INPUTS.minNetPayoutCents + 600);
    expect(result.breakdown.netPayoutCents).toBeGreaterThanOrEqual(0);
  });

  it('13. feeRate=0, fixedFee=0 → floor ≈ ship + reserve + minNet', () => {
    const noFees: SafetyFloorInputs = {
      ...DEFAULT_SAFETY_INPUTS,
      feeModel: { feeRate: 0, fixedFeeCents: 0 },
    };
    const result = computeSafetyFloor(noFees);
    // Path A: (499+0+600)/(1-0-0.03) = 1099/0.97 ≈ 1133
    // Path B: (499+0+600+50)/(1-0) = 1149/1 = 1149
    // max(1133,1149) = 1149
    expect(result.minDeliveredCents).toBe(1149);
  });

  it('14. floorWasBinding is always false for computeSafetyFloor', () => {
    const result = computeSafetyFloor(DEFAULT_SAFETY_INPUTS);
    expect(result.floorWasBinding).toBe(false);
    expect(result.upliftCents).toBe(0);
    expect(result.upliftPercent).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/*  enforceSafetyFloor                                                 */
/* ------------------------------------------------------------------ */
describe('enforceSafetyFloor', () => {
  // Pre-compute the floor for reference
  const floor = computeSafetyFloor(DEFAULT_SAFETY_INPUTS);

  it('15. target 2000 (above floor) → not binding, uplift 0', () => {
    const result = enforceSafetyFloor(2000, DEFAULT_SAFETY_INPUTS);
    expect(result.floorWasBinding).toBe(false);
    expect(result.upliftCents).toBe(0);
    expect(result.upliftPercent).toBe(0);
    expect(result.minDeliveredCents).toBe(2000);
  });

  it('16. target 1000 (below floor) → binding, uplift ≈ 404', () => {
    const result = enforceSafetyFloor(1000, DEFAULT_SAFETY_INPUTS);
    expect(result.floorWasBinding).toBe(true);
    expect(result.minDeliveredCents).toBe(floor.minDeliveredCents);
    expect(result.upliftCents).toBe(floor.minDeliveredCents - 1000);
    // upliftPercent = (uplift / 1000) * 100
    expect(result.upliftPercent).toBeCloseTo(
      ((floor.minDeliveredCents - 1000) / 1000) * 100,
      2,
    );
  });

  it('17. target 0 → binding, upliftPercent = 100', () => {
    const result = enforceSafetyFloor(0, DEFAULT_SAFETY_INPUTS);
    expect(result.floorWasBinding).toBe(true);
    expect(result.upliftPercent).toBe(100);
    expect(result.minDeliveredCents).toBe(floor.minDeliveredCents);
  });

  it('18. target exactly at floor → not binding', () => {
    const result = enforceSafetyFloor(floor.minDeliveredCents, DEFAULT_SAFETY_INPUTS);
    expect(result.floorWasBinding).toBe(false);
    expect(result.upliftCents).toBe(0);
  });

  it('19. breakdown at safe target sums to delivered', () => {
    const target = 2000;
    const result = enforceSafetyFloor(target, DEFAULT_SAFETY_INPUTS);
    const { feesCents, shippingCostCents, reserveCents, netPayoutCents } = result.breakdown;
    expect(feesCents + shippingCostCents + reserveCents + netPayoutCents).toBe(target);
  });
});

/* ------------------------------------------------------------------ */
/*  estimateProfit                                                     */
/* ------------------------------------------------------------------ */
describe('estimateProfit', () => {
  it('20. 2000 delivered, no COGS → net=990, profit null', () => {
    const est = estimateProfit(2000, DEFAULT_SAFETY_INPUTS);
    // fees = ceil(2000*0.16)+30 = 320+30 = 350
    expect(est.feesCents).toBe(350);
    expect(est.shippingCostCents).toBe(600);
    // reserve = max(ceil(60),50) = 60
    expect(est.reserveCents).toBe(60);
    expect(est.netPayoutCents).toBe(2000 - 350 - 600 - 60);
    expect(est.netPayoutCents).toBe(990);
    expect(est.profitCents).toBeNull();
    expect(est.profitMargin).toBeNull();
  });

  it('21. 2000 delivered, COGS=300 → profit=690, margin=0.345', () => {
    const est = estimateProfit(2000, DEFAULT_SAFETY_INPUTS, 300);
    expect(est.netPayoutCents).toBe(990);
    expect(est.profitCents).toBe(690);
    expect(est.profitMargin).toBeCloseTo(0.345, 5);
  });

  it('22. 0 delivered, no COGS → negative net, profit null', () => {
    const est = estimateProfit(0, DEFAULT_SAFETY_INPUTS);
    // fees(0) = fixedFee = 30, reserve = 50 (min), ship = 600
    expect(est.feesCents).toBe(30);
    expect(est.reserveCents).toBe(50);
    expect(est.netPayoutCents).toBe(0 - 30 - 600 - 50);
    expect(est.netPayoutCents).toBe(-680);
    expect(est.profitCents).toBeNull();
    expect(est.profitMargin).toBeNull();
  });

  it('23. COGS > net → negative profitCents', () => {
    const est = estimateProfit(2000, DEFAULT_SAFETY_INPUTS, 1500);
    expect(est.profitCents).toBe(990 - 1500);
    expect(est.profitCents).toBe(-510);
    expect(est.profitMargin).toBeCloseTo(-510 / 2000, 5);
  });
});

/* ------------------------------------------------------------------ */
/*  Integration                                                        */
/* ------------------------------------------------------------------ */
describe('integration', () => {
  it('24. end-to-end: floor → enforce low target → breakdown adds up', () => {
    const floor = computeSafetyFloor(DEFAULT_SAFETY_INPUTS);
    const enforced = enforceSafetyFloor(800, DEFAULT_SAFETY_INPUTS);

    expect(enforced.floorWasBinding).toBe(true);
    expect(enforced.minDeliveredCents).toBe(floor.minDeliveredCents);

    const { feesCents, shippingCostCents, reserveCents, netPayoutCents } = enforced.breakdown;
    expect(feesCents + shippingCostCents + reserveCents + netPayoutCents).toBe(
      enforced.minDeliveredCents,
    );
  });

  it('25. estimateProfit at floor price has net >= minNetPayout', () => {
    const floor = computeSafetyFloor(DEFAULT_SAFETY_INPUTS);
    const est = estimateProfit(floor.minDeliveredCents, DEFAULT_SAFETY_INPUTS);
    expect(est.netPayoutCents).toBeGreaterThanOrEqual(DEFAULT_SAFETY_INPUTS.minNetPayoutCents);
  });

  it('26. upliftPercent > 15 detection for review triggers', () => {
    // Pick a target that is ~18% below the floor
    const floor = computeSafetyFloor(DEFAULT_SAFETY_INPUTS);
    // target such that uplift/target ≈ 18%  ⇒  target = floor / 1.18
    const target = Math.floor(floor.minDeliveredCents / 1.18);
    const result = enforceSafetyFloor(target, DEFAULT_SAFETY_INPUTS);

    expect(result.floorWasBinding).toBe(true);
    // Verify the uplift percent is roughly 18%
    const expectedUplift = floor.minDeliveredCents - target;
    const expectedPercent = (expectedUplift / target) * 100;
    expect(result.upliftPercent).toBeCloseTo(expectedPercent, 2);
    expect(result.upliftPercent).toBeGreaterThan(15);
  });
});
