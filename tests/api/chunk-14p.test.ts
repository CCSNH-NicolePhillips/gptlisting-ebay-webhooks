/**
 * tests/api/chunk-14p.test.ts
 *
 * Chunk 14P — 8 new Express endpoints:
 *
 *   GET    /api/ebay/offers/:id/thumb
 *   GET    /api/images/verify
 *   GET    /api/images
 *   POST   /api/ingest/local/init
 *   POST   /api/ingest/local/complete
 *   POST   /api/ingest/dropbox
 *   GET    /api/smartdrafts/analyze
 *   POST   /api/smartdrafts/pairing/v2/start-local
 */

import http from 'http';
import request from 'supertest';
import { jest } from '@jest/globals';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../../src/lib/auth-user.js', () => ({
  requireUserAuth: jest.fn(),
}));

// eBay offer-thumb
jest.mock('../../packages/core/src/services/ebay/offer-thumb.service.js', () => ({
  getOfferThumbnail: jest.fn(),
  OfferThumbAuthError: class OfferThumbAuthError extends Error {
    readonly statusCode = 401;
    constructor(msg = 'Unauthorized') { super(msg); this.name = 'OfferThumbAuthError'; }
  },
  OfferThumbUpstreamError: class OfferThumbUpstreamError extends Error {
    readonly statusCode: number;
    constructor(msg: string, statusCode: number) { super(msg); this.name = 'OfferThumbUpstreamError'; this.statusCode = statusCode; }
  },
}));

// images/verify
jest.mock('../../packages/core/src/services/images/verify-image.service.js', () => ({
  verifyImage: jest.fn(),
  VerifyImageError: class VerifyImageError extends Error {
    readonly statusCode = 502;
    constructor(msg: string) { super(msg); this.name = 'VerifyImageError'; }
  },
}));

// ingest/local-init
jest.mock('../../packages/core/src/services/ingest/local-init.service.js', () => ({
  initLocalUpload: jest.fn(),
  LocalInitError: class LocalInitError extends Error {
    readonly statusCode: number;
    readonly code?: string;
    constructor(msg: string, statusCode: number, code?: string) {
      super(msg); this.name = 'LocalInitError'; this.statusCode = statusCode; this.code = code;
    }
  },
}));

// ingest/local-complete
jest.mock('../../packages/core/src/services/ingest/local-complete.service.js', () => ({
  completeLocalUpload: jest.fn(),
  LocalCompleteError: class LocalCompleteError extends Error {
    readonly statusCode: number;
    readonly code?: string;
    constructor(msg: string, statusCode: number, code?: string) {
      super(msg); this.name = 'LocalCompleteError'; this.statusCode = statusCode; this.code = code;
    }
  },
}));

// ingest/dropbox-list
jest.mock('../../packages/core/src/services/ingest/dropbox-list.service.js', () => ({
  listDropboxFiles: jest.fn(),
  DropboxListError: class DropboxListError extends Error {
    readonly statusCode: number;
    readonly code?: string;
    constructor(msg: string, statusCode: number, code?: string) {
      super(msg); this.name = 'DropboxListError'; this.statusCode = statusCode; this.code = code;
    }
  },
}));

// smartdrafts bg-jobs (startScanJob)
jest.mock('../../packages/core/src/services/smartdrafts/bg-jobs.js', () => ({
  startScanJob: jest.fn(),
  startCreateDraftsJob: jest.fn(),
  QuotaExceededError: class QuotaExceededError extends Error {
    constructor(msg = 'Quota exceeded') { super(msg); this.name = 'QuotaExceededError'; }
  },
  BgInvokeError: class BgInvokeError extends Error {
    constructor(msg = 'BgInvoke failed') { super(msg); this.name = 'BgInvokeError'; }
  },
}));

// job-status service
jest.mock('../../src/services/job-status.service.js', () => ({
  getJobStatus: jest.fn(),
  JobNotFoundError: class JobNotFoundError extends Error {
    readonly statusCode = 404;
    constructor(msg = 'Job not found') { super(msg); this.name = 'JobNotFoundError'; }
  },
}));

// job-status normalizer
jest.mock('../../src/lib/jobs/job-status.js', () => ({
  normalizeJobStatus: jest.fn(),
}));

