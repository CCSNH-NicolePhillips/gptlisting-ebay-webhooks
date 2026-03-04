/**
 * Express API — GET /api/settings, POST /api/settings
 */

import http from 'http';
import request from 'supertest';
import { jest } from '@jest/globals';

jest.mock('../../src/lib/auth-user.js', () => ({
  requireUserAuth: jest.fn(),
  requireUserAuthFull: jest.fn(),
}));

jest.mock('../../src/services/user-settings.service.js', () => ({
  getUserSettings: jest.fn(),
  saveUserSettings: jest.fn(),
  validateSaveInput: jest.fn(),
}));

let server: http.Server;
let mockRequireUserAuth: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockGetUserSettings: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockSaveUserSettings: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockValidateSaveInput: jest.MockedFunction<(...args: unknown[]) => unknown>;

const MOCK_USER = { userId: 'auth0|user1' };
const MOCK_SETTINGS = {
  autoPromoteEnabled: false,
  defaultPromotionRate: null,
  pricing: {
    discountPercent: 5,
    shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
    templateShippingEstimateCents: 600,
    shippingSubsidyCapCents: null,
    minItemPriceCents: 499,
  },
  autoPrice: { enabled: false, reduceBy: 100, everyDays: 7, minPriceType: 'fixed', minPrice: 199, minPercent: 50 },
  bestOffer: { enabled: false, autoDeclinePercent: 60, autoAcceptPercent: 90 },
  showPricingLogs: false,
};

beforeAll(async () => {
  const { app } = await import('../../apps/api/src/index.js');
  server = app.listen(0);

  const authModule = await import('../../src/lib/auth-user.js');
  mockRequireUserAuth = authModule.requireUserAuth as jest.MockedFunction<
    (...args: unknown[]) => Promise<unknown>
  >;

  const settingsService = await import('../../src/services/user-settings.service.js');
  mockGetUserSettings = settingsService.getUserSettings as jest.MockedFunction<
    (...args: unknown[]) => Promise<unknown>
  >;
  mockSaveUserSettings = settingsService.saveUserSettings as jest.MockedFunction<
    (...args: unknown[]) => Promise<unknown>
  >;
  mockValidateSaveInput = settingsService.validateSaveInput as jest.MockedFunction<
    (...args: unknown[]) => unknown
  >;
});

beforeEach(() => jest.clearAllMocks());

afterAll((done) => { server.close(done); });

// ── GET /api/settings ────────────────────────────────────────────────────────

describe('GET /api/settings', () => {
  it('returns 401 when unauthenticated', async () => {
    mockRequireUserAuth.mockRejectedValue(new Error('auth: User authentication not enabled'));

    const res = await request(server).get('/api/settings');
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error');
  });

  it('returns 200 with settings on happy path', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockGetUserSettings.mockResolvedValue(MOCK_SETTINGS);

    const res = await request(server).get('/api/settings').set('Authorization', 'Bearer tok');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ autoPromoteEnabled: false, pricing: expect.any(Object) });
    expect(mockGetUserSettings).toHaveBeenCalledWith(MOCK_USER.userId);
  });

  it('returns 500 on service error', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockGetUserSettings.mockRejectedValue(new Error('Redis unavailable'));

    const res = await request(server).get('/api/settings').set('Authorization', 'Bearer tok');
    expect(res.status).toBe(500);
  });
});

// ── POST /api/settings ───────────────────────────────────────────────────────

describe('POST /api/settings', () => {
  it('returns 401 when unauthenticated', async () => {
    mockRequireUserAuth.mockRejectedValue(new Error('auth: missing token'));

    const res = await request(server).post('/api/settings').send({});
    expect(res.status).toBe(401);
  });

  it('returns 400 on validation failure', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockValidateSaveInput.mockReturnValue({ error: 'defaultPromotionRate must be between 1 and 20' });

    const res = await request(server)
      .post('/api/settings')
      .set('Authorization', 'Bearer tok')
      .send({ defaultPromotionRate: 99 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/defaultPromotionRate/);
  });

  it('returns 200 with ok and saved settings on happy path', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockValidateSaveInput.mockReturnValue(null);
    mockSaveUserSettings.mockResolvedValue(MOCK_SETTINGS);

    const res = await request(server)
      .post('/api/settings')
      .set('Authorization', 'Bearer tok')
      .send({ autoPromoteEnabled: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, settings: expect.any(Object) });
    expect(mockSaveUserSettings).toHaveBeenCalledWith(
      MOCK_USER.userId,
      expect.objectContaining({ autoPromoteEnabled: true }),
    );
  });

  it('returns 500 on save error', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockValidateSaveInput.mockReturnValue(null);
    mockSaveUserSettings.mockRejectedValue(new Error('Redis timeout'));

    const res = await request(server)
      .post('/api/settings')
      .set('Authorization', 'Bearer tok')
      .send({});
    expect(res.status).toBe(500);
  });
});
