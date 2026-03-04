/**
 * Express API — listings routes
 *
 * Tests:  GET /api/listings/plan
 *           - happy path: returns plan object
 *           - missing sku → 400
 *           - Dropbox not connected → 400
 *           - SKU not found → 404
 *           - auth failure → 401
 *           - service error → 500
 */

import http from 'http';
import request from 'supertest';
import { jest } from '@jest/globals';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../../src/lib/auth-user.js', () => ({
  requireUserAuth: jest.fn(),
}));

jest.mock('../../src/services/listing-plan.service.js', () => ({
  getListingPlan: jest.fn(),
  DropboxNotConnectedError: class DropboxNotConnectedError extends Error {
    readonly statusCode = 400;
    constructor() {
      super('Connect Dropbox first');
      this.name = 'DropboxNotConnectedError';
    }
  },
  SkuNotFoundError: class SkuNotFoundError extends Error {
    readonly statusCode = 404;
    constructor(sku: string) {
      super(`No files found for SKU: ${sku}`);
      this.name = 'SkuNotFoundError';
    }
  },
}));

jest.mock('../../packages/core/src/services/listings/bind.js', () => ({
  bindListingEntry: jest.fn(),
  getBinding: jest.fn(),
  getJobBindings: jest.fn(),
  deleteBinding: jest.fn(),
}));

// ── Module references ─────────────────────────────────────────────────────────

let server: http.Server;
let mockRequireUserAuth: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockGetListingPlan: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockBindListingEntry: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockGetBinding: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockGetJobBindings: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockDeleteBinding: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

beforeAll(async () => {
  const { app } = await import('../../apps/api/src/index.js');
  server = app.listen(0);

  const authModule = await import('../../src/lib/auth-user.js');
  mockRequireUserAuth = authModule.requireUserAuth as jest.MockedFunction<
    (...args: unknown[]) => Promise<unknown>
  >;

  const planModule = await import('../../src/services/listing-plan.service.js');
  mockGetListingPlan = planModule.getListingPlan as jest.MockedFunction<
    (...args: unknown[]) => Promise<unknown>
  >;

  const bindModule = await import('../../packages/core/src/services/listings/bind.js');
  mockBindListingEntry = bindModule.bindListingEntry as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
  mockGetBinding = bindModule.getBinding as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
  mockGetJobBindings = bindModule.getJobBindings as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
  mockDeleteBinding = bindModule.deleteBinding as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
});;

afterAll((done) => { server.close(done); });

// ── Helpers ───────────────────────────────────────────────────────────────────

const MOCK_USER = { sub: 'user|abc', userId: 'user|abc' };

const MOCK_PLAN = {
  sku: 'ABC123',
  folder: '/EBAY',
  images: ['https://dl.dropboxusercontent.com/img1.jpg'],
  pricing: { basePrice: 20, ebayPrice: 24.99, floorPrice: 19.99, markdown: { everyDays: 3, amount: 1, stopAt: 19.99 }, promotePercent: 2 },
  draftPayloadTemplate: { sku: 'ABC123', images: [], price: 24.99, qty: 1, marketplaceId: 'EBAY_US' },
};

beforeEach(() => {
  jest.resetAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/listings/plan', () => {
  it('returns 401 when unauthenticated', async () => {
    mockRequireUserAuth.mockRejectedValue(new Error('auth: missing token'));
    const res = await request(server).get('/api/listings/plan?sku=ABC123');
    expect(res.status).toBe(401);
  });

  it('returns 400 when sku is missing', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const res = await request(server)
      .get('/api/listings/plan')
      .set('Authorization', 'Bearer tok');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sku/i);
  });

  it('returns 200 with plan on happy path', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockGetListingPlan.mockResolvedValue(MOCK_PLAN);

    const res = await request(server)
      .get('/api/listings/plan?sku=ABC123&folder=/EBAY')
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, plan: expect.objectContaining({ sku: 'ABC123' }) });
    expect(mockGetListingPlan).toHaveBeenCalledWith('ABC123', '/EBAY', expect.anything());
  });

  it('returns 400 when Dropbox is not connected', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const { DropboxNotConnectedError } = await import('../../src/services/listing-plan.service.js');
    mockGetListingPlan.mockRejectedValue(new (DropboxNotConnectedError as any)());

    const res = await request(server)
      .get('/api/listings/plan?sku=ABC123')
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Connect Dropbox/i);
  });

  it('returns 404 when SKU files are not found', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const { SkuNotFoundError } = await import('../../src/services/listing-plan.service.js');
    mockGetListingPlan.mockRejectedValue(new (SkuNotFoundError as any)('XYZ999'));

    const res = await request(server)
      .get('/api/listings/plan?sku=XYZ999')
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/XYZ999/i);
  });

  it('returns 500 on unexpected service error', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockGetListingPlan.mockRejectedValue(new Error('Dropbox API rate limit'));

    const res = await request(server)
      .get('/api/listings/plan?sku=ABC123')
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(500);
  });

  it('uses /EBAY as default folder when not specified', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockGetListingPlan.mockResolvedValue(MOCK_PLAN);

    await request(server)
      .get('/api/listings/plan?sku=ABC123')
      .set('Authorization', 'Bearer tok');

    expect(mockGetListingPlan).toHaveBeenCalledWith('ABC123', '/EBAY', expect.anything());
  });
});

