/**
 * Express API — GET /api/me
 */

import http from 'http';
import request from 'supertest';
import { jest } from '@jest/globals';

jest.mock('../../src/lib/auth-user.js', () => ({
  requireUserAuth: jest.fn(),
  requireUserAuthFull: jest.fn(),
}));

let server: http.Server;
let mockRequireUserAuthFull: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

beforeAll(async () => {
  const { app } = await import('../../apps/api/src/index.js');
  server = app.listen(0);

  const authModule = await import('../../src/lib/auth-user.js');
  mockRequireUserAuthFull = authModule.requireUserAuthFull as jest.MockedFunction<
    (...args: unknown[]) => Promise<unknown>
  >;
});

beforeEach(() => {
  jest.clearAllMocks();
});

afterAll((done) => { server.close(done); });

describe('GET /api/me', () => {
  it('returns 401 when auth header is missing', async () => {
    mockRequireUserAuthFull.mockRejectedValue(new Error('Missing Authorization header'));

    const res = await request(server).get('/api/me');
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error', 'unauthorized');
  });

  it('returns 401 when token is invalid', async () => {
    mockRequireUserAuthFull.mockRejectedValue(new Error('Token validation failed: bad sig'));

    const res = await request(server).get('/api/me').set('Authorization', 'Bearer bad-token');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
    expect(res.body.detail).toMatch(/failed/i);
  });

  it('returns 200 with sub email and name on happy path', async () => {
    mockRequireUserAuthFull.mockResolvedValue({
      userId: 'auth0|abc123',
      claims: { email: 'alice@example.com', name: 'Alice' },
    });

    const res = await request(server).get('/api/me').set('Authorization', 'Bearer valid-token');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      sub: 'auth0|abc123',
      email: 'alice@example.com',
      name: 'Alice',
    });
  });

  it('omits email and name if not in claims', async () => {
    mockRequireUserAuthFull.mockResolvedValue({
      userId: 'auth0|xyz',
      claims: {},
    });

    const res = await request(server).get('/api/me').set('Authorization', 'Bearer valid-token');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.email).toBeUndefined();
    expect(res.body.name).toBeUndefined();
  });

  it('sets cache-control: no-store', async () => {
    mockRequireUserAuthFull.mockResolvedValue({ userId: 'auth0|x', claims: {} });

    const res = await request(server).get('/api/me').set('Authorization', 'Bearer valid-token');
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
