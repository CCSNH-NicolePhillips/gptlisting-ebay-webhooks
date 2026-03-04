/**
 * Express API — GET /api/status, POST /api/status
 */

import http from 'http';
import request from 'supertest';
import { jest } from '@jest/globals';

jest.mock('../../src/lib/auth-user.js', () => ({
  requireUserAuth: jest.fn(),
  requireUserAuthFull: jest.fn(),
}));

jest.mock('../../src/services/user-status.service.js', () => ({
  getConnectionStatus: jest.fn(),
  disconnectProvider: jest.fn(),
}));

let server: http.Server;
let mockRequireUserAuthFull: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockGetConnectionStatus: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockDisconnectProvider: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

const MOCK_USER = { userId: 'auth0|user1', claims: { email: 'u@test.com', name: 'User' } };
const MOCK_STATUS = {
  dropbox: { connected: true },
  ebay: { connected: false },
  stats: { draftsThisWeek: 3, timeSavedMinutes: 15 },
  user: { email: 'u@test.com', name: 'User' },
};

beforeAll(async () => {
  const { app } = await import('../../apps/api/src/index.js');
  server = app.listen(0);

  const authModule = await import('../../src/lib/auth-user.js');
  mockRequireUserAuthFull = authModule.requireUserAuthFull as jest.MockedFunction<
    (...args: unknown[]) => Promise<unknown>
  >;

  const statusService = await import('../../src/services/user-status.service.js');
  mockGetConnectionStatus = statusService.getConnectionStatus as jest.MockedFunction<
    (...args: unknown[]) => Promise<unknown>
  >;
  mockDisconnectProvider = statusService.disconnectProvider as jest.MockedFunction<
    (...args: unknown[]) => Promise<unknown>
  >;
});

beforeEach(() => jest.clearAllMocks());

afterAll((done) => { server.close(done); });

// ── GET /api/status ──────────────────────────────────────────────────────────

describe('GET /api/status', () => {
  it('returns 401 when auth header is missing', async () => {
    mockRequireUserAuthFull.mockRejectedValue(new Error('Missing Authorization header'));

    const res = await request(server).get('/api/status');
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error', 'unauthorized');
  });

  it('returns 200 with connection status on happy path', async () => {
    mockRequireUserAuthFull.mockResolvedValue(MOCK_USER);
    mockGetConnectionStatus.mockResolvedValue(MOCK_STATUS);

    const res = await request(server).get('/api/status').set('Authorization', 'Bearer tok');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      dropbox: { connected: true },
      ebay: { connected: false },
    });
    expect(mockGetConnectionStatus).toHaveBeenCalledWith(MOCK_USER.userId, MOCK_USER.claims);
  });
});

// ── POST /api/status ─────────────────────────────────────────────────────────

describe('POST /api/status', () => {
  it('returns 401 when unauthenticated', async () => {
    mockRequireUserAuthFull.mockRejectedValue(new Error('Missing Authorization header'));

    const res = await request(server).post('/api/status?dropbox=disconnect');
    expect(res.status).toBe(401);
  });

  it('returns 400 when no disconnect param is provided', async () => {
    mockRequireUserAuthFull.mockResolvedValue(MOCK_USER);

    const res = await request(server)
      .post('/api/status')
      .set('Authorization', 'Bearer tok');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/disconnect/i);
  });

  it('disconnects dropbox and returns ok', async () => {
    mockRequireUserAuthFull.mockResolvedValue(MOCK_USER);
    mockDisconnectProvider.mockResolvedValue(undefined);

    const res = await request(server)
      .post('/api/status?dropbox=disconnect')
      .set('Authorization', 'Bearer tok');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockDisconnectProvider).toHaveBeenCalledWith(MOCK_USER.userId, 'dropbox');
  });

  it('disconnects ebay and returns ok', async () => {
    mockRequireUserAuthFull.mockResolvedValue(MOCK_USER);
    mockDisconnectProvider.mockResolvedValue(undefined);

    const res = await request(server)
      .post('/api/status?ebay=disconnect')
      .set('Authorization', 'Bearer tok');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockDisconnectProvider).toHaveBeenCalledWith(MOCK_USER.userId, 'ebay');
  });
});