// ── GET /api/listings/bind ────────────────────────────────────────────────────

describe('GET /api/listings/bind', () => {
  it('returns 401 when unauthenticated', async () => {
    mockRequireUserAuth.mockRejectedValue(new Error('auth: missing token'));
    const res = await request(server).get('/api/listings/bind?jobId=job-1');
    expect(res.status).toBe(401);
  });

  it('returns 400 when jobId is missing', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const res = await request(server)
      .get('/api/listings/bind')
      .set('Authorization', 'Bearer tok');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/jobId/i);
  });

  it('returns single binding when groupId is provided', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const binding = { jobId: 'job-1', groupId: 'grp-1', offerId: 'off-1', sku: 'SKU-001', currentPrice: 10 };
    mockGetBinding.mockResolvedValue(binding);
    const res = await request(server)
      .get('/api/listings/bind?jobId=job-1&groupId=grp-1')
      .set('Authorization', 'Bearer tok');
    expect(res.status).toBe(200);
    expect(res.body.binding).toMatchObject({ offerId: 'off-1' });
  });

  it('returns all job bindings when groupId is omitted', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockGetJobBindings.mockResolvedValue([{ jobId: 'job-1', groupId: 'grp-1' }]);
    const res = await request(server)
      .get('/api/listings/bind?jobId=job-1')
      .set('Authorization', 'Bearer tok');
    expect(res.status).toBe(200);
    expect(res.body.bindings).toHaveLength(1);
  });

  it('returns 500 on service error', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockGetJobBindings.mockRejectedValue(new Error('Redis unavailable'));
    const res = await request(server)
      .get('/api/listings/bind?jobId=job-1')
      .set('Authorization', 'Bearer tok');
    expect(res.status).toBe(500);
  });
});

// ── POST /api/listings/bind ───────────────────────────────────────────────────

describe('POST /api/listings/bind', () => {
  it('returns 401 when unauthenticated', async () => {
    mockRequireUserAuth.mockRejectedValue(new Error('auth: missing token'));
    const res = await request(server).post('/api/listings/bind').send({ jobId: 'j', groupId: 'g' });
    expect(res.status).toBe(401);
  });

  it('returns 400 when jobId missing', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const res = await request(server)
      .post('/api/listings/bind')
      .set('Authorization', 'Bearer tok')
      .send({ groupId: 'grp-1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/jobId/i);
  });

  it('creates binding on happy path', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockBindListingEntry.mockResolvedValue({ ok: true });
    const res = await request(server)
      .post('/api/listings/bind')
      .set('Authorization', 'Bearer tok')
      .send({ jobId: 'job-1', groupId: 'grp-1', offerId: 'off-1', sku: 'SKU-001' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ── DELETE /api/listings/bind ─────────────────────────────────────────────────

describe('DELETE /api/listings/bind', () => {
  it('returns 401 when unauthenticated', async () => {
    mockRequireUserAuth.mockRejectedValue(new Error('auth: missing token'));
    const res = await request(server).delete('/api/listings/bind?jobId=j&groupId=g');
    expect(res.status).toBe(401);
  });

  it('returns 400 when jobId missing', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const res = await request(server)
      .delete('/api/listings/bind?groupId=grp-1')
      .set('Authorization', 'Bearer tok');
    expect(res.status).toBe(400);
  });

  it('deletes binding on happy path', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockDeleteBinding.mockResolvedValue(undefined);
    const res = await request(server)
      .delete('/api/listings/bind?jobId=job-1&groupId=grp-1')
      .set('Authorization', 'Bearer tok');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
