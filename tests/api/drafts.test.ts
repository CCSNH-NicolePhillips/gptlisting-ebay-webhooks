/**
 * Express API — drafts routes
 *
 * Tests:  GET /api/drafts/logs
 *           - happy path: enabled = true, has logs
 *           - logs disabled: returns { enabled: false }
 *           - missing sku and offerId → 400
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

jest.mock('../../src/services/draft-logs.service.js', () => ({
  fetchDraftLogs: jest.fn(),
}));

jest.mock('../../packages/core/src/services/drafts/create-draft-user.js', () => ({
  createEbayDraftsFromGroups: jest.fn(),
  BlockingIssuesError: class BlockingIssuesError extends Error {
    readonly statusCode = 400;
    groupId: string;
    attentionReasons: unknown[];
    constructor(groupId: string, reasons: unknown[]) {
      super('Draft has blocking issues');
      this.name = 'BlockingIssuesError';
      this.groupId = groupId;
      this.attentionReasons = reasons;
    }
  },
  MappingError: class MappingError extends Error {
    readonly statusCode = 400;
    groupId: string;
    constructor(groupId: string, detail: string) {
      super(`Failed to map group: ${detail}`);
      this.name = 'MappingError';
      this.groupId = groupId;
    }
  },
  MissingRequiredSpecificsError: class MissingRequiredSpecificsError extends Error {
    readonly statusCode = 400;
    groupId: string;
    missing: string[];
    constructor(groupId: string, missing: string[]) {
      super(`Missing required specifics: ${missing.join(', ')}`);
      this.name = 'MissingRequiredSpecificsError';
      this.groupId = groupId;
      this.missing = missing;
    }
  },
  InvalidLocationError: class InvalidLocationError extends Error {
    readonly statusCode = 400;
    groupId: string;
    invalidKey: string | null;
    availableKeys: string[];
    constructor(groupId: string, invalidKey: string | null, availableKeys: string[]) {
      super('Invalid merchantLocationKey');
      this.name = 'InvalidLocationError';
      this.groupId = groupId;
      this.invalidKey = invalidKey;
      this.availableKeys = availableKeys;
    }
  },
  EbayAuthError: class EbayAuthError extends Error {
    readonly statusCode = 502;
    constructor(detail: string) { super(`eBay auth failed: ${detail}`); this.name = 'EbayAuthError'; }
  },
  DraftCreationError: class DraftCreationError extends Error {
    readonly statusCode = 502;
    groupId: string;
    constructor(groupId: string, detail: string) {
      super(`Failed to create eBay draft: ${detail}`);
      this.name = 'DraftCreationError';
      this.groupId = groupId;
    }
  },
}));

// ── Module references ─────────────────────────────────────────────────────────

let server: http.Server;
let mockRequireUserAuth: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockFetchDraftLogs: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockCreateEbayDraftsFromGroups: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

beforeAll(async () => {
  const { app } = await import('../../apps/api/src/index.js');
  server = app.listen(0);

  const authModule = await import('../../src/lib/auth-user.js');
  mockRequireUserAuth = authModule.requireUserAuth as jest.MockedFunction<
    (...args: unknown[]) => Promise<unknown>
  >;

  const logsModule = await import('../../src/services/draft-logs.service.js');
  mockFetchDraftLogs = logsModule.fetchDraftLogs as jest.MockedFunction<
    (...args: unknown[]) => Promise<unknown>
  >;

  const createDraftModule = await import('../../packages/core/src/services/drafts/create-draft-user.js');
  mockCreateEbayDraftsFromGroups = createDraftModule.createEbayDraftsFromGroups as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
});

afterAll((done) => { server.close(done); });

// ── Helpers ───────────────────────────────────────────────────────────────────

const MOCK_USER = { sub: 'user|abc', userId: 'user|abc', email: 'test@example.com' };

beforeEach(() => {
  jest.resetAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/drafts/logs', () => {
  it('returns 401 when unauthenticated', async () => {
    mockRequireUserAuth.mockRejectedValue(new Error('auth: missing token'));
    const res = await request(server).get('/api/drafts/logs?sku=SKU-001');
    expect(res.status).toBe(401);
  });

  it('returns 400 when sku and offerId are both missing', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const res = await request(server)
      .get('/api/drafts/logs')
      .set('Authorization', 'Bearer tok');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sku or offerId/i);
  });

  it('returns 200 with logs when feature is enabled', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const mockLogs = { pricingReason: 'Market match at $14.99', sources: ['ebay'] };
    mockFetchDraftLogs.mockResolvedValue({ ok: true, enabled: true, logs: mockLogs, hasLogs: true });

    const res = await request(server)
      .get('/api/drafts/logs?sku=SKU-001')
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, enabled: true, hasLogs: true });
    expect(mockFetchDraftLogs).toHaveBeenCalledWith(MOCK_USER.userId, { sku: 'SKU-001', offerId: undefined });
  });

  it('returns 200 with enabled=false when feature is disabled', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockFetchDraftLogs.mockResolvedValue({
      ok: true,
      enabled: false,
      logs: null,
      hasLogs: false,
      message: 'Pricing logs display is disabled. Enable it in Settings.',
    });

    const res = await request(server)
      .get('/api/drafts/logs?sku=SKU-001')
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.logs).toBeNull();
  });

  it('supports lookup by offerId', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockFetchDraftLogs.mockResolvedValue({ ok: true, enabled: true, logs: null, hasLogs: false });

    await request(server)
      .get('/api/drafts/logs?offerId=off-123')
      .set('Authorization', 'Bearer tok');

    expect(mockFetchDraftLogs).toHaveBeenCalledWith(MOCK_USER.userId, { sku: undefined, offerId: 'off-123' });
  });

  it('returns 500 on service error', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockFetchDraftLogs.mockRejectedValue(new Error('Redis unavailable'));

    const res = await request(server)
      .get('/api/drafts/logs?sku=SKU-001')
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(500);
  });
});

// ── POST /api/drafts ──────────────────────────────────────────────────────────

const SAMPLE_GROUP = {
  groupId: 'grp-1',
  title: 'Test Product',
  attentionReasons: [],
};

describe('POST /api/drafts', () => {
  it('returns 401 when unauthenticated', async () => {
    mockRequireUserAuth.mockRejectedValue(new Error('auth: missing token'));
    const res = await request(server).post('/api/drafts').send({ jobId: 'j', groups: [SAMPLE_GROUP] });
    expect(res.status).toBe(401);
  });

  it('returns 400 when jobId missing', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const res = await request(server)
      .post('/api/drafts')
      .set('Authorization', 'Bearer tok')
      .send({ groups: [SAMPLE_GROUP] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/jobId/i);
  });

  it('returns 400 when groups is empty', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const res = await request(server)
      .post('/api/drafts')
      .set('Authorization', 'Bearer tok')
      .send({ jobId: 'job-1', groups: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/groups/i);
  });

  it('returns 200 with created results on happy path', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const results = [{ sku: 'SKU-001', offerId: 'off-123', warnings: [] }];
    mockCreateEbayDraftsFromGroups.mockResolvedValue(results);
    const res = await request(server)
      .post('/api/drafts')
      .set('Authorization', 'Bearer tok')
      .send({ jobId: 'job-1', groups: [SAMPLE_GROUP] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.created).toBe(1);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].offerId).toBe('off-123');
  });

  it('returns 400 for blocking attention issues', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const { BlockingIssuesError } = await import('../../packages/core/src/services/drafts/create-draft-user.js');
    mockCreateEbayDraftsFromGroups.mockRejectedValue(
      new (BlockingIssuesError as any)('grp-1', [{ severity: 'error', message: 'No images' }]),
    );
    const res = await request(server)
      .post('/api/drafts')
      .set('Authorization', 'Bearer tok')
      .send({ jobId: 'job-1', groups: [SAMPLE_GROUP] });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.groupId).toBe('grp-1');
  });

  it('returns 400 for invalid location', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const { InvalidLocationError } = await import('../../packages/core/src/services/drafts/create-draft-user.js');
    mockCreateEbayDraftsFromGroups.mockRejectedValue(
      new (InvalidLocationError as any)('grp-1', 'BAD-KEY', ['WH-MAIN']),
    );
    const res = await request(server)
      .post('/api/drafts')
      .set('Authorization', 'Bearer tok')
      .send({ jobId: 'job-1', groups: [SAMPLE_GROUP] });
    expect(res.status).toBe(400);
    expect(res.body.availableKeys).toContain('WH-MAIN');
  });

  it('returns 502 when eBay auth fails', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    const { EbayAuthError } = await import('../../packages/core/src/services/drafts/create-draft-user.js');
    mockCreateEbayDraftsFromGroups.mockRejectedValue(new (EbayAuthError as any)('token expired'));
    const res = await request(server)
      .post('/api/drafts')
      .set('Authorization', 'Bearer tok')
      .send({ jobId: 'job-1', groups: [SAMPLE_GROUP] });
    expect(res.status).toBe(502);
  });

  it('returns 500 on unexpected error', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockCreateEbayDraftsFromGroups.mockRejectedValue(new Error('Unexpected failure'));
    const res = await request(server)
      .post('/api/drafts')
      .set('Authorization', 'Bearer tok')
      .send({ jobId: 'job-1', groups: [SAMPLE_GROUP] });
    expect(res.status).toBe(500);
  });
});
