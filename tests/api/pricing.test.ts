/**
 * Express API — pricing routes
 *
 * Tests:  GET /health
 *         POST /api/pricing/reprice — happy path, missing body fields, auth failure
 */

import http from 'http';
import request from 'supertest';
import { jest } from '@jest/globals';

// ── Mocks (must be declared before importing the app) ─────────────────────────

jest.mock('../../src/lib/auth-user.js', () => ({
  requireUserAuth: jest.fn(),
}));

jest.mock('../../src/lib/pricing/index.js', () => ({
  getPricingDecision: jest.fn(),
}));

jest.mock('../../src/services/price-reduction.service.js', () => ({
  listPriceReductions: jest.fn(),
}));

jest.mock('../../packages/core/src/services/pricing/reduction-update.js', () => ({
  updatePriceReduction: jest.fn(),
  BindingNotFoundError: class BindingNotFoundError extends Error {
    readonly statusCode = 404;
    constructor(msg: string) { super(msg); this.name = 'BindingNotFoundError'; }
  },
  UnauthorizedBindingError: class UnauthorizedBindingError extends Error {
    readonly statusCode = 403;
    constructor(msg: string) { super(msg); this.name = 'UnauthorizedBindingError'; }
  },
  InvalidReductionParamsError: class InvalidReductionParamsError extends Error {
    readonly statusCode = 400;
    constructor(msg: string) { super(msg); this.name = 'InvalidReductionParamsError'; }
  },
}));

jest.mock('../../packages/core/src/services/pricing/tick.js', () => ({
  runPriceTick: jest.fn(),
}));

// ── Module references populated in beforeAll ──────────────────────────────────

let server: http.Server;
let mockRequireUserAuth: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockGetPricingDecision: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockListPriceReductions: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockUpdatePriceReduction: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockRunPriceTick: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

beforeAll(async () => {
  const { app } = await import('../../apps/api/src/index.js');
  server = app.listen(0);

  const authModule = await import('../../src/lib/auth-user.js');
  mockRequireUserAuth = authModule.requireUserAuth as jest.MockedFunction<
    (...args: unknown[]) => Promise<unknown>
  >;

  const pricingModule = await import('../../src/lib/pricing/index.js');
  mockGetPricingDecision = pricingModule.getPricingDecision as jest.MockedFunction<
    (...args: unknown[]) => Promise<unknown>
  >;

  const reductionModule = await import('../../src/services/price-reduction.service.js');
  mockListPriceReductions = reductionModule.listPriceReductions as jest.MockedFunction<
    (...args: unknown[]) => Promise<unknown>
  >;

  const updateModule = await import('../../packages/core/src/services/pricing/reduction-update.js');
  mockUpdatePriceReduction = updateModule.updatePriceReduction as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

  const tickModule = await import('../../packages/core/src/services/pricing/tick.js');
  mockRunPriceTick = tickModule.runPriceTick as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
});

afterAll((done) => { server.close(done); });

// ── Helpers ───────────────────────────────────────────────────────────────────

const MOCK_USER = { sub: 'user|abc', email: 'test@example.com', userId: 'user|abc' };

const MOCK_PRICING_RESULT = {
  finalItemCents: 1499,
  finalShipCents: 0,
  status: 'PRICED' as const,
  warnings: [],
  pricingEvidence: {
    targetDeliveredCents: 1499,
    finalItemCents: 1499,
    finalShipCents: 0,
    ebayCompsCount: 5,
    fallbackUsed: false,
    source: 'delivered-v2' as const,
    mode: 'market-match',
    warnings: [],
    summary: {
      canCompete: true,
      matchConfidence: 'high',
      freeShipApplied: true,
      retailCompsCount: 3,
      amazonPriceCents: 2499,
      walmartPriceCents: null,
      soldMedianDeliveredCents: 1600,
      soldCount: 12,
      shippingEstimateSource: 'smart',
      compsSource: 'ebay',
    },
  },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.resetAllMocks();
  process.env.NODE_ENV = 'test';
});