// pairing-v2
jest.mock('../../packages/core/src/services/smartdrafts/pairing-v2.js', () => ({
  startPairingV2Job: jest.fn(),
  getPairingV2Status: jest.fn(),
  PairingJobNotFoundError: class PairingJobNotFoundError extends Error {
    readonly statusCode = 404;
    constructor(msg = 'Pairing job not found') { super(msg); this.name = 'PairingJobNotFoundError'; }
  },
  InvalidPairingParamsError: class InvalidPairingParamsError extends Error {
    constructor(msg = 'Invalid params') { super(msg); this.name = 'InvalidPairingParamsError'; }
  },
}));

// ── Other service mocks needed by the router (pre-existing routes) ────────────

jest.mock('../../src/services/smartdrafts-create-drafts.service.js', () => ({
  createDraftForProduct: jest.fn(),
}));
jest.mock('../../src/services/smartdrafts-save-drafts.service.js', () => ({
  saveDrafts: jest.fn(),
}));
jest.mock('../../src/services/smartdrafts-get-draft.service.js', () => ({
  getDraft: jest.fn(),
}));
jest.mock('../../packages/core/src/services/smartdrafts/reset.js', () => ({
  resetSmartDrafts: jest.fn(),
}));
jest.mock('../../packages/core/src/services/smartdrafts/update-draft.js', () => ({
  updateDraft: jest.fn(),
  InvalidDraftError: class InvalidDraftError extends Error {
    readonly statusCode = 400;
    constructor(msg = '') { super(msg); this.name = 'InvalidDraftError'; }
  },
  EbayApiError: class EbayApiError extends Error {
    readonly statusCode: number;
    constructor(msg: string, statusCode = 500) { super(msg); this.name = 'EbayApiError'; this.statusCode = statusCode; }
  },
}));
jest.mock('../../src/lib/ebay-client.js', () => ({
  EbayNotConnectedError: class EbayNotConnectedError extends Error {
    statusCode = 400;
    constructor() { super('Connect eBay first'); this.name = 'EbayNotConnectedError'; }
  },
}));

// ── Server + mock refs ────────────────────────────────────────────────────────

let server: http.Server;
let mockRequireUserAuth: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockGetOfferThumbnail: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockVerifyImage: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockInitLocalUpload: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockCompleteLocalUpload: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockListDropboxFiles: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockStartScanJob: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockGetJobStatus: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockNormalizeJobStatus: jest.MockedFunction<(...args: unknown[]) => unknown>;
let mockStartPairingV2Job: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

beforeAll(async () => {
  const { app } = await import('../../apps/api/src/index.js');
  server = app.listen(0);

  const authModule = await import('../../src/lib/auth-user.js');
  mockRequireUserAuth = authModule.requireUserAuth as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

  const thumbModule = await import('../../packages/core/src/services/ebay/offer-thumb.service.js');
  mockGetOfferThumbnail = thumbModule.getOfferThumbnail as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

  const verifyModule = await import('../../packages/core/src/services/images/verify-image.service.js');
  mockVerifyImage = verifyModule.verifyImage as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

  const initModule = await import('../../packages/core/src/services/ingest/local-init.service.js');
  mockInitLocalUpload = initModule.initLocalUpload as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

  const completeModule = await import('../../packages/core/src/services/ingest/local-complete.service.js');
  mockCompleteLocalUpload = completeModule.completeLocalUpload as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

  const dropboxModule = await import('../../packages/core/src/services/ingest/dropbox-list.service.js');
  mockListDropboxFiles = dropboxModule.listDropboxFiles as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

  const bgJobsModule = await import('../../packages/core/src/services/smartdrafts/bg-jobs.js');
  mockStartScanJob = bgJobsModule.startScanJob as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

  const jobStatusModule = await import('../../src/services/job-status.service.js');
  mockGetJobStatus = jobStatusModule.getJobStatus as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

  const normalizeModule = await import('../../src/lib/jobs/job-status.js');
  mockNormalizeJobStatus = normalizeModule.normalizeJobStatus as jest.MockedFunction<(...args: unknown[]) => unknown>;

  const pairingModule = await import('../../packages/core/src/services/smartdrafts/pairing-v2.js');
  mockStartPairingV2Job = pairingModule.startPairingV2Job as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
});

