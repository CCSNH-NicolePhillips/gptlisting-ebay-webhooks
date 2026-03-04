/**
 * Tests for src/lib/pricing/index.ts — unified pricing entrypoint.
 *
 * Validates:
 *  - resolveActivePricingMode() correctly reads PRICING_MODE (authoritative)
 *  - DELIVERED_PRICING_V2 back-compat routes correctly and emits deprecation warn
 *  - PRICING_MODE overrides DELIVERED_PRICING_V2 unconditionally
 *  - getPricingDecision routes to delivered_v2 or legacy based on active mode
 *  - NEEDS_REVIEW gating on low-confidence delivered warnings
 *  - READY status on clean delivered result
 *  - needsManualReview helper (re-exported from pricing/index)
 */

// ── Module mocks ─────────────────────────────────────────────────────────────
jest.mock('../../../src/lib/delivered-pricing.js', () => ({
  getDeliveredPricing: jest.fn(),
  DEFAULT_PRICING_SETTINGS: {
    mode: 'market-match',
    shippingEstimateCents: 600,
    minItemCents: 499,
    undercutCents: 100,
    allowFreeShippingWhenNeeded: true,
    freeShippingMaxSubsidyCents: 500,
    lowPriceMode: 'FLAG_ONLY',
    useSmartShipping: true,
  },
}));

jest.mock('../../../packages/core/src/pricing/legacy-compute.js', () => ({
  getFinalEbayPrice: jest.fn(),
  getCategoryCap: jest.fn(),
}));

// ── Imports ───────────────────────────────────────────────────────────────────
import {
  getPricingDecision,
  needsManualReview,
  resolveActivePricingMode,
} from '../../../src/lib/pricing/index.js';
import { getDeliveredPricing } from '../../../src/lib/delivered-pricing.js';
import { getFinalEbayPrice, getCategoryCap } from '../../../src/lib/pricing/legacy-compute.js';