describe('GET /health', () => {
  it('returns 200 { ok: true }', async () => {
    const res = await request(server).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe('POST /api/pricing/reprice', () => {
  it('returns pricing decision for valid body', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockGetPricingDecision.mockResolvedValue(MOCK_PRICING_RESULT);

    const res = await request(server)
      .post('/api/pricing/reprice')
      .set('Authorization', 'Bearer tok')
      .send({ brand: 'Nintendo', productName: 'Switch' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.suggestedPrice).toBe(14.99);
    expect(res.body.shippingPrice).toBe(0);
    expect(res.body.freeShipping).toBe(true);
    expect(res.body.canCompete).toBe(true);
    expect(res.body.matchConfidence).toBe('high');
    expect(res.body.status).toBe('PRICED');
    expect(res.body.debug.finalItemCents).toBe(1499);
    expect(res.body.debug.ebayCompsCount).toBe(5);
  });

  it('returns 400 when neither brand nor productName is supplied', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);

    const res = await request(server)
      .post('/api/pricing/reprice')
      .set('Authorization', 'Bearer tok')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/brand or productName/i);
    expect(mockGetPricingDecision).not.toHaveBeenCalled();
  });

  it('returns 500 when auth throws', async () => {
    mockRequireUserAuth.mockRejectedValue(new Error('Unauthorized'));

    const res = await request(server)
      .post('/api/pricing/reprice')
      .set('Authorization', 'Bearer bad')
      .send({ brand: 'Test' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Unauthorized');
  });

  it('passes brand and productName to getPricingDecision', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockGetPricingDecision.mockResolvedValue(MOCK_PRICING_RESULT);

    await request(server)
      .post('/api/pricing/reprice')
      .set('Authorization', 'Bearer tok')
      .send({ brand: 'Lego', productName: 'Technic' });

    expect(mockGetPricingDecision).toHaveBeenCalledWith(
      expect.objectContaining({ brand: 'Lego', productName: 'Technic' }),
    );
  });
});

// ── GET /api/pricing/reductions ───────────────────────────────────────────────

describe('GET /api/pricing/reductions', () => {
  const MOCK_REDUCTIONS_RESULT = {
    items: [
      {
        jobId: 'job-1',
        groupId: 'grp-1',
        offerId: 'off-123',
        sku: 'SKU-001',
        currentPrice: 12.99,
        status: 'active',
        auto: { enabled: true, reduceBy: 1, everyDays: 3, minPrice: 8 },
        createdAt: 1700000000000,
        lastReductionAt: null,
        nextReductionAt: 1700259200000,
        reductionCount: 0,
        lastTick: null,
      },
    ],
    summary: { total: 1, active: 1, atFloor: 0, paused: 0, noOffer: 0, totalReductions: 0, totalSaved: 0 },
    timestamp: 1700000000000,
  };

  it('returns 401 when unauthenticated', async () => {
    mockRequireUserAuth.mockRejectedValue(new Error('auth: missing token'));
    const res = await request(server).get('/api/pricing/reductions');
    expect(res.status).toBe(401);
  });

  it('returns 200 with all bindings on happy path', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockListPriceReductions.mockResolvedValue(MOCK_REDUCTIONS_RESULT);

    const res = await request(server)
      .get('/api/pricing/reductions')
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.summary.total).toBe(1);
    expect(mockListPriceReductions).toHaveBeenCalledWith(MOCK_USER.userId, 'all');
  });

  it('passes active status filter when specified', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockListPriceReductions.mockResolvedValue({ ...MOCK_REDUCTIONS_RESULT, items: [] });

    await request(server)
      .get('/api/pricing/reductions?status=active')
      .set('Authorization', 'Bearer tok');

    expect(mockListPriceReductions).toHaveBeenCalledWith(MOCK_USER.userId, 'active');
  });

  it('returns 500 on service error', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockListPriceReductions.mockRejectedValue(new Error('Redis unavailable'));

    const res = await request(server)
      .get('/api/pricing/reductions')
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(500);
  });
});