afterAll((done) => { server.close(done); });

beforeEach(() => {
  jest.resetAllMocks();
  process.env.NODE_ENV = 'test';
});

const MOCK_USER = { sub: 'user|abc', email: 'test@example.com', userId: 'user|abc' };

// ─── GET /api/ebay/offers/:id/thumb ───────────────────────────────────────────

describe('GET /api/ebay/offers/:id/thumb', () => {
  it('returns binary image bytes (200) when thumbnail resolves', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const buf = Buffer.from('FAKEPNG');
    mockGetOfferThumbnail.mockResolvedValue({
      type: 'binary',
      buffer: buf,
      contentType: 'image/png',
      cacheControl: 'public, max-age=300',
    });

    const res = await request(server)
      .get('/api/ebay/offers/OFFER123/thumb')
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/png/);
  });

  it('returns 200 JSON { redirect } when image is too large', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockGetOfferThumbnail.mockResolvedValue({
      type: 'redirect',
      url: 'https://example.com/big-image.jpg',
    });

    const res = await request(server)
      .get('/api/ebay/offers/OFFER456/thumb')
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ redirect: 'https://example.com/big-image.jpg' });
  });

  it('returns 204 when no image exists for offer', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockGetOfferThumbnail.mockResolvedValue({ type: 'empty' });

    const res = await request(server)
      .get('/api/ebay/offers/OFFER789/thumb')
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(204);
  });

  it('returns 401 when eBay is not connected', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const { OfferThumbAuthError } = await import(
      '../../packages/core/src/services/ebay/offer-thumb.service.js'
    );
    mockGetOfferThumbnail.mockRejectedValue(new OfferThumbAuthError('Connect eBay first'));

    const res = await request(server)
      .get('/api/ebay/offers/OFFER000/thumb')
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: expect.any(String) });
  });

  it('returns 401 when not authenticated', async () => {
    mockRequireUserAuth.mockRejectedValue(new Error('Unauthorized'));

    const res = await request(server).get('/api/ebay/offers/OFFER000/thumb');
    expect(res.status).toBe(401);
  });
});

// ─── GET /api/images/verify ───────────────────────────────────────────────────

describe('GET /api/images/verify', () => {
  it('returns 200 with metadata when URL is a valid image', async () => {
    const result = {
      ok: true,
      status: 200,
      contentType: 'image/jpeg',
      contentLength: '12345',
      sizeBytes: 12345,
      finalUrl: 'https://example.com/image.jpg',
    };
    mockVerifyImage.mockResolvedValue(result);

    const res = await request(server)
      .get('/api/images/verify')
      .query({ url: 'https://example.com/image.jpg' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, contentType: 'image/jpeg' });
  });

  it('returns 422 when URL is not an image', async () => {
    mockVerifyImage.mockResolvedValue({
      ok: false,
      status: 200,
      contentType: 'text/html',
      contentLength: '500',
      sizeBytes: 500,
      finalUrl: 'https://example.com/page.html',
    });

    const res = await request(server)
      .get('/api/images/verify')
      .query({ url: 'https://example.com/page.html' });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ ok: false });
  });

  it('returns 400 when url query param is missing', async () => {
    const res = await request(server).get('/api/images/verify');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining('url') });
  });

  it('returns 502 on upstream network failure', async () => {
    const { VerifyImageError } = await import(
      '../../packages/core/src/services/images/verify-image.service.js'
    );
    mockVerifyImage.mockRejectedValue(new VerifyImageError('DNS lookup failed'));

    const res = await request(server)
      .get('/api/images/verify')
      .query({ url: 'https://bad.example.com/image.jpg' });

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ error: expect.any(String) });
  });
});

// ─── GET /api/images (gallery) ────────────────────────────────────────────────

describe('GET /api/images', () => {
  it('returns 200 HTML gallery page', async () => {
    const res = await request(server).get('/api/images');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('<html');
    expect(res.text).toContain('gallery');
  });
});

// ─── POST /api/ingest/local/init ─────────────────────────────────────────────

