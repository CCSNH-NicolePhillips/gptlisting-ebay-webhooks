import {
  computeRobustStats,
  percentile,
  isFloorOutlier,
  isSoldStrong,
  isActiveStrong,
  isSoldWeak,
  isActiveWeak,
  sellThrough,
  CompSample,
  RobustStats,
} from '../../../src/lib/pricing/robust-stats.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeStats(overrides: Partial<RobustStats>): RobustStats {
  return {
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
    ...overrides,
  };
}

function makeSamples(deliveredValues: number[]): CompSample[] {
  return deliveredValues.map((d) => ({ itemCents: d, shipCents: 0, deliveredCents: d }));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('percentile', () => {
  it('1. empty array → 0', () => {
    expect(percentile([], 0.5)).toBe(0);
  });

  it('2. single element [500] at p=0.5 → 500', () => {
    expect(percentile([500], 0.5)).toBe(500);
  });

  it('3. [100,200,300,400,500] at p=0.20 → 100', () => {
    expect(percentile([100, 200, 300, 400, 500], 0.20)).toBe(100);
  });

  it('4. [100,200,300,400,500] at p=0.35 → 200', () => {
    expect(percentile([100, 200, 300, 400, 500], 0.35)).toBe(200);
  });

  it('5. [100,200,300,400,500] at p=0.50 → 300', () => {
    expect(percentile([100, 200, 300, 400, 500], 0.50)).toBe(300);
  });

  it('6. [100,200,300,400,500] at p=0.65 → 400', () => {
    expect(percentile([100, 200, 300, 400, 500], 0.65)).toBe(400);
  });

  it('7. [100,200,300,400,500] at p=1.0 → 500', () => {
    expect(percentile([100, 200, 300, 400, 500], 1.0)).toBe(500);
  });

  it('8. [100,200,300,400,500] at p=0.0 → 100 (first element)', () => {
    expect(percentile([100, 200, 300, 400, 500], 0.0)).toBe(100);
  });
});

describe('computeRobustStats', () => {
  it('9. empty array → all zeros', () => {
    const stats = computeRobustStats([]);
    expect(stats.count).toBe(0);
    expect(stats.rawCount).toBe(0);
    expect(stats.min).toBe(0);
    expect(stats.max).toBe(0);
    expect(stats.p50).toBe(0);
    expect(stats.iqr).toBe(0);
    expect(stats.coefficientOfVariation).toBe(0);
    expect(stats.freeShippingRate).toBe(0);
  });

  it('10. single element → all percentiles equal, iqr=0, cv=0, freeShippingRate=1', () => {
    const stats = computeRobustStats([{ itemCents: 300, shipCents: 0, deliveredCents: 300 }]);
    expect(stats.count).toBe(1);
    expect(stats.rawCount).toBe(1);
    expect(stats.p20).toBe(300);
    expect(stats.p35).toBe(300);
    expect(stats.p50).toBe(300);
    expect(stats.p65).toBe(300);
    expect(stats.iqr).toBe(0);
    expect(stats.coefficientOfVariation).toBe(0);
    expect(stats.freeShippingRate).toBe(1.0);
  });

  it('11. five elements — verify percentiles, no outliers removed', () => {
    // Use [350,400,500,600,700] so neither IQR nor TGTB rule removes anything
    // (min 350 >= 0.70 * p35 400 = 280 ✓, IQR fences [-100, 900] ✓)
    const stats = computeRobustStats(makeSamples([350, 400, 500, 600, 700]));
    expect(stats.rawCount).toBe(5);
    expect(stats.count).toBe(5);
    expect(stats.p20).toBe(350);
    expect(stats.p35).toBe(400);
    expect(stats.p50).toBe(500);
    expect(stats.p65).toBe(600);
    expect(stats.min).toBe(350);
    expect(stats.max).toBe(700);
    expect(stats.outliersBelowCount).toBe(0);
    expect(stats.outliersAboveCount).toBe(0);
  });

  it('12. high outlier removed by IQR filter', () => {
    const stats = computeRobustStats(makeSamples([100, 200, 210, 220, 230, 1500]));
    expect(stats.rawCount).toBe(6);
    expect(stats.count).toBeLessThan(stats.rawCount);
    expect(stats.outliersAboveCount).toBeGreaterThan(0);
    // 1500 should be gone
    expect(stats.max).toBeLessThan(1500);
  });

  it('13. low outlier removed', () => {
    const stats = computeRobustStats(makeSamples([10, 200, 210, 220, 230, 240]));
    expect(stats.rawCount).toBe(6);
    expect(stats.count).toBeLessThan(stats.rawCount);
    expect(stats.outliersBelowCount).toBeGreaterThan(0);
    expect(stats.min).toBeGreaterThan(10);
  });

  it('14. too-good-to-be-true removal (70% of P35 rule)', () => {
    // After IQR pass: all 6 values survive IQR (range is moderate).
    // P35 of IQR-cleaned ≈ 300. 70% of 300 = 210. 50 < 210 → dropped.
    const stats = computeRobustStats(makeSamples([50, 300, 310, 320, 330, 340]));
    expect(stats.rawCount).toBe(6);
    expect(stats.count).toBeLessThan(stats.rawCount);
    expect(stats.min).toBeGreaterThanOrEqual(300);
  });

  it('15. free shipping rate from raw samples', () => {
    const samples: CompSample[] = [
      { itemCents: 500, shipCents: 0, deliveredCents: 500 },
      { itemCents: 400, shipCents: 600, deliveredCents: 1000 },
      { itemCents: 450, shipCents: 0, deliveredCents: 450 },
      { itemCents: 480, shipCents: 600, deliveredCents: 1080 },
    ];
    const stats = computeRobustStats(samples);
    expect(stats.freeShippingRate).toBeCloseTo(0.5, 5);
  });

  it('16. coefficientOfVariation = 0 when no variance', () => {
    const stats = computeRobustStats(makeSamples([100, 100, 100]));
    expect(stats.coefficientOfVariation).toBe(0);
  });

  it('17. large realistic dataset with extreme outliers', () => {
    const clustered = [
      1500, 1600, 1700, 1800, 1900,
      2000, 2100, 2200, 2300, 2400,
      2500, 2600, 2700, 2800, 2900,
      3000, 3200, 3500, 3800, 4500,
    ];
    const withOutliers = [200, ...clustered, 9000];
    const stats = computeRobustStats(makeSamples(withOutliers));

    expect(stats.rawCount).toBe(22);
    // Outliers should be removed
    expect(stats.count).toBeLessThan(stats.rawCount);
    expect(stats.min).toBeGreaterThan(200);
    expect(stats.max).toBeLessThan(9000);
    // Percentiles should be within the cluster range
    expect(stats.p50).toBeGreaterThanOrEqual(1500);
    expect(stats.p50).toBeLessThanOrEqual(4500);
    expect(stats.coefficientOfVariation).toBeGreaterThan(0);
  });
});

describe('isFloorOutlier', () => {
  it('18. min=100, p20=500, count=5 → true', () => {
    const stats = makeStats({ min: 100, p20: 500, count: 5 });
    expect(isFloorOutlier(stats)).toBe(true);
  });

  it('19. min=450, p20=500, count=5 → false', () => {
    const stats = makeStats({ min: 450, p20: 500, count: 5 });
    expect(isFloorOutlier(stats)).toBe(false);
  });

  it('20. count=2 → false regardless of prices', () => {
    const stats = makeStats({ min: 10, p20: 500, count: 2 });
    expect(isFloorOutlier(stats)).toBe(false);
  });
});

describe('isSoldStrong', () => {
  it('21. count=5 → true (threshold lowered from 10 to 5)', () => {
    expect(isSoldStrong(makeStats({ count: 5 }))).toBe(true);
  });

  it('22. count=4 → false', () => {
    expect(isSoldStrong(makeStats({ count: 4 }))).toBe(false);
  });

  it('23. count=10 → true (still passes with plenty of data)', () => {
    expect(isSoldStrong(makeStats({ count: 10 }))).toBe(true);
  });

  it('23b. custom minCount=8, count=7 → false', () => {
    expect(isSoldStrong(makeStats({ count: 7 }), 8)).toBe(false);
  });
});

describe('isActiveStrong', () => {
  it('24. count=5 → true (threshold lowered from 12 to 5)', () => {
    expect(isActiveStrong(makeStats({ count: 5 }))).toBe(true);
  });

  it('25. count=4 → false', () => {
    expect(isActiveStrong(makeStats({ count: 4 }))).toBe(false);
  });

  it('25b. count=12 → true (still passes with plenty of data)', () => {
    expect(isActiveStrong(makeStats({ count: 12 }))).toBe(true);
  });
});

describe('isSoldWeak', () => {
  it('weak-1. count=3 → true (3-4 = weak tier)', () => {
    expect(isSoldWeak(makeStats({ count: 3 }))).toBe(true);
  });

  it('weak-2. count=4 → true', () => {
    expect(isSoldWeak(makeStats({ count: 4 }))).toBe(true);
  });

  it('weak-3. count=5 → false (strong, not weak)', () => {
    expect(isSoldWeak(makeStats({ count: 5 }))).toBe(false);
  });

  it('weak-4. count=2 → false (too few)', () => {
    expect(isSoldWeak(makeStats({ count: 2 }))).toBe(false);
  });
});

describe('isActiveWeak', () => {
  it('weak-5. count=3 → true', () => {
    expect(isActiveWeak(makeStats({ count: 3 }))).toBe(true);
  });

  it('weak-6. count=4 → true', () => {
    expect(isActiveWeak(makeStats({ count: 4 }))).toBe(true);
  });

  it('weak-7. count=5 → false (strong)', () => {
    expect(isActiveWeak(makeStats({ count: 5 }))).toBe(false);
  });

  it('weak-8. count=1 → false (too few)', () => {
    expect(isActiveWeak(makeStats({ count: 1 }))).toBe(false);
  });
});

describe('sellThrough', () => {
  it('26. soldCount=10, activeCount=40 → 0.20', () => {
    expect(sellThrough(10, 40)).toBeCloseTo(0.20, 5);
  });

  it('27. soldCount=0, activeCount=0 → null', () => {
    expect(sellThrough(0, 0)).toBeNull();
  });

  it('28. soldCount=50, activeCount=50 → 0.50', () => {
    expect(sellThrough(50, 50)).toBeCloseTo(0.50, 5);
  });
});
