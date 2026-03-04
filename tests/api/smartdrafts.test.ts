/**
 * Express API — smartdrafts routes
 *
 * Tests:  POST /api/smartdrafts/create-drafts
 *           - happy path returns expected shape
 *           - missing / empty products array → 400
 *           - NEEDS_REVIEW pricing status preserved in response
 *           - per-product error in errors[] without failing whole request
 *           - auth failure → 500
 */

import http from 'http';
import request from 'supertest';
import { jest } from '@jest/globals';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../../src/lib/auth-user.js', () => ({
  requireUserAuth: jest.fn(),
}));

jest.mock('../../src/services/smartdrafts-create-drafts.service.js', () => ({
  createDraftForProduct: jest.fn(),
}));

jest.mock('../../src/services/job-status.service.js', () => ({
  getJobStatus: jest.fn(),
  JobNotFoundError: class JobNotFoundError extends Error {
    readonly statusCode = 404;
    constructor(jobId: string) {
      super(`Job not found: ${jobId}`);
      this.name = 'JobNotFoundError';
    }
  },
}));

jest.mock('../../src/services/smartdrafts-save-drafts.service.js', () => ({
  saveDrafts: jest.fn(),
}));

jest.mock('../../src/services/smartdrafts-get-draft.service.js', () => ({
  getDraft: jest.fn(),
}));

jest.mock('../../src/lib/ebay-client.js', () => ({
  EbayNotConnectedError: class EbayNotConnectedError extends Error {
    statusCode = 400;
    constructor() {
      super('Connect eBay first');
      this.name = 'EbayNotConnectedError';
    }
  },
}));

jest.mock('../../packages/core/src/services/smartdrafts/bg-jobs.js', () => ({
  startCreateDraftsJob: jest.fn(),
  startScanJob: jest.fn(),
  QuotaExceededError: class QuotaExceededError extends Error {
    readonly statusCode = 429;
    constructor(msg: string) { super(msg); this.name = 'QuotaExceededError'; }
  },
  BgInvokeError: class BgInvokeError extends Error {
    readonly statusCode = 502;
    constructor(msg: string) { super(msg); this.name = 'BgInvokeError'; }
  },
}));

jest.mock('../../packages/core/src/services/smartdrafts/reset.js', () => ({
  resetSmartDrafts: jest.fn(),
}));

jest.mock('../../packages/core/src/services/smartdrafts/update-draft.js', () => ({
  updateDraft: jest.fn(),
  InvalidDraftError: class InvalidDraftError extends Error {
    readonly statusCode = 400;
    constructor(msg: string) { super(msg); this.name = 'InvalidDraftError'; }
  },
  EbayApiError: class EbayApiError extends Error {
    statusCode: number;
    body: unknown;
    constructor(statusCode: number, body: unknown) {
      super(`eBay API error ${statusCode}`);
      this.name = 'EbayApiError';
      this.statusCode = statusCode;
      this.body = body;
    }
  },
}));

jest.mock('../../packages/core/src/services/smartdrafts/pairing-v2.js', () => ({
  startPairingV2Job: jest.fn(),
  getPairingV2Status: jest.fn(),
  PairingJobNotFoundError: class PairingJobNotFoundError extends Error {
    readonly statusCode = 404;
    constructor(msg: string) { super(msg); this.name = 'PairingJobNotFoundError'; }
  },
  InvalidPairingParamsError: class InvalidPairingParamsError extends Error {
    readonly statusCode = 400;
    constructor(msg: string) { super(msg); this.name = 'InvalidPairingParamsError'; }
  },
}));

// ── Module references ─────────────────────────────────────────────────────────

let server: http.Server;
let mockRequireUserAuth: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockCreateDraft: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockGetJobStatus: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockSaveDrafts: jest.MockedFunction<(...args: unknown[]) => unknown>;
let mockGetDraft: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockStartCreateDraftsJob: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockStartScanJob: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockResetSmartDrafts: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockUpdateDraft: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockStartPairingV2Job: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockGetPairingV2Status: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