// ── POST /api/pricing/reductions ────────────────────────────────────────────────
describe('POST /api/pricing/reductions', () => {
  const AUTO_CONFIG = { reduceBy: 1, reduceByType: 'fixed', everyDays: 3, minPrice: 5 };

  it('returns 401 when unauthenticated', async () => {
    mockRequireUserAuth.mockRejectedValue(new Error('auth: missing token'));
    const res = await request(server).post('/api/pricing/reductions').send({});
    expect(res.status).toBe(401);
  });

  it('returns 400 when jobId missing', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const res = await request(server)
      .post('/api/pricing/reductions')
      .set('Authorization', 'Bearer tok')
      .send({ groupId: 'grp-1', auto: AUTO_CONFIG });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/jobId/i);
  });

  it('returns 400 when groupId missing', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const res = await request(server)
      .post('/api/pricing/reductions')
      .set('Authorization', 'Bearer tok')
      .send({ jobId: 'job-1', auto: AUTO_CONFIG });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/groupId/i);
  });

  it('returns 200 with updated binding on happy path', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const binding = { jobId: 'job-1', groupId: 'grp-1', offerId: 'off-1', auto: AUTO_CONFIG };
    mockUpdatePriceReduction.mockResolvedValue(binding);
    const res = await request(server)
      .post('/api/pricing/reductions')
      .set('Authorization', 'Bearer tok')
      .send({ jobId: 'job-1', groupId: 'grp-1', auto: AUTO_CONFIG });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.binding).toMatchObject({ jobId: 'job-1' });
  });

  it('returns 404 when binding not found', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const { BindingNotFoundError } = await import('../../packages/core/src/services/pricing/reduction-update.js');
    mockUpdatePriceReduction.mockRejectedValue(new (BindingNotFoundError as any)('Binding not found'));
    const res = await request(server)
      .post('/api/pricing/reductions')
      .set('Authorization', 'Bearer tok')
      .send({ jobId: 'job-1', groupId: 'grp-1', auto: AUTO_CONFIG });
    expect(res.status).toBe(404);
  });

  it('returns 403 when binding belongs to another user', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const { UnauthorizedBindingError } = await import('../../packages/core/src/services/pricing/reduction-update.js');
    mockUpdatePriceReduction.mockRejectedValue(new (UnauthorizedBindingError as any)('Unauthorized'));
    const res = await request(server)
      .post('/api/pricing/reductions')
      .set('Authorization', 'Bearer tok')
      .send({ jobId: 'job-1', groupId: 'grp-1', auto: AUTO_CONFIG });
    expect(res.status).toBe(403);
  });

  it('returns 500 on unexpected error', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockUpdatePriceReduction.mockRejectedValue(new Error('Redis unavailable'));
    const res = await request(server)
      .post('/api/pricing/reductions')
      .set('Authorization', 'Bearer tok')
      .send({ jobId: 'job-1', groupId: 'grp-1', auto: AUTO_CONFIG });
    expect(res.status).toBe(500);
  });
});

// ── POST /api/pricing/tick ────────────────────────────────────────────────────────
describe('POST /api/pricing/tick', () => {
  it('returns 401 when unauthenticated', async () => {
    mockRequireUserAuth.mockRejectedValue(new Error('auth: missing token'));
    const res = await request(server).post('/api/pricing/tick').send({});
    expect(res.status).toBe(401);
  });

  it('returns 200 with tick result on happy path', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const tickResult = { processed: 2, skipped: 0, errors: 0, dryRun: false, duration: 120, source: 'http' };
    mockRunPriceTick.mockResolvedValue(tickResult);
    const res = await request(server)
      .post('/api/pricing/tick')
      .set('Authorization', 'Bearer tok')
      .send({ dryRun: false });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.processed).toBe(2);
  });

  it('passes dryRun flag to runPriceTick', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockRunPriceTick.mockResolvedValue({ processed: 0, skipped: 0, errors: 0, dryRun: true });
    await request(server)
      .post('/api/pricing/tick')
      .set('Authorization', 'Bearer tok')
      .send({ dryRun: true });
    expect(mockRunPriceTick).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
  });

  it('returns 500 on upstream error', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockRunPriceTick.mockRejectedValue(new Error('Redis down'));
    const res = await request(server)
      .post('/api/pricing/tick')
      .set('Authorization', 'Bearer tok')
      .send({});
    expect(res.status).toBe(500);
  });
});