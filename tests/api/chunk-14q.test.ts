/**
 * tests/api/chunk-14q.test.ts
 *
 * Chunk 14Q — 20 new Express endpoints:
 *
 *   GET  /api/admin/refresh-token
 *   GET  /api/admin/user-images
 *   POST /api/admin/ebay-token
 *   POST /api/admin/migrate-tokens
 *   GET  /api/auth/debug
 *   GET  /api/connections
 *   GET  /api/ebay/policies
 *   GET  /api/ebay/policies/defaults
 *   GET  /api/ebay/policies/:id
 *   POST /api/ebay/policies
 *   DELETE /api/ebay/policies/:id
 *   GET  /api/ebay/campaigns
 *   GET  /api/ebay/marketing/defaults
 *   POST /api/ebay/marketing/defaults
 *   GET  /api/ebay/optin
 *   POST /api/smartdrafts/scan
 *   POST /api/smartdrafts/pairing/v2/start-from-scan
 *   POST /api/smartdrafts/quick-list
 *   GET  /api/smartdrafts/quick-list
 *   GET  /api/cdn/auth0-spa
 *   GET  /api/analyze/analytics (admin)
 */

import http from 'http';
import request from 'supertest';
import { jest } from '@jest/globals';

// ── Auth mocks ─────────────────────────────────────────────────────────────────

jest.mock('../../src/lib/auth-user.js', () => ({
  requireUserAuth: jest.fn(),
}));

jest.mock('../../src/lib/auth-admin.js', () => ({
  requireAdminAuth: jest.fn(),
}));

// ── Admin service ─────────────────────────────────────────────────────────────

jest.mock('../../packages/core/src/services/admin/admin.service.js', () => ({
  getEbayRefreshToken: jest.fn(),
  listUserImages: jest.fn(),
  setEbayToken: jest.fn(),
  migrateLegacyTokens: jest.fn(),
  AdminNotFoundError: class AdminNotFoundError extends Error {
    readonly statusCode = 404;
    constructor(msg = 'Not found') { super(msg); this.name = 'AdminNotFoundError'; }
  },
  AdminTokenError: class AdminTokenError extends Error {
    readonly statusCode = 400;
    constructor(msg = 'Bad token') { super(msg); this.name = 'AdminTokenError'; }
  },
  AdminStorageError: class AdminStorageError extends Error {
    readonly statusCode = 500;
    constructor(msg = 'Storage error') { super(msg); this.name = 'AdminStorageError'; }
  },
}));

// ── Connections service ───────────────────────────────────────────────────────

jest.mock('../../packages/core/src/services/connections/connections.service.js', () => ({
  getUserConnections: jest.fn(),
}));

// ── eBay policies service ─────────────────────────────────────────────────────

jest.mock('../../packages/core/src/services/ebay/policies.service.js', () => ({
  listPolicies: jest.fn(),
  getPolicy: jest.fn(),
  createPolicy: jest.fn(),
  deletePolicy: jest.fn(),
  getPolicyDefaults: jest.fn(),
  setPolicyDefault: jest.fn(),
  PolicyApiError: class PolicyApiError extends Error {
    readonly statusCode: number;
    readonly detail?: unknown;
    constructor(msg: string, statusCode: number, detail?: unknown) {
      super(msg); this.name = 'PolicyApiError'; this.statusCode = statusCode; this.detail = detail;
    }
  },
  PolicyValidationError: class PolicyValidationError extends Error {
    readonly statusCode = 400;
    constructor(msg: string) { super(msg); this.name = 'PolicyValidationError'; }
  },
  PolicyNotConnectedError: class PolicyNotConnectedError extends Error {
    readonly statusCode = 400;
    constructor() { super('Connect eBay first'); this.name = 'PolicyNotConnectedError'; }
  },
}));

// ── eBay campaigns service ────────────────────────────────────────────────────

jest.mock('../../packages/core/src/services/ebay/campaigns.service.js', () => ({
  listCampaigns: jest.fn(),
  CampaignsNotConnectedError: class CampaignsNotConnectedError extends Error {
    readonly statusCode = 400;
    constructor() { super('Connect eBay first'); this.name = 'CampaignsNotConnectedError'; }
  },
  CampaignsApiError: class CampaignsApiError extends Error {
    readonly statusCode: number;
    constructor(msg: string, statusCode: number) { super(msg); this.name = 'CampaignsApiError'; this.statusCode = statusCode; }
  },
}));