beforeAll(async () => {
  const { app } = await import('../../apps/api/src/index.js');
  server = app.listen(0);

  const authModule = await import('../../src/lib/auth-user.js');
  mockRequireUserAuth = authModule.requireUserAuth as jest.MockedFunction<
    (...args: unknown[]) => Promise<unknown>
  >;

  const svcModule = await import('../../src/services/smartdrafts-create-drafts.service.js');
  mockCreateDraft = svcModule.createDraftForProduct as jest.MockedFunction<
    (...args: unknown[]) => Promise<unknown>
  >;

  const jobStatusModule = await import('../../src/services/job-status.service.js');
  mockGetJobStatus = jobStatusModule.getJobStatus as jest.MockedFunction<
    (...args: unknown[]) => Promise<unknown>
  >;

  const saveDraftsModule = await import('../../src/services/smartdrafts-save-drafts.service.js');
  mockSaveDrafts = saveDraftsModule.saveDrafts as jest.MockedFunction<
    (...args: unknown[]) => unknown
  >;

  const getDraftModule = await import('../../src/services/smartdrafts-get-draft.service.js');
  mockGetDraft = getDraftModule.getDraft as jest.MockedFunction<
    (...args: unknown[]) => Promise<unknown>
  >;

  const bgJobsModule = await import('../../packages/core/src/services/smartdrafts/bg-jobs.js');
  mockStartCreateDraftsJob = bgJobsModule.startCreateDraftsJob as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
  mockStartScanJob = bgJobsModule.startScanJob as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

  const resetModule = await import('../../packages/core/src/services/smartdrafts/reset.js');
  mockResetSmartDrafts = resetModule.resetSmartDrafts as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

  const updateDraftModule = await import('../../packages/core/src/services/smartdrafts/update-draft.js');
  mockUpdateDraft = updateDraftModule.updateDraft as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

  const pairingModule = await import('../../packages/core/src/services/smartdrafts/pairing-v2.js');
  mockStartPairingV2Job = pairingModule.startPairingV2Job as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
  mockGetPairingV2Status = pairingModule.getPairingV2Status as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
});

afterAll((done) => { server.close(done); });

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MOCK_USER = { sub: 'user|abc', userId: 'user|abc', email: 'test@example.com' };

const SAMPLE_PRODUCT = {
  productId: 'prod-001',
  brand: 'Garden of Life',
  product: 'Raw Probiotics Women',
  heroDisplayUrl: 'https://cdn.example.com/img1.jpg',
  backDisplayUrl: 'https://cdn.example.com/img2.jpg',
};