const mockGetDeliveredPricing = getDeliveredPricing as jest.MockedFunction<typeof getDeliveredPricing>;
const mockGetFinalEbayPrice = getFinalEbayPrice as jest.MockedFunction<typeof getFinalEbayPrice>;
const mockGetCategoryCap = getCategoryCap as jest.MockedFunction<typeof getCategoryCap>;

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Build a minimal DeliveredPricingDecision for tests. */
function buildDecision(overrides: Partial<{
  finalItemCents: number;
  finalShipCents: number;
  warnings: string[];
  fallbackUsed: boolean;
}> = {}) {
  return {
    brand: 'TestBrand',
    productName: 'Test Product',
    ebayComps: [{ source: 'ebay', itemCents: 2000, shipCents: 0, deliveredCents: 2000 }],
    retailComps: [],
    activeFloorDeliveredCents: 2000,
    activeMedianDeliveredCents: 2000,
    amazonPriceCents: 3000,
    walmartPriceCents: null,
    soldMedianDeliveredCents: 1900,
    soldCount: 12,
    soldStrong: true,
    mode: 'market-match' as const,
    targetDeliveredCents: 2000,
    finalItemCents: overrides.finalItemCents ?? 1800,
    finalShipCents: overrides.finalShipCents ?? 200,
    freeShipApplied: false,
    subsidyCents: 0,
    shippingEstimateSource: 'comps' as const,
    skipListing: false,
    canCompete: true,
    matchConfidence: 'high' as const,
    fallbackUsed: overrides.fallbackUsed ?? false,
    compsSource: 'google-shopping' as const,
    warnings: overrides.warnings ?? [],
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// needsManualReview
// ═════════════════════════════════════════════════════════════════════════════

describe('needsManualReview', () => {
  it('triggers on manualReviewRequired', () => {
    expect(needsManualReview(['manualReviewRequired'])).toBe(true);
  });

  it('triggers on noPricingData', () => {
    expect(needsManualReview(['noPricingData'])).toBe(true);
  });

  it('triggers on any warning containing "manual" (case-insensitive)', () => {
    expect(needsManualReview(['MANUAL_CHECK'])).toBe(true);
    expect(needsManualReview(['requiresManualIntervention'])).toBe(true);
  });

  it('does NOT trigger on unrelated warnings', () => {
    expect(needsManualReview(['priceFloor', 'competitorDataStale'])).toBe(false);
    expect(needsManualReview([])).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// resolveActivePricingMode()
//
// NOTE: _deprecWarnEmitted is a module-level flag that fires at most once per
// process. These tests run BEFORE any describe block that sets DELIVERED_PRICING_V2
// via getPricingDecision(), ensuring the flag is still false when the
// deprecation-warning test fires.
// ═════════════════════════════════════════════════════════════════════════════

describe('resolveActivePricingMode', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    delete process.env.PRICING_MODE;
    delete process.env.DELIVERED_PRICING_V2;
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    delete process.env.PRICING_MODE;
    delete process.env.DELIVERED_PRICING_V2;
  });

  // ── PRICING_MODE (authoritative) ───────────────────────────────────────────

  it('returns "delivered_v2" when PRICING_MODE=delivered_v2', () => {
    process.env.PRICING_MODE = 'delivered_v2';
    expect(resolveActivePricingMode()).toBe('delivered_v2');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns "legacy" when PRICING_MODE=legacy', () => {
    process.env.PRICING_MODE = 'legacy';
    expect(resolveActivePricingMode()).toBe('legacy');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns "legacy" and warns when PRICING_MODE has an unknown value', () => {
    process.env.PRICING_MODE = 'super_mode';
    expect(resolveActivePricingMode()).toBe('legacy');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unknown PRICING_MODE="super_mode"'),
    );
  });

  it('PRICING_MODE=delivered_v2 overrides DELIVERED_PRICING_V2=false (no deprecation warn)', () => {
    process.env.PRICING_MODE = 'delivered_v2';
    process.env.DELIVERED_PRICING_V2 = 'false';
    expect(resolveActivePricingMode()).toBe('delivered_v2');
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('deprecated'));
  });

  it('PRICING_MODE=legacy overrides DELIVERED_PRICING_V2=true (no deprecation warn)', () => {
    process.env.PRICING_MODE = 'legacy';
    process.env.DELIVERED_PRICING_V2 = 'true';
    expect(resolveActivePricingMode()).toBe('legacy');
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('deprecated'));
  });

  // ── DELIVERED_PRICING_V2 back-compat + deprecation warning ────────────────
  // The deprecation warning fires exactly once per process (_deprecWarnEmitted).
  // This test (the first in the file to set DELIVERED_PRICING_V2) captures it.

  it('emits deprecation warning on first DELIVERED_PRICING_V2 use', () => {
    process.env.DELIVERED_PRICING_V2 = 'true';
    resolveActivePricingMode();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('DELIVERED_PRICING_V2 is deprecated'),
    );
  });

  it('back-compat: DELIVERED_PRICING_V2=true maps to delivered_v2', () => {
    process.env.DELIVERED_PRICING_V2 = 'true';
    expect(resolveActivePricingMode()).toBe('delivered_v2');
  });

  it('back-compat: DELIVERED_PRICING_V2=false maps to legacy', () => {
    process.env.DELIVERED_PRICING_V2 = 'false';
    expect(resolveActivePricingMode()).toBe('legacy');
  });

  // ── Default ────────────────────────────────────────────────────────────────

  it('returns "legacy" when neither env var is set', () => {
    expect(resolveActivePricingMode()).toBe('legacy');
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// getPricingDecision — PRICING_MODE=delivered_v2 (authoritative)
// ═════════════════════════════════════════════════════════════════════════════

describe('getPricingDecision — PRICING_MODE=delivered_v2', () => {
  beforeEach(() => {
    process.env.PRICING_MODE = 'delivered_v2';
    delete process.env.DELIVERED_PRICING_V2;
    jest.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.PRICING_MODE;
  });

  it('routes to getDeliveredPricing and returns READY when no gating warnings', async () => {
    const dec = buildDecision({ finalItemCents: 1800, finalShipCents: 200 });
    mockGetDeliveredPricing.mockResolvedValue(dec as any);

    const result = await getPricingDecision({ brand: 'B', productName: 'P' });

    expect(mockGetDeliveredPricing).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('READY');
    expect(result.finalItemCents).toBe(1800);
    expect(result.finalShipCents).toBe(200);
    expect(result.pricingEvidence.source).toBe('delivered-v2');
    expect(result.pricingEvidence.summary).toBeDefined();
    expect(mockGetFinalEbayPrice).not.toHaveBeenCalled();
  });

  it('returns NEEDS_REVIEW and legacy fallback when gating warning present', async () => {
    const dec = buildDecision({ finalItemCents: 400, warnings: ['manualReviewRequired'] });
    mockGetDeliveredPricing.mockResolvedValue(dec as any);
    mockGetCategoryCap.mockReturnValue(undefined);
    mockGetFinalEbayPrice.mockReturnValue(17.99);

    const result = await getPricingDecision({
      brand: 'B', productName: 'P', retailPriceDollars: 24.99, categoryPath: 'Health',
    });

    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.finalItemCents).toBe(1799);
    expect(result.pricingEvidence.manualReviewRequired).toBe(true);
    expect(result.pricingEvidence.summary).toBeDefined();
  });

  it('passes settings and additionalContext through to getDeliveredPricing', async () => {
    mockGetDeliveredPricing.mockResolvedValue(buildDecision() as any);

    await getPricingDecision({
      brand: 'B', productName: 'P',
      settings: { mode: 'fast-sale' }, additionalContext: 'vitamins',
    });

    expect(mockGetDeliveredPricing).toHaveBeenCalledWith('B', 'P', { mode: 'fast-sale' }, 'vitamins');
  });

  it('honours PRICING_MODE=delivered_v2 even without DELIVERED_PRICING_V2', async () => {
    mockGetDeliveredPricing.mockResolvedValue(buildDecision() as any);
    const result = await getPricingDecision({ brand: 'B', productName: 'P' });
    expect(mockGetDeliveredPricing).toHaveBeenCalledTimes(1);
    expect(result.pricingEvidence.summary).toBeDefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// getPricingDecision — PRICING_MODE=legacy (authoritative)
// ═════════════════════════════════════════════════════════════════════════════

describe('getPricingDecision — PRICING_MODE=legacy', () => {
  beforeEach(() => {
    process.env.PRICING_MODE = 'legacy';
    delete process.env.DELIVERED_PRICING_V2;
    jest.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.PRICING_MODE;
  });

  it('routes to getFinalEbayPrice and returns READY', async () => {
    mockGetCategoryCap.mockReturnValue(35);
    mockGetFinalEbayPrice.mockReturnValue(19.99);

    const result = await getPricingDecision({
      brand: 'B', productName: 'P', retailPriceDollars: 29.99, categoryPath: 'Books',
    });

    expect(mockGetDeliveredPricing).not.toHaveBeenCalled();
    expect(mockGetFinalEbayPrice).toHaveBeenCalledWith(29.99, { categoryCap: 35 });
    expect(result.status).toBe('READY');
    expect(result.finalItemCents).toBe(1999);
    expect(result.pricingEvidence.source).toBe('legacy');
    expect(result.pricingEvidence.summary).toBeUndefined();
  });

  it('returns zero price when no retailPriceDollars provided', async () => {
    const result = await getPricingDecision({ brand: 'B', productName: 'P' });
    expect(result.finalItemCents).toBe(0);
    expect(mockGetFinalEbayPrice).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// getPricingDecision — PRICING_MODE overrides DELIVERED_PRICING_V2
// ═════════════════════════════════════════════════════════════════════════════

describe('getPricingDecision — PRICING_MODE overrides DELIVERED_PRICING_V2', () => {
  afterEach(() => {
    delete process.env.PRICING_MODE;
    delete process.env.DELIVERED_PRICING_V2;
    jest.clearAllMocks();
  });

  it('PRICING_MODE=legacy wins over DELIVERED_PRICING_V2=true', async () => {
    process.env.PRICING_MODE = 'legacy';
    process.env.DELIVERED_PRICING_V2 = 'true';
    mockGetCategoryCap.mockReturnValue(undefined);
    mockGetFinalEbayPrice.mockReturnValue(10.00);

    const result = await getPricingDecision({ brand: 'B', productName: 'P', retailPriceDollars: 15 });

    expect(mockGetDeliveredPricing).not.toHaveBeenCalled();
    expect(result.pricingEvidence.source).toBe('legacy');
    expect(result.pricingEvidence.summary).toBeUndefined();
  });

  it('PRICING_MODE=delivered_v2 wins over DELIVERED_PRICING_V2=false', async () => {
    process.env.PRICING_MODE = 'delivered_v2';
    process.env.DELIVERED_PRICING_V2 = 'false';
    mockGetDeliveredPricing.mockResolvedValue(buildDecision() as any);

    const result = await getPricingDecision({ brand: 'B', productName: 'P' });

    expect(mockGetDeliveredPricing).toHaveBeenCalledTimes(1);
    expect(result.pricingEvidence.source).toBe('delivered-v2');
    expect(result.pricingEvidence.summary).toBeDefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Back-compat: DELIVERED_PRICING_V2 (deprecated)
// ═════════════════════════════════════════════════════════════════════════════

describe('getPricingDecision — DELIVERED_PRICING_V2=true [back-compat, deprecated]', () => {
  beforeEach(() => {
    process.env.DELIVERED_PRICING_V2 = 'true';
    delete process.env.PRICING_MODE;
    jest.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.DELIVERED_PRICING_V2;
  });

  it('routes to getDeliveredPricing and returns READY status', async () => {
    const dec = buildDecision({ finalItemCents: 1800, finalShipCents: 200 });
    mockGetDeliveredPricing.mockResolvedValue(dec as any);

    const result = await getPricingDecision({ brand: 'TestBrand', productName: 'Test Product' });

    expect(mockGetDeliveredPricing).toHaveBeenCalledTimes(1);
    expect(mockGetDeliveredPricing).toHaveBeenCalledWith(
      'TestBrand', 'Test Product', undefined, undefined,
    );
    expect(result.status).toBe('READY');
    expect(result.finalItemCents).toBe(1800);
    expect(result.finalShipCents).toBe(200);
    expect(result.pricingEvidence.source).toBe('delivered-v2');
    expect(result.pricingEvidence.manualReviewRequired).toBe(false);
    expect(result.pricingEvidence.summary).toBeDefined();
    expect(mockGetFinalEbayPrice).not.toHaveBeenCalled();
  });

  it('returns NEEDS_REVIEW and computes legacy fallback when gating warning present', async () => {
    const dec = buildDecision({ finalItemCents: 400, warnings: ['manualReviewRequired'] });
    mockGetDeliveredPricing.mockResolvedValue(dec as any);
    mockGetCategoryCap.mockReturnValue(undefined);
    mockGetFinalEbayPrice.mockReturnValue(17.99);

    const result = await getPricingDecision({
      brand: 'TestBrand', productName: 'Test Product',
      retailPriceDollars: 24.99, categoryPath: 'Health',
    });

    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.finalItemCents).toBe(1799);
    expect(result.pricingEvidence.manualReviewRequired).toBe(true);
    expect(result.pricingEvidence.fallbackSuggestion?.itemCents).toBe(1799);
    expect(result.pricingEvidence.fallbackSuggestion?.source).toBe('legacy-retail');
    expect(result.pricingEvidence.summary).toBeDefined();
    expect(mockGetFinalEbayPrice).toHaveBeenCalledWith(24.99, { categoryCap: undefined });
  });

  it('uses delivered finalItemCents as fallback when no retailPriceDollars supplied', async () => {
    const dec = buildDecision({ finalItemCents: 900, warnings: ['noPricingData'] });
    mockGetDeliveredPricing.mockResolvedValue(dec as any);

    const result = await getPricingDecision({ brand: 'B', productName: 'P' });

    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.finalItemCents).toBe(900);
    expect(mockGetFinalEbayPrice).not.toHaveBeenCalled();
  });

  it('passes settings and additionalContext through to getDeliveredPricing', async () => {
    mockGetDeliveredPricing.mockResolvedValue(buildDecision() as any);

    await getPricingDecision({
      brand: 'B', productName: 'P',
      settings: { mode: 'fast-sale' }, additionalContext: 'vitamins',
    });

    expect(mockGetDeliveredPricing).toHaveBeenCalledWith('B', 'P', { mode: 'fast-sale' }, 'vitamins');
  });

  it('pricingEvidence.summary is populated from the raw decision', async () => {
    const raw = buildDecision({ finalItemCents: 2500 });
    mockGetDeliveredPricing.mockResolvedValue(raw as any);

    const result = await getPricingDecision({ brand: 'B', productName: 'P' });

    expect(result.pricingEvidence.summary).toBeDefined();
    expect(result.pricingEvidence.finalItemCents).toBe(2500);
  });
});

describe('getPricingDecision — legacy path (no env vars set)', () => {
  beforeEach(() => {
    delete process.env.DELIVERED_PRICING_V2;
    delete process.env.PRICING_MODE;
    jest.clearAllMocks();
  });

  it('routes to getFinalEbayPrice and returns READY status', async () => {
    mockGetCategoryCap.mockReturnValue(35);
    mockGetFinalEbayPrice.mockReturnValue(19.99);

    const result = await getPricingDecision({
      brand: 'TestBrand', productName: 'Test Product',
      retailPriceDollars: 29.99, categoryPath: 'Books',
    });

    expect(mockGetDeliveredPricing).not.toHaveBeenCalled();
    expect(mockGetCategoryCap).toHaveBeenCalledWith('Books');
    expect(mockGetFinalEbayPrice).toHaveBeenCalledWith(29.99, { categoryCap: 35 });
    expect(result.status).toBe('READY');
    expect(result.finalItemCents).toBe(1999);
    expect(result.finalShipCents).toBe(0);
    expect(result.pricingEvidence.source).toBe('legacy');
    expect(result.pricingEvidence.mode).toBe('retail-discount');
    expect(result.pricingEvidence.summary).toBeUndefined();
  });

  it('returns zero price when no retailPriceDollars provided', async () => {
    const result = await getPricingDecision({ brand: 'B', productName: 'P' });
    expect(result.status).toBe('READY');
    expect(result.finalItemCents).toBe(0);
    expect(result.pricingEvidence.summary).toBeUndefined();
    expect(mockGetFinalEbayPrice).not.toHaveBeenCalled();
  });

  it('handles zero retailPriceDollars gracefully', async () => {
    const result = await getPricingDecision({ brand: 'B', productName: 'P', retailPriceDollars: 0 });
    expect(result.finalItemCents).toBe(0);
    expect(mockGetFinalEbayPrice).not.toHaveBeenCalled();
  });
});

describe('getPricingDecision — DELIVERED_PRICING_V2=false [back-compat, deprecated]', () => {
  beforeEach(() => {
    process.env.DELIVERED_PRICING_V2 = 'false';
    delete process.env.PRICING_MODE;
    jest.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.DELIVERED_PRICING_V2;
  });

  it('uses legacy path when DELIVERED_PRICING_V2 is explicitly false', async () => {
    mockGetCategoryCap.mockReturnValue(undefined);
    mockGetFinalEbayPrice.mockReturnValue(12.50);

    const result = await getPricingDecision({ brand: 'B', productName: 'P', retailPriceDollars: 18.0 });

    expect(mockGetDeliveredPricing).not.toHaveBeenCalled();
    expect(result.status).toBe('READY');
    expect(result.finalItemCents).toBe(1250);
    expect(result.pricingEvidence.summary).toBeUndefined();
  });
});