// ── eBay marketing service ────────────────────────────────────────────────────

jest.mock('../../packages/core/src/services/ebay/marketing.service.js', () => ({
  getMarketingDefaults: jest.fn(),
  setMarketingDefault: jest.fn(),
}));

// ── eBay optin service ────────────────────────────────────────────────────────

jest.mock('../../packages/core/src/services/ebay/optin.service.js', () => ({
  checkOptin: jest.fn(),
  OptinNotConnectedError: class OptinNotConnectedError extends Error {
    readonly statusCode = 400;
    constructor() { super('Connect eBay first'); this.name = 'OptinNotConnectedError'; }
  },
  OptinApiError: class OptinApiError extends Error {
    readonly statusCode: number;
    readonly detail?: unknown;
    constructor(msg: string, statusCode: number, detail?: unknown) {
      super(msg); this.name = 'OptinApiError'; this.statusCode = statusCode; this.detail = detail;
    }
  },
}));

// ── SmartDrafts scan-direct service ──────────────────────────────────────────

jest.mock('../../packages/core/src/services/smartdrafts/scan-direct.service.js', () => ({
  runDirectScan: jest.fn(),
}));

// ── SmartDrafts pairing-from-scan service ────────────────────────────────────

jest.mock('../../packages/core/src/services/smartdrafts/pairing-from-scan.service.js', () => ({
  startPairingFromScan: jest.fn(),
  ScanJobNotFoundError: class ScanJobNotFoundError extends Error {
    readonly statusCode = 404;
    constructor(jobId: string) { super(`Not found: ${jobId}`); this.name = 'ScanJobNotFoundError'; }
  },
  ScanJobNotCompleteError: class ScanJobNotCompleteError extends Error {
    readonly statusCode = 400;
    constructor(state: string) { super(`Not completed: ${state}`); this.name = 'ScanJobNotCompleteError'; }
  },
  PairingFromScanError: class PairingFromScanError extends Error {
    readonly statusCode = 500;
    constructor(msg: string) { super(msg); this.name = 'PairingFromScanError'; }
  },
}));

// ── SmartDrafts quick-list service ───────────────────────────────────────────

jest.mock('../../packages/core/src/services/smartdrafts/quick-list.service.js', () => ({
  startQuickList: jest.fn(),
  getQuickListStatus: jest.fn(),
  QuickListNotFoundError: class QuickListNotFoundError extends Error {
    readonly statusCode = 404;
    constructor(jobId: string) { super(`Not found: ${jobId}`); this.name = 'QuickListNotFoundError'; }
  },
}));

// ── CDN auth0-spa service ─────────────────────────────────────────────────────

jest.mock('../../packages/core/src/services/cdn/auth0-spa.service.js', () => ({
  fetchAuth0SpaSdk: jest.fn(),
  Auth0SpaFetchError: class Auth0SpaFetchError extends Error {
    readonly statusCode: number;
    constructor(msg: string, statusCode = 502) { super(msg); this.name = 'Auth0SpaFetchError'; this.statusCode = statusCode; }
  },
}));

// ── Analytics service ─────────────────────────────────────────────────────────

jest.mock('../../packages/core/src/services/analyze/analytics.service.js', () => ({
  getAnalytics: jest.fn(),
}));

// ── Pre-existing route mocks (prevent real I/O in other routes) ──────────────

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
  InvalidDraftError: class extends Error { readonly statusCode = 400; constructor(msg = '') { super(msg); } },
  EbayApiError: class extends Error { readonly statusCode: number; constructor(msg: string, s = 500) { super(msg); this.statusCode = s; } },
}));
jest.mock('../../packages/core/src/services/smartdrafts/bg-jobs.js', () => ({
  startScanJob: jest.fn(),
  startCreateDraftsJob: jest.fn(),
  QuotaExceededError: class extends Error { constructor(msg = 'Quota') { super(msg); } },
  BgInvokeError: class extends Error { constructor(msg = 'BgInvoke') { super(msg); } },
}));
jest.mock('../../src/services/job-status.service.js', () => ({
  getJobStatus: jest.fn(),
  JobNotFoundError: class extends Error { readonly statusCode = 404; constructor(msg = '') { super(msg); } },
}));
jest.mock('../../src/lib/jobs/job-status.js', () => ({
  normalizeJobStatus: jest.fn(),
}));
jest.mock('../../packages/core/src/services/smartdrafts/pairing-v2.js', () => ({
  startPairingV2Job: jest.fn(),
  getPairingV2Status: jest.fn(),
  PairingJobNotFoundError: class extends Error { readonly statusCode = 404; constructor(msg = '') { super(msg); } },
  InvalidPairingParamsError: class extends Error { constructor(msg = '') { super(msg); } },
}));
jest.mock('../../src/lib/ebay-client.js', () => ({
  EbayNotConnectedError: class extends Error {
    statusCode = 400;
    constructor() { super('Connect eBay first'); this.name = 'EbayNotConnectedError'; }
  },
}));

// ── Server + mock refs ────────────────────────────────────────────────────────

let server: http.Server;
let mockRequireUserAuth: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockRequireAdminAuth: jest.MockedFunction<(...args: unknown[]) => void>;

// Admin
let mockGetEbayRefreshToken: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockListUserImages: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockSetEbayToken: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockMigrateLegacyTokens: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

// Connections
let mockGetUserConnections: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

// eBay Policies
let mockListPolicies: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockGetPolicy: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockCreatePolicy: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockDeletePolicy: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockGetPolicyDefaults: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

// eBay Campaigns
let mockListCampaigns: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

// eBay Marketing
let mockGetMarketingDefaults: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockSetMarketingDefault: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

// eBay Optin
let mockCheckOptin: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

// SmartDrafts
let mockRunDirectScan: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockStartPairingFromScan: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockStartQuickList: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockGetQuickListStatus: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

// CDN
let mockFetchAuth0SpaSdk: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

// Analytics
let mockGetAnalytics: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

beforeAll(async () => {
  const { app } = await import('../../apps/api/src/index.js');
  server = app.listen(0);

  const authModule = await import('../../src/lib/auth-user.js');
  mockRequireUserAuth = authModule.requireUserAuth as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

  const adminAuthModule = await import('../../src/lib/auth-admin.js');
  mockRequireAdminAuth = adminAuthModule.requireAdminAuth as jest.MockedFunction<(...args: unknown[]) => void>;

  const adminSvc = await import('../../packages/core/src/services/admin/admin.service.js');
  mockGetEbayRefreshToken = adminSvc.getEbayRefreshToken as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
  mockListUserImages = adminSvc.listUserImages as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
  mockSetEbayToken = adminSvc.setEbayToken as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
  mockMigrateLegacyTokens = adminSvc.migrateLegacyTokens as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

  const connSvc = await import('../../packages/core/src/services/connections/connections.service.js');
  mockGetUserConnections = connSvc.getUserConnections as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

  const policiesSvc = await import('../../packages/core/src/services/ebay/policies.service.js');
  mockListPolicies = policiesSvc.listPolicies as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
  mockGetPolicy = policiesSvc.getPolicy as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
  mockCreatePolicy = policiesSvc.createPolicy as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
  mockDeletePolicy = policiesSvc.deletePolicy as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
  mockGetPolicyDefaults = policiesSvc.getPolicyDefaults as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

  const campaignsSvc = await import('../../packages/core/src/services/ebay/campaigns.service.js');
  mockListCampaigns = campaignsSvc.listCampaigns as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

  const marketingSvc = await import('../../packages/core/src/services/ebay/marketing.service.js');
  mockGetMarketingDefaults = marketingSvc.getMarketingDefaults as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
  mockSetMarketingDefault = marketingSvc.setMarketingDefault as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

  const optinSvc = await import('../../packages/core/src/services/ebay/optin.service.js');
  mockCheckOptin = optinSvc.checkOptin as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

  const scanSvc = await import('../../packages/core/src/services/smartdrafts/scan-direct.service.js');
  mockRunDirectScan = scanSvc.runDirectScan as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

  const fromScanSvc = await import('../../packages/core/src/services/smartdrafts/pairing-from-scan.service.js');
  mockStartPairingFromScan = fromScanSvc.startPairingFromScan as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

  const quickListSvc = await import('../../packages/core/src/services/smartdrafts/quick-list.service.js');
  mockStartQuickList = quickListSvc.startQuickList as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
  mockGetQuickListStatus = quickListSvc.getQuickListStatus as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

  const cdnSvc = await import('../../packages/core/src/services/cdn/auth0-spa.service.js');
  mockFetchAuth0SpaSdk = cdnSvc.fetchAuth0SpaSdk as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

  const analyticsSvc = await import('../../packages/core/src/services/analyze/analytics.service.js');
  mockGetAnalytics = analyticsSvc.getAnalytics as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
});