function makeDraft(overrides: Partial<{
  productId: string;
  status: 'READY' | 'NEEDS_REVIEW';
  price: number;
}> = {}) {
  return {
    productId: overrides.productId ?? 'prod-001',
    brand: 'Garden of Life',
    product: 'Raw Probiotics Women',
    title: 'Garden of Life Raw Probiotics Women 90 Capsules',
    description: 'High-potency probiotic.',
    bullets: ['32 strains', '85 billion CFU'],
    aspects: { Brand: ['Garden of Life'] },
    category: { id: '88433', title: 'Vitamins & Dietary Supplements' },
    images: ['https://cdn.example.com/img1.jpg'],
    price: overrides.price ?? 34.99,
    condition: 'NEW',
    status: overrides.status ?? 'READY',
    pricingEvidence: {
      mode: 'market-match',
      targetDeliveredCents: 3499,
      finalItemCents: 3499,
      finalShipCents: 0,
      ebayCompsCount: 5,
      fallbackUsed: false,
      warnings: [],
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.resetAllMocks();
  process.env.NODE_ENV = 'test';
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /api/smartdrafts/create-drafts', () => {
  it('happy path: returns ok=true with drafts and summary', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockCreateDraft.mockResolvedValue(makeDraft());

    const res = await request(server)
      .post('/api/smartdrafts/create-drafts')
      .set('Authorization', 'Bearer tok')
      .send({ products: [SAMPLE_PRODUCT] });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.drafts).toHaveLength(1);
    expect(res.body.drafts[0].productId).toBe('prod-001');
    expect(res.body.drafts[0].status).toBe('READY');
    expect(res.body.summary).toEqual({ total: 1, succeeded: 1, failed: 0 });
    expect(res.body.errors).toBeUndefined();
  });

  it('returns 400 when products array is absent', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);

    const res = await request(server)
      .post('/api/smartdrafts/create-drafts')
      .set('Authorization', 'Bearer tok')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No products provided/i);
    expect(mockCreateDraft).not.toHaveBeenCalled();
  });

  it('returns 400 when products is an empty array', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);

    const res = await request(server)
      .post('/api/smartdrafts/create-drafts')
      .set('Authorization', 'Bearer tok')
      .send({ products: [] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No products provided/i);
  });

  it('preserves NEEDS_REVIEW pricing status in draft response', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockCreateDraft.mockResolvedValue(makeDraft({ status: 'NEEDS_REVIEW', price: 12.49 }));

    const res = await request(server)
      .post('/api/smartdrafts/create-drafts')
      .set('Authorization', 'Bearer tok')
      .send({ products: [SAMPLE_PRODUCT] });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.drafts[0].status).toBe('NEEDS_REVIEW');
    expect(res.body.drafts[0].price).toBe(12.49);
    // NEEDS_REVIEW draft is included — not blocked — but caller must not auto-publish
    expect(res.body.summary.succeeded).toBe(1);
  });

  it('puts per-product failures into errors[] without failing the request', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockCreateDraft
      .mockResolvedValueOnce(makeDraft({ productId: 'prod-001' }))
      .mockRejectedValueOnce(new Error('OpenAI timeout'));

    const res = await request(server)
      .post('/api/smartdrafts/create-drafts')
      .set('Authorization', 'Bearer tok')
      .send({ products: [SAMPLE_PRODUCT, { ...SAMPLE_PRODUCT, productId: 'prod-002' }] });

    expect(res.status).toBe(200);
    expect(res.body.drafts).toHaveLength(1);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].productId).toBe('prod-002');
    expect(res.body.errors[0].error).toBe('OpenAI timeout');
    expect(res.body.summary).toEqual({ total: 2, succeeded: 1, failed: 1 });
  });

  it('forwards pricing decision to createDraftForProduct via service', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockCreateDraft.mockResolvedValue(makeDraft());

    await request(server)
      .post('/api/smartdrafts/create-drafts')
      .set('Authorization', 'Bearer tok')
      .send({ products: [SAMPLE_PRODUCT] });

    expect(mockCreateDraft).toHaveBeenCalledWith(
      expect.objectContaining({ productId: 'prod-001', brand: 'Garden of Life' }),
    );
  });

  it('returns 500 when auth throws', async () => {
    mockRequireUserAuth.mockRejectedValue(new Error('Bad token'));

    const res = await request(server)
      .post('/api/smartdrafts/create-drafts')
      .set('Authorization', 'Bearer bad')
      .send({ products: [SAMPLE_PRODUCT] });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Bad token');
  });
});

describe('POST /api/smartdrafts/scan', () => {
  it('returns 400 when path is missing', async () => {
    mockRequireUserAuth.mockResolvedValue({ userId: 'u1', sub: 'u1', email: 'u@test.com' });
    const res = await request(server).post('/api/smartdrafts/scan').send({});
    expect(res.status).toBe(400);
  });
});

// ── GET /api/smartdrafts/create-drafts/status ─────────────────────────────────

describe('GET /api/smartdrafts/create-drafts/status', () => {
  it('returns 401 when unauthenticated', async () => {
    mockRequireUserAuth.mockRejectedValue(new Error('auth: missing token'));
    const res = await request(server).get('/api/smartdrafts/create-drafts/status?jobId=j1');
    expect(res.status).toBe(401);
  });

  it('returns 400 when jobId is missing', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const res = await request(server)
      .get('/api/smartdrafts/create-drafts/status')
      .set('Authorization', 'Bearer tok');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/jobId/i);
  });

  it('returns 200 with job on happy path', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockGetJobStatus.mockResolvedValue({ ok: true, job: { state: 'complete', progress: 100 } });

    const res = await request(server)
      .get('/api/smartdrafts/create-drafts/status?jobId=job-abc')
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, job: expect.objectContaining({ state: 'complete' }) });
    expect(mockGetJobStatus).toHaveBeenCalledWith(MOCK_USER.userId, 'job-abc');
  });

  it('returns 404 when job not found', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const jobStatusModule = await import('../../src/services/job-status.service.js');
    mockGetJobStatus.mockRejectedValue(
      new (jobStatusModule.JobNotFoundError as any)('job-xyz'),
    );

    const res = await request(server)
      .get('/api/smartdrafts/create-drafts/status?jobId=job-xyz')
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Job not found/i);
  });
});

// ── GET /api/smartdrafts/scan/status ─────────────────────────────────────────

describe('GET /api/smartdrafts/scan/status', () => {
  it('returns 401 when unauthenticated', async () => {
    mockRequireUserAuth.mockRejectedValue(new Error('auth: missing token'));
    const res = await request(server).get('/api/smartdrafts/scan/status?jobId=j1');
    expect(res.status).toBe(401);
  });

  it('returns 400 when jobId is missing', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const res = await request(server)
      .get('/api/smartdrafts/scan/status')
      .set('Authorization', 'Bearer tok');
    expect(res.status).toBe(400);
  });

  it('returns 200 with job on happy path', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockGetJobStatus.mockResolvedValue({ ok: true, job: { state: 'running', progress: 50 } });

    const res = await request(server)
      .get('/api/smartdrafts/scan/status?jobId=scan-job-1')
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(200);
    expect(res.body.job.state).toBe('running');
  });
});

// ── POST /api/smartdrafts/drafts ──────────────────────────────────────────────

describe('POST /api/smartdrafts/drafts', () => {
  const SAMPLE_CHATGPT_DRAFT = {
    productId: 'prod-001',
    brand: 'Garden of Life',
    product: 'Raw Probiotics',
    title: 'Garden of Life Raw Probiotics',
    description: 'High-potency probiotic.',
    bullets: ['32 strains'],
    aspects: { Brand: ['Garden of Life'] },
    category: { id: '88433', title: 'Vitamins' },
    images: ['https://cdn.example.com/img1.jpg'],
    price: 34.99,
    condition: 'NEW',
  };

  it('returns 401 when unauthenticated', async () => {
    mockRequireUserAuth.mockRejectedValue(new Error('auth: missing token'));
    const res = await request(server).post('/api/smartdrafts/drafts').send({});
    expect(res.status).toBe(401);
  });

  it('returns 400 when jobId is missing', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const res = await request(server)
      .post('/api/smartdrafts/drafts')
      .set('Authorization', 'Bearer tok')
      .send({ drafts: [SAMPLE_CHATGPT_DRAFT] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/jobId/i);
  });

  it('returns 400 when drafts array is missing', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const res = await request(server)
      .post('/api/smartdrafts/drafts')
      .set('Authorization', 'Bearer tok')
      .send({ jobId: 'job-1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/drafts/i);
  });

  it('returns 200 with converted groups on happy path', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const mockResult = { ok: true, groups: [{ sku: 'GOL123' }], count: 1, jobId: 'job-1' };
    mockSaveDrafts.mockReturnValue(mockResult);

    const res = await request(server)
      .post('/api/smartdrafts/drafts')
      .set('Authorization', 'Bearer tok')
      .send({ jobId: 'job-1', drafts: [SAMPLE_CHATGPT_DRAFT] });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, count: 1, jobId: 'job-1' });
    expect(mockSaveDrafts).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-1', drafts: expect.any(Array) }),
    );
  });
});

// ── GET /api/smartdrafts/drafts ───────────────────────────────────────────────