describe('POST /api/ingest/local/init', () => {
  it('returns 200 with presigned uploads', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const uploads = [{ url: 'https://s3.example.com/put-here', key: 'uploads/abc.jpg' }];
    mockInitLocalUpload.mockResolvedValue({ uploads, expiresIn: 600, instructions: [] });

    const res = await request(server)
      .post('/api/ingest/local/init')
      .set('Authorization', 'Bearer tok')
      .send({ fileCount: 3 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, uploads, expiresIn: 600 });
  });

  it('returns 400 when fileCount is missing', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);

    const res = await request(server)
      .post('/api/ingest/local/init')
      .set('Authorization', 'Bearer tok')
      .send({});

    expect(res.status).toBe(400);
  });

  it('returns 401 when not authenticated', async () => {
    mockRequireUserAuth.mockRejectedValue(new Error('Unauthorized'));

    const res = await request(server)
      .post('/api/ingest/local/init')
      .send({ fileCount: 2 });

    expect(res.status).toBe(401);
  });

  it('returns service error code on LocalInitError', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const { LocalInitError } = await import(
      '../../packages/core/src/services/ingest/local-init.service.js'
    );
    mockInitLocalUpload.mockRejectedValue(new LocalInitError('Maximum 200 files', 429));

    const res = await request(server)
      .post('/api/ingest/local/init')
      .set('Authorization', 'Bearer tok')
      .send({ fileCount: 999 });

    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ ok: false });
  });
});

// ─── POST /api/ingest/local/complete ─────────────────────────────────────────

describe('POST /api/ingest/local/complete', () => {
  it('returns 200 with file descriptors', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const files = [
      { key: 'uploads/abc.jpg', url: 'https://cdn.example.com/abc.jpg', mimeType: 'image/jpeg' },
    ];
    mockCompleteLocalUpload.mockResolvedValue({ files, count: 1, message: '1 file(s) ready' });

    const res = await request(server)
      .post('/api/ingest/local/complete')
      .set('Authorization', 'Bearer tok')
      .send({ keys: ['uploads/abc.jpg'] });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, files, count: 1 });
  });

  it('returns 400 when keys is empty', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);

    const res = await request(server)
      .post('/api/ingest/local/complete')
      .set('Authorization', 'Bearer tok')
      .send({ keys: [] });

    expect(res.status).toBe(400);
  });

  it('returns 400 when keys is missing', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);

    const res = await request(server)
      .post('/api/ingest/local/complete')
      .set('Authorization', 'Bearer tok')
      .send({});

    expect(res.status).toBe(400);
  });

  it('returns 401 when not authenticated', async () => {
    mockRequireUserAuth.mockRejectedValue(new Error('Unauthorized'));

    const res = await request(server)
      .post('/api/ingest/local/complete')
      .send({ keys: ['uploads/x.jpg'] });

    expect(res.status).toBe(401);
  });
});

// ─── POST /api/ingest/dropbox ─────────────────────────────────────────────────

describe('POST /api/ingest/dropbox', () => {
  it('returns 200 with ingested files', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const files = [{ key: 'uploads/d1.jpg', url: 'https://dl.dropboxusercontent.com/d1.jpg', mimeType: 'image/jpeg' }];
    mockListDropboxFiles.mockResolvedValue({
      files,
      count: 1,
      folderPath: '/Photos',
      staged: true,
      message: '1 file(s) ready',
    });

    const res = await request(server)
      .post('/api/ingest/dropbox')
      .set('Authorization', 'Bearer tok')
      .send({ folderPath: '/Photos' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, count: 1, folderPath: '/Photos' });
  });

  it('returns 400 when folderPath is missing', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);

    const res = await request(server)
      .post('/api/ingest/dropbox')
      .set('Authorization', 'Bearer tok')
      .send({});

    expect(res.status).toBe(400);
  });

  it('returns 401 when Dropbox is not connected', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const { DropboxListError } = await import(
      '../../packages/core/src/services/ingest/dropbox-list.service.js'
    );
    mockListDropboxFiles.mockRejectedValue(new DropboxListError('Dropbox not connected', 401));

    const res = await request(server)
      .post('/api/ingest/dropbox')
      .set('Authorization', 'Bearer tok')
      .send({ folderPath: '/Photos' });

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ ok: false });
  });

  it('returns 401 when not authenticated', async () => {
    mockRequireUserAuth.mockRejectedValue(new Error('Unauthorized'));

    const res = await request(server)
      .post('/api/ingest/dropbox')
      .send({ folderPath: '/Photos' });

    expect(res.status).toBe(401);
  });
});