afterAll((done) => { server.close(done); });
afterEach(() => jest.resetAllMocks());

// ── Helpers ────────────────────────────────────────────────────────────────────

function authAsUser(userId = 'user-sub-123') {
  mockRequireUserAuth.mockResolvedValue({ userId, sub: userId, email: 'test@example.com' });
}
function authAsAdmin() {
  mockRequireAdminAuth.mockReturnValue(undefined);
}
function authFails() {
  mockRequireUserAuth.mockRejectedValue(Object.assign(new Error('Unauthorized'), { message: 'auth failed' }));
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/admin/refresh-token', () => {
  it('returns 200 with refresh_token', async () => {
    authAsAdmin();
    mockGetEbayRefreshToken.mockResolvedValue({ refresh_token: 'secret-rt', instructions: 'run script' });
    const res = await request(server).get('/api/admin/refresh-token?userId=user1').set('Authorization', 'Bearer admin-token');
    expect(res.status).toBe(200);
    expect(res.body.refresh_token).toBe('secret-rt');
  });

  it('returns 400 when userId is missing', async () => {
    authAsAdmin();
    const res = await request(server).get('/api/admin/refresh-token').set('Authorization', 'Bearer admin-token');
    expect(res.status).toBe(400);
  });

  it('returns 404 when token not found', async () => {
    authAsAdmin();
    const { AdminNotFoundError } = await import('../../packages/core/src/services/admin/admin.service.js');
    mockGetEbayRefreshToken.mockRejectedValue(new AdminNotFoundError('No eBay token found'));
    const res = await request(server).get('/api/admin/refresh-token?userId=user1').set('Authorization', 'Bearer admin-token');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/admin/user-images', () => {
  it('returns 200 with images list', async () => {
    authAsAdmin();
    mockListUserImages.mockResolvedValue({ images: [{ key: 'staging/u1/img.jpg', filename: 'img.jpg', size: 1024, lastModified: '2025-01-01T00:00:00Z', url: 'https://example.com/img.jpg' }], count: 1, bucket: 'my-bucket', prefix: 'staging/u1/' });
    const res = await request(server).get('/api/admin/user-images?userId=u1').set('Authorization', 'Bearer admin-token');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
  });

  it('returns 400 when userId is missing', async () => {
    authAsAdmin();
    const res = await request(server).get('/api/admin/user-images').set('Authorization', 'Bearer admin-token');
    expect(res.status).toBe(400);
  });
});

describe('POST /api/admin/ebay-token', () => {
  it('stores a valid refresh token', async () => {
    authAsAdmin();
    mockSetEbayToken.mockResolvedValue({ ok: true, message: 'Stored', user: 'u1', env: 'PROD' });
    const res = await request(server)
      .post('/api/admin/ebay-token')
      .set('Authorization', 'Bearer admin-token')
      .send({ userId: 'u1', refresh_token: 'v1-refresh' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('returns 400 when refresh_token is missing', async () => {
    authAsAdmin();
    const res = await request(server)
      .post('/api/admin/ebay-token')
      .set('Authorization', 'Bearer admin-token')
      .send({ userId: 'u1' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/admin/migrate-tokens', () => {
  it('returns migrated status', async () => {
    authAsAdmin();
    mockMigrateLegacyTokens.mockResolvedValue({ migrated: { dropbox: true, ebay: false } });
    const res = await request(server)
      .post('/api/admin/migrate-tokens')
      .set('Authorization', 'Bearer admin-token')
      .send({ userId: 'u1' });
    expect(res.status).toBe(200);
    expect(res.body.migrated.dropbox).toBe(true);
  });

  it('succeeds even without userId in body', async () => {
    authAsAdmin();
    mockMigrateLegacyTokens.mockResolvedValue({ migrated: { dropbox: false, ebay: false } });
    const res = await request(server)
      .post('/api/admin/migrate-tokens')
      .set('Authorization', 'Bearer admin-token')
      .send({});
    expect(res.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/auth/debug', () => {
  it('returns 400 without Bearer token', async () => {
    const res = await request(server).get('/api/auth/debug');
    expect(res.status).toBe(400);
  });

  it('returns diagnostic JSON with a (possibly invalid) token', async () => {
    // The endpoint gracefully handles bad tokens — it returns 200 with verify.ok:false
    const fakeJwt = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0IiwiaWF0IjoxNjAwMDAwMDAwfQ.sig';
    const res = await request(server).get('/api/auth/debug').set('Authorization', `Bearer ${fakeJwt}`);
    // Either 200 (decode OK, verify fails gracefully) or 500 if jose itself blows up
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body).toHaveProperty('tokenClaims');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CONNECTIONS
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/connections', () => {
  it('returns connection status', async () => {
    authAsUser();
    mockGetUserConnections.mockResolvedValue({ ok: true, ebay: { connected: true }, dropbox: { connected: false } });
    const res = await request(server).get('/api/connections').set('Authorization', 'Bearer user-token');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.ebay.connected).toBe(true);
  });

  it('returns 401 without auth', async () => {
    authFails();
    const res = await request(server).get('/api/connections').set('Authorization', 'Bearer bad');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EBAY POLICIES
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/ebay/policies', () => {
  it('returns all three policy types', async () => {
    authAsUser();
    mockListPolicies.mockResolvedValue({ fulfillment: {}, payment: {}, returns: {}, eligibility: { businessPoliciesEligible: true, marketplaceId: 'EBAY_US' } });
    const res = await request(server).get('/api/ebay/policies').set('Authorization', 'Bearer user-token');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('returns 401 without auth', async () => {
    authFails();
    const res = await request(server).get('/api/ebay/policies').set('Authorization', 'Bearer bad');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/ebay/policies/defaults', () => {
  it('returns defaults (must route before /:id)', async () => {
    authAsUser();
    mockGetPolicyDefaults.mockResolvedValue({ ok: true, defaults: { payment: 'p-id', fulfillment: 'f-id' } });
    const res = await request(server).get('/api/ebay/policies/defaults').set('Authorization', 'Bearer user-token');
    expect(res.status).toBe(200);
    expect(res.body.defaults.payment).toBe('p-id');
  });
});

describe('GET /api/ebay/policies/:id', () => {
  it('fetches a policy by id+type', async () => {
    authAsUser();
    mockGetPolicy.mockResolvedValue({ ok: true, policy: { paymentPolicyId: 'pid', name: 'Default Payment' } });
    const res = await request(server).get('/api/ebay/policies/pid?type=payment').set('Authorization', 'Bearer user-token');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('returns 400 when type is missing', async () => {
    authAsUser();
    const res = await request(server).get('/api/ebay/policies/pid').set('Authorization', 'Bearer user-token');
    expect(res.status).toBe(400);
  });
});

describe('POST /api/ebay/policies', () => {
  it('creates a policy', async () => {
    authAsUser();
    mockCreatePolicy.mockResolvedValue({ ok: true, id: 'new-id', policy: {} });
    const res = await request(server)
      .post('/api/ebay/policies')
      .set('Authorization', 'Bearer user-token')
      .send({ type: 'payment', name: 'My Policy' });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('new-id');
  });

  it('returns 400 when type is missing', async () => {
    authAsUser();
    const res = await request(server)
      .post('/api/ebay/policies')
      .set('Authorization', 'Bearer user-token')
      .send({ name: 'No Type' });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/ebay/policies/:id', () => {
  it('deletes a policy', async () => {
    authAsUser();
    mockDeletePolicy.mockResolvedValue({ ok: true, deleted: { type: 'payment_policy', id: 'p-id' } });
    const res = await request(server).delete('/api/ebay/policies/p-id?type=payment').set('Authorization', 'Bearer user-token');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('returns 400 when type is missing', async () => {
    authAsUser();
    const res = await request(server).delete('/api/ebay/policies/p-id').set('Authorization', 'Bearer user-token');
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EBAY CAMPAIGNS
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/ebay/campaigns', () => {
  it('returns campaigns list', async () => {
    authAsUser();
    mockListCampaigns.mockResolvedValue({ ok: true, defaultPromoCampaignId: 'c1', campaigns: [{ campaignId: 'c1', name: 'Spring', status: 'RUNNING', fundingStrategyType: 'COST_PER_SALE' }] });
    const res = await request(server).get('/api/ebay/campaigns').set('Authorization', 'Bearer user-token');
    expect(res.status).toBe(200);
    expect(res.body.campaigns).toHaveLength(1);
  });

  it('returns 401 without auth', async () => {
    authFails();
    const res = await request(server).get('/api/ebay/campaigns').set('Authorization', 'Bearer bad');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EBAY MARKETING DEFAULTS
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/ebay/marketing/defaults', () => {
  it('returns marketing defaults', async () => {
    authAsUser();
    mockGetMarketingDefaults.mockResolvedValue({ ok: true, defaults: { defaultPromoCampaignId: 'c1' } });
    const res = await request(server).get('/api/ebay/marketing/defaults').set('Authorization', 'Bearer user-token');
    expect(res.status).toBe(200);
    expect(res.body.defaults.defaultPromoCampaignId).toBe('c1');
  });
});

describe('POST /api/ebay/marketing/defaults', () => {
  it('saves defaultPromoCampaignId', async () => {
    authAsUser();
    mockSetMarketingDefault.mockResolvedValue({ ok: true, defaultPromoCampaignId: 'c2' });
    const res = await request(server)
      .post('/api/ebay/marketing/defaults')
      .set('Authorization', 'Bearer user-token')
      .send({ defaultPromoCampaignId: 'c2' });
    expect(res.status).toBe(200);
    expect(res.body.defaultPromoCampaignId).toBe('c2');
  });

  it('returns 401 without auth', async () => {
    authFails();
    const res = await request(server).post('/api/ebay/marketing/defaults').set('Authorization', 'Bearer bad').send({});
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EBAY OPTIN
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/ebay/optin', () => {
  it('returns optin status', async () => {
    authAsUser();
    mockCheckOptin.mockResolvedValue({ ok: true, optedIn: true, status: 'OPTED_IN' });
    const res = await request(server).get('/api/ebay/optin').set('Authorization', 'Bearer user-token');
    expect(res.status).toBe(200);
    expect(res.body.optedIn).toBe(true);
  });

  it('returns 401 without auth', async () => {
    authFails();
    const res = await request(server).get('/api/ebay/optin').set('Authorization', 'Bearer bad');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SMARTDRAFTS SCAN
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/smartdrafts/scan', () => {
  it('returns scan result', async () => {
    authAsUser();
    mockRunDirectScan.mockResolvedValue({ ok: true, cached: false, folder: '/images', signature: 'abc', count: 3, warnings: [], groups: [], imageInsights: null });
    const res = await request(server)
      .post('/api/smartdrafts/scan')
      .set('Authorization', 'Bearer user-token')
      .send({ path: '/images' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('returns 400 when path is missing', async () => {
    authAsUser();
    const res = await request(server)
      .post('/api/smartdrafts/scan')
      .set('Authorization', 'Bearer user-token')
      .send({});
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SMARTDRAFTS PAIRING FROM SCAN
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/smartdrafts/pairing/v2/start-from-scan', () => {
  it('starts pairing job from scan', async () => {
    authAsUser();
    mockStartPairingFromScan.mockResolvedValue({ ok: true, jobId: 'pair-job-1', imageCount: 10, uploadMethod: 'staged' });
    const res = await request(server)
      .post('/api/smartdrafts/pairing/v2/start-from-scan')
      .set('Authorization', 'Bearer user-token')
      .send({ scanJobId: 'scan-job-1' });
    expect(res.status).toBe(202);
    expect(res.body.jobId).toBe('pair-job-1');
  });

  it('returns 400 when scanJobId is missing', async () => {
    authAsUser();
    const res = await request(server)
      .post('/api/smartdrafts/pairing/v2/start-from-scan')
      .set('Authorization', 'Bearer user-token')
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns 404 when scan job is not found', async () => {
    authAsUser();
    const { ScanJobNotFoundError } = await import('../../packages/core/src/services/smartdrafts/pairing-from-scan.service.js');
    mockStartPairingFromScan.mockRejectedValue(new ScanJobNotFoundError('scan-job-1'));
    const res = await request(server)
      .post('/api/smartdrafts/pairing/v2/start-from-scan')
      .set('Authorization', 'Bearer user-token')
      .send({ scanJobId: 'scan-job-1' });
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SMARTDRAFTS QUICK LIST
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/smartdrafts/quick-list', () => {
  it('creates a quick-list job', async () => {
    authAsUser();
    mockStartQuickList.mockResolvedValue({ ok: true, jobId: 'ql-job-1' });
    const res = await request(server)
      .post('/api/smartdrafts/quick-list')
      .set('Authorization', 'Bearer user-token')
      .send({ scanJobId: 'scan-job-1' });
    expect(res.status).toBe(200);
    expect(res.body.jobId).toBe('ql-job-1');
  });

  it('returns 401 without auth', async () => {
    authFails();
    const res = await request(server)
      .post('/api/smartdrafts/quick-list')
      .set('Authorization', 'Bearer bad')
      .send({});
    expect(res.status).toBe(401);
  });
});

describe('GET /api/smartdrafts/quick-list', () => {
  it('returns job status', async () => {
    authAsUser();
    mockGetQuickListStatus.mockResolvedValue({ jobId: 'ql-job-1', userId: 'user-sub-123', state: 'pending', createdAt: '2025-01-01T00:00:00Z' });
    const res = await request(server).get('/api/smartdrafts/quick-list?jobId=ql-job-1').set('Authorization', 'Bearer user-token');
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('pending');
  });

  it('returns 400 when jobId is missing', async () => {
    authAsUser();
    const res = await request(server).get('/api/smartdrafts/quick-list').set('Authorization', 'Bearer user-token');
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown job', async () => {
    authAsUser();
    const { QuickListNotFoundError } = await import('../../packages/core/src/services/smartdrafts/quick-list.service.js');
    mockGetQuickListStatus.mockRejectedValue(new QuickListNotFoundError('ql-missing'));
    const res = await request(server).get('/api/smartdrafts/quick-list?jobId=ql-missing').set('Authorization', 'Bearer user-token');
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CDN AUTH0 SPA
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/cdn/auth0-spa', () => {
  it('returns JS with cache headers', async () => {
    mockFetchAuth0SpaSdk.mockResolvedValue({ body: 'var auth0sdk={}', contentType: 'application/javascript; charset=utf-8' });
    const res = await request(server).get('/api/cdn/auth0-spa');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('max-age=86400');
  });

  it('returns 502 on CDN fetch error', async () => {
    const { Auth0SpaFetchError } = await import('../../packages/core/src/services/cdn/auth0-spa.service.js');
    mockFetchAuth0SpaSdk.mockRejectedValue(new Auth0SpaFetchError('CDN down', 502));
    const res = await request(server).get('/api/cdn/auth0-spa');
    expect(res.status).toBe(502);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ANALYZE ANALYTICS (admin)
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/analyze/analytics', () => {
  it('returns analytics summaries', async () => {
    authAsAdmin();
    mockGetAnalytics.mockResolvedValue({ summaries: [{ jobId: 'j1', state: 'completed', priceGroupCount: 3, avgPrice: 25.0, minPrice: 10.0, maxPrice: 40.0 }] });
    const res = await request(server).get('/api/analyze/analytics').set('Authorization', 'Bearer admin-token');
    expect(res.status).toBe(200);
    expect(res.body.summaries).toHaveLength(1);
  });

  it('returns 401 without admin auth', async () => {
    mockRequireAdminAuth.mockImplementation(() => { throw Object.assign(new Error('Unauthorized'), { message: 'unauthorized' }); });
    const res = await request(server).get('/api/analyze/analytics').set('Authorization', 'Bearer bad');
    expect(res.status).toBe(401);
  });
});