describe('GET /api/smartdrafts/drafts', () => {
  const MOCK_DRAFT = {
    sku: 'SKU-001',
    title: 'Test Product',
    description: 'Great item.',
    price: 9.99,
    condition: 'NEW',
    aspects: {},
    images: [],
    categoryId: '11116',
    offerId: 'off-123',
    categoryAspects: [],
    weight: null,
    bestOffer: { enabled: false },
  };

  it('returns 401 when unauthenticated', async () => {
    mockRequireUserAuth.mockRejectedValue(new Error('auth: missing token'));
    const res = await request(server).get('/api/smartdrafts/drafts?offerId=off-123');
    expect(res.status).toBe(401);
  });

  it('returns 400 when offerId is missing', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const res = await request(server)
      .get('/api/smartdrafts/drafts')
      .set('Authorization', 'Bearer tok');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/offerId/i);
  });

  it('returns 200 with draft on happy path', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockGetDraft.mockResolvedValue({ ok: true, draft: MOCK_DRAFT });

    const res = await request(server)
      .get('/api/smartdrafts/drafts?offerId=off-123')
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, draft: expect.objectContaining({ offerId: 'off-123' }) });
    expect(mockGetDraft).toHaveBeenCalledWith(MOCK_USER.userId, 'off-123');
  });

  it('returns 400 when eBay not connected', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const { EbayNotConnectedError } = await import('../../src/lib/ebay-client.js');
    mockGetDraft.mockRejectedValue(new (EbayNotConnectedError as any)());

    const res = await request(server)
      .get('/api/smartdrafts/drafts?offerId=off-123')
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Connect eBay/i);
  });

  it('returns 500 on upstream error', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockGetDraft.mockRejectedValue(new Error('eBay API timeout'));

    const res = await request(server)
      .get('/api/smartdrafts/drafts?offerId=off-123')
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(500);
  });
});

// ── POST /api/smartdrafts/create-drafts/start ─────────────────────────────────

describe('POST /api/smartdrafts/create-drafts/start', () => {
  const PRODUCTS = [{ productId: 'p1', title: 'Item', price: 10 }];

  it('returns 401 when unauthenticated', async () => {
    mockRequireUserAuth.mockRejectedValue(new Error('auth: missing token'));
    const res = await request(server).post('/api/smartdrafts/create-drafts/start').send({ products: PRODUCTS });
    expect(res.status).toBe(401);
  });

  it('returns 400 when products is empty', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const res = await request(server)
      .post('/api/smartdrafts/create-drafts/start')
      .set('Authorization', 'Bearer tok')
      .send({ products: [] });
    expect(res.status).toBe(400);
  });

  it('returns 202 with jobId on happy path', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockStartCreateDraftsJob.mockResolvedValue({ jobId: 'job-bg-1' });
    const res = await request(server)
      .post('/api/smartdrafts/create-drafts/start')
      .set('Authorization', 'Bearer tok')
      .send({ products: PRODUCTS, promotion: { enabled: false, rate: null } });
    expect(res.status).toBe(202);
    expect(res.body.jobId).toBe('job-bg-1');
  });

  it('returns 429 when quota exceeded', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const { QuotaExceededError } = await import('../../packages/core/src/services/smartdrafts/bg-jobs.js');
    mockStartCreateDraftsJob.mockRejectedValue(new (QuotaExceededError as any)('quota exceeded'));
    const res = await request(server)
      .post('/api/smartdrafts/create-drafts/start')
      .set('Authorization', 'Bearer tok')
      .send({ products: PRODUCTS });
    expect(res.status).toBe(429);
  });
});

// ── POST /api/smartdrafts/scan/start ─────────────────────────────────────────

describe('POST /api/smartdrafts/scan/start', () => {
  it('returns 400 when jobId missing', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const res = await request(server)
      .post('/api/smartdrafts/scan/start')
      .set('Authorization', 'Bearer tok')
      .send({ files: ['img1.jpg'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/jobId/i);
  });

  it('returns 400 when files is empty', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const res = await request(server)
      .post('/api/smartdrafts/scan/start')
      .set('Authorization', 'Bearer tok')
      .send({ jobId: 'job-1', files: [] });
    expect(res.status).toBe(400);
  });

  it('returns 202 with jobId on happy path', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockStartScanJob.mockResolvedValue({ jobId: 'job-scan-1' });
    const res = await request(server)
      .post('/api/smartdrafts/scan/start')
      .set('Authorization', 'Bearer tok')
      .send({ jobId: 'job-1', files: ['img1.jpg', 'img2.jpg'] });
    expect(res.status).toBe(202);
    expect(res.body.jobId).toBe('job-scan-1');
  });
});

// ── POST /api/smartdrafts/reset ───────────────────────────────────────────────