// ─── GET /api/smartdrafts/analyze ────────────────────────────────────────────

describe('GET /api/smartdrafts/analyze', () => {
  it('returns 200 with groups when scan completes', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockStartScanJob.mockResolvedValue({ jobId: 'job-111' });
    const doneJob = { status: 'completed', result: { groups: [{ id: 'g1' }], imageInsights: [], cached: false } };
    mockGetJobStatus.mockResolvedValue({ ok: true, job: doneJob });
    mockNormalizeJobStatus.mockReturnValue('completed');

    const res = await request(server)
      .get('/api/smartdrafts/analyze')
      .set('Authorization', 'Bearer tok')
      .query({ folder: '/Photos' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, jobId: 'job-111', folder: '/Photos' });
    expect(res.body.groups).toHaveLength(1);
  });

  it('returns 400 when folder is missing', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);

    const res = await request(server)
      .get('/api/smartdrafts/analyze')
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining('folder') });
  });

  it('returns 500 when scan job fails', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockStartScanJob.mockResolvedValue({ jobId: 'job-fail' });
    const failedJob = { status: 'failed', error: 'Vision API overloaded' };
    mockGetJobStatus.mockResolvedValue({ ok: true, job: failedJob });
    mockNormalizeJobStatus.mockReturnValue('failed');

    const res = await request(server)
      .get('/api/smartdrafts/analyze')
      .set('Authorization', 'Bearer tok')
      .query({ folder: '/Photos' });

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ ok: false, error: expect.any(String) });
  });

  it('returns 401 when not authenticated', async () => {
    mockRequireUserAuth.mockRejectedValue(new Error('Unauthorized'));

    const res = await request(server)
      .get('/api/smartdrafts/analyze')
      .query({ folder: '/Photos' });

    expect(res.status).toBe(401);
  });
});

// ─── POST /api/smartdrafts/pairing/v2/start-local ────────────────────────────

describe('POST /api/smartdrafts/pairing/v2/start-local', () => {
  it('returns 202 with jobId when pairing starts', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockStartPairingV2Job.mockResolvedValue({ jobId: 'pair-999' });

    const res = await request(server)
      .post('/api/smartdrafts/pairing/v2/start-local')
      .set('Authorization', 'Bearer tok')
      .send({ stagedUrls: ['https://s3.example.com/img1.jpg', 'https://s3.example.com/img2.jpg'] });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ ok: true, jobId: 'pair-999', imageCount: 2 });
  });

  it('returns 400 for empty stagedUrls', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);

    const res = await request(server)
      .post('/api/smartdrafts/pairing/v2/start-local')
      .set('Authorization', 'Bearer tok')
      .send({ stagedUrls: [] });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.any(String) });
  });

  it('returns 400 when stagedUrls is missing', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);

    const res = await request(server)
      .post('/api/smartdrafts/pairing/v2/start-local')
      .set('Authorization', 'Bearer tok')
      .send({});

    expect(res.status).toBe(400);
  });

  it('returns 401 when not authenticated', async () => {
    mockRequireUserAuth.mockRejectedValue(new Error('Unauthorized'));

    const res = await request(server)
      .post('/api/smartdrafts/pairing/v2/start-local')
      .send({ stagedUrls: ['https://s3.example.com/img1.jpg'] });

    expect(res.status).toBe(401);
  });

  it('returns 400 on InvalidPairingParamsError', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const { InvalidPairingParamsError } = await import(
      '../../packages/core/src/services/smartdrafts/pairing-v2.js'
    );
    mockStartPairingV2Job.mockRejectedValue(new InvalidPairingParamsError('stagedUrls required'));

    const res = await request(server)
      .post('/api/smartdrafts/pairing/v2/start-local')
      .set('Authorization', 'Bearer tok')
      .send({ stagedUrls: ['https://s3.example.com/img1.jpg'] });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false });
  });
});