describe('POST /api/smartdrafts/reset', () => {
  it('returns 401 when unauthenticated', async () => {
    mockRequireUserAuth.mockRejectedValue(new Error('auth: missing token'));
    const res = await request(server).post('/api/smartdrafts/reset').send({});
    expect(res.status).toBe(401);
  });

  it('returns 200 with cleared count on happy path', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockResetSmartDrafts.mockResolvedValue({ cleared: 5 });
    const res = await request(server)
      .post('/api/smartdrafts/reset')
      .set('Authorization', 'Bearer tok')
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.cleared).toBe(5);
  });
});

// ── PUT /api/smartdrafts/drafts/:offerId ──────────────────────────────────────

describe('PUT /api/smartdrafts/drafts/:offerId', () => {
  it('returns 401 when unauthenticated', async () => {
    mockRequireUserAuth.mockRejectedValue(new Error('auth: missing token'));
    const res = await request(server).put('/api/smartdrafts/drafts/off-123').send({});
    expect(res.status).toBe(401);
  });

  it('returns 200 on happy path', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockUpdateDraft.mockResolvedValue({ ok: true });
    const res = await request(server)
      .put('/api/smartdrafts/drafts/off-123')
      .set('Authorization', 'Bearer tok')
      .send({ title: 'New Title', price: 15.99 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('returns 400 on invalid draft data', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const { InvalidDraftError } = await import('../../packages/core/src/services/smartdrafts/update-draft.js');
    mockUpdateDraft.mockRejectedValue(new (InvalidDraftError as any)('price must be positive'));
    const res = await request(server)
      .put('/api/smartdrafts/drafts/off-123')
      .set('Authorization', 'Bearer tok')
      .send({ price: -5 });
    expect(res.status).toBe(400);
  });

  it('returns 500 on upstream error', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockUpdateDraft.mockRejectedValue(new Error('eBay timeout'));
    const res = await request(server)
      .put('/api/smartdrafts/drafts/off-123')
      .set('Authorization', 'Bearer tok')
      .send({ title: 'T' });
    expect(res.status).toBe(500);
  });
});

// ── POST /api/smartdrafts/pairing/v2/start ───────────────────────────────────

describe('POST /api/smartdrafts/pairing/v2/start', () => {
  it('returns 400 when jobId missing', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const res = await request(server)
      .post('/api/smartdrafts/pairing/v2/start')
      .set('Authorization', 'Bearer tok')
      .send({ items: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/jobId/i);
  });

  it('returns 202 with jobId on happy path', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockStartPairingV2Job.mockResolvedValue({ jobId: 'pairing-job-1' });
    const res = await request(server)
      .post('/api/smartdrafts/pairing/v2/start')
      .set('Authorization', 'Bearer tok')
      .send({ jobId: 'job-1', items: [{ id: 'img1' }] });
    expect(res.status).toBe(202);
    expect(res.body.jobId).toBe('pairing-job-1');
  });
});

// ── GET /api/smartdrafts/pairing/v2/status ───────────────────────────────────

describe('GET /api/smartdrafts/pairing/v2/status', () => {
  it('returns 400 when jobId missing', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const res = await request(server)
      .get('/api/smartdrafts/pairing/v2/status')
      .set('Authorization', 'Bearer tok');
    expect(res.status).toBe(400);
  });

  it('returns 200 with job status on happy path', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockGetPairingV2Status.mockResolvedValue({ jobId: 'pairing-job-1', state: 'complete', pairs: [], unpaired: [] });
    const res = await request(server)
      .get('/api/smartdrafts/pairing/v2/status?jobId=pairing-job-1')
      .set('Authorization', 'Bearer tok');
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('complete');
  });

  it('returns 404 when job not found', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const { PairingJobNotFoundError } = await import('../../packages/core/src/services/smartdrafts/pairing-v2.js');
    mockGetPairingV2Status.mockRejectedValue(new (PairingJobNotFoundError as any)('not found'));
    const res = await request(server)
      .get('/api/smartdrafts/pairing/v2/status?jobId=bad-job')
      .set('Authorization', 'Bearer tok');
    expect(res.status).toBe(404);
  });
});
