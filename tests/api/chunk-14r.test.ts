/**
 * Express API — Chunk 14R: eBay OAuth, Dropbox OAuth, and disconnect endpoints
 *
 * Tests:  GET  /api/ebay/oauth/start
 *         GET  /api/ebay/oauth/callback
 *         GET  /api/dropbox/oauth/start
 *         GET  /api/dropbox/oauth/callback
 *         POST /api/connections/disconnect
 */

import http from 'http';
import request from 'supertest';
import { jest } from '@jest/globals';

// ── Error class stubs (must match the real signatures for instanceof checks) ──

class EbayOAuthConfigError extends Error {
  readonly statusCode = 500;
  constructor(msg: string) { super(msg); this.name = 'EbayOAuthConfigError'; }
}
class EbayOAuthStateError extends Error {
  readonly statusCode = 400;
  constructor(msg: string) { super(msg); this.name = 'EbayOAuthStateError'; }
}
class EbayOAuthTokenError extends Error {
  readonly statusCode: number;
  readonly detail: Record<string, unknown>;
  constructor(msg: string, status: number, detail: Record<string, unknown>) {
    super(msg); this.name = 'EbayOAuthTokenError';
    this.statusCode = status; this.detail = detail;
  }
}

class DropboxOAuthConfigError extends Error {
  readonly statusCode = 500;
  constructor(msg: string) { super(msg); this.name = 'DropboxOAuthConfigError'; }
}
class DropboxOAuthStateError extends Error {
  readonly statusCode = 400;
  constructor(msg: string) { super(msg); this.name = 'DropboxOAuthStateError'; }
}
class DropboxOAuthTokenError extends Error {
  readonly statusCode: number;
  readonly detail: Record<string, unknown>;
  constructor(msg: string, status: number, detail: Record<string, unknown>) {
    super(msg); this.name = 'DropboxOAuthTokenError';
    this.statusCode = status; this.detail = detail;
  }
}

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../../src/lib/auth-user.js', () => ({
  requireUserAuth: jest.fn(),
}));

jest.mock('../../packages/core/src/services/oauth/ebay-oauth.service.js', () => ({
  startEbayOAuth: jest.fn(),
  callbackEbayOAuth: jest.fn(),
  sanitizeReturnTo: jest.fn((v: unknown) => {
    if (typeof v !== 'string' || !v) return null;
    if (v === 'popup') return 'popup';
    if (v.startsWith('/')) return v;
    return null;
  }),
  EbayOAuthConfigError,
  EbayOAuthStateError,
  EbayOAuthTokenError,
}));

jest.mock('../../packages/core/src/services/oauth/dropbox-oauth.service.js', () => ({
  startDropboxOAuth: jest.fn(),
  callbackDropboxOAuth: jest.fn(),
  sanitizeReturnTo: jest.fn((v: unknown) => {
    if (typeof v !== 'string' || !v) return null;
    if (v === 'popup') return 'popup';
    if (v.startsWith('/')) return v;
    return null;
  }),
  DropboxOAuthConfigError,
  DropboxOAuthStateError,
  DropboxOAuthTokenError,
}));

jest.mock('../../packages/core/src/services/connections/disconnect.service.js', () => ({
  disconnectService: jest.fn(),
}));

// ── Module references ─────────────────────────────────────────────────────────

let server: http.Server;
let mockRequireUserAuth: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockStartEbayOAuth: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockCallbackEbayOAuth: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockStartDropboxOAuth: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockCallbackDropboxOAuth: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
let mockDisconnectService: jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

beforeAll(async () => {
  const { app } = await import('../../apps/api/src/index.js');
  server = app.listen(0);

  const authModule = await import('../../src/lib/auth-user.js');
  mockRequireUserAuth = authModule.requireUserAuth as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

  const ebayOauthModule = await import('../../packages/core/src/services/oauth/ebay-oauth.service.js');
  mockStartEbayOAuth = ebayOauthModule.startEbayOAuth as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
  mockCallbackEbayOAuth = ebayOauthModule.callbackEbayOAuth as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

  const dropboxOauthModule = await import('../../packages/core/src/services/oauth/dropbox-oauth.service.js');
  mockStartDropboxOAuth = dropboxOauthModule.startDropboxOAuth as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
  mockCallbackDropboxOAuth = dropboxOauthModule.callbackDropboxOAuth as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

  const disconnectModule = await import('../../packages/core/src/services/connections/disconnect.service.js');
  mockDisconnectService = disconnectModule.disconnectService as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;
});

afterAll((done) => { server.close(done); });

beforeEach(() => { jest.resetAllMocks(); });

// ── Helpers ───────────────────────────────────────────────────────────────────

const MOCK_USER = { sub: 'auth0|abc123', userId: 'auth0|abc123', email: 'test@example.com' };
const EBAY_AUTH_URL = 'https://auth.ebay.com/oauth2/authorize?client_id=ID&state=nonce123&scope=...';
const DROPBOX_AUTH_URL = 'https://www.dropbox.com/oauth2/authorize?response_type=code&state=nonce456';

// ── GET /api/ebay/oauth/start ─────────────────────────────────────────────────

describe('GET /api/ebay/oauth/start', () => {
  it('redirects (302) to eBay auth URL on success', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockStartEbayOAuth.mockResolvedValue({ redirectUrl: EBAY_AUTH_URL, state: 'nonce123' });

    const res = await request(server)
      .get('/api/ebay/oauth/start')
      .set('Authorization', 'Bearer tok')
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(EBAY_AUTH_URL);
  });

  it('returns JSON redirect URL when mode=json', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockStartEbayOAuth.mockResolvedValue({ redirectUrl: EBAY_AUTH_URL, state: 'nonce123' });

    const res = await request(server)
      .get('/api/ebay/oauth/start?mode=json')
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(200);
    expect(res.body.redirect).toBe(EBAY_AUTH_URL);
  });

  it('returns 401 JSON when authentication fails (mode=json)', async () => {
    mockRequireUserAuth.mockRejectedValue(new Error('auth: missing token'));

    const res = await request(server)
      .get('/api/ebay/oauth/start?mode=json')
      .set('Authorization', 'Bearer bad');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  it('redirects to /login.html when unauthenticated (non-JSON)', async () => {
    mockRequireUserAuth.mockRejectedValue(new Error('auth: missing token'));

    const res = await request(server)
      .get('/api/ebay/oauth/start')
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login.html');
  });

  it('returns 500 when startEbayOAuth throws config error', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockStartEbayOAuth.mockRejectedValue(new EbayOAuthConfigError('Missing EBAY_CLIENT_ID'));

    const res = await request(server)
      .get('/api/ebay/oauth/start?mode=json')
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/EBAY_CLIENT_ID/i);
  });

  it('passes returnTo parameter to startEbayOAuth', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockStartEbayOAuth.mockResolvedValue({ redirectUrl: EBAY_AUTH_URL, state: 'nonce123' });

    await request(server)
      .get('/api/ebay/oauth/start?returnTo=%2Fsettings.html&mode=json')
      .set('Authorization', 'Bearer tok');

    expect(mockStartEbayOAuth).toHaveBeenCalledTimes(1);
    expect((mockStartEbayOAuth.mock.calls[0] as unknown[])[0]).toBe(MOCK_USER.sub);
  });
});

// ── GET /api/ebay/oauth/callback ──────────────────────────────────────────────

describe('GET /api/ebay/oauth/callback', () => {
  it('redirects to returnTo path on success', async () => {
    mockCallbackEbayOAuth.mockResolvedValue({
      sub: MOCK_USER.sub,
      returnTo: '/settings.html',
      isPopup: false,
    });

    const res = await request(server)
      .get('/api/ebay/oauth/callback?code=auth_code&state=nonce123')
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/settings.html');
  });

  it('redirects to /index.html when returnTo is null', async () => {
    mockCallbackEbayOAuth.mockResolvedValue({
      sub: MOCK_USER.sub,
      returnTo: null,
      isPopup: false,
    });

    const res = await request(server)
      .get('/api/ebay/oauth/callback?code=auth_code&state=nonce123')
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/index.html');
  });

  it('returns popup HTML page when isPopup is true', async () => {
    mockCallbackEbayOAuth.mockResolvedValue({
      sub: MOCK_USER.sub,
      returnTo: 'popup',
      isPopup: true,
    });

    const res = await request(server)
      .get('/api/ebay/oauth/callback?code=auth_code&state=nonce123');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('eBay Connected');
    expect(res.text).toContain("service: 'ebay'");
    expect(res.text).toContain('window.close()');
  });

  it('returns 400 when ?code is missing', async () => {
    const res = await request(server)
      .get('/api/ebay/oauth/callback?state=nonce123');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/code/i);
  });

  it('returns 400 when ?state is missing', async () => {
    const res = await request(server)
      .get('/api/ebay/oauth/callback?code=auth_code');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/state/i);
  });

  it('returns 400 with invalid_state when state validation fails', async () => {
    mockCallbackEbayOAuth.mockRejectedValue(
      new EbayOAuthStateError('Invalid or expired state'),
    );

    const res = await request(server)
      .get('/api/ebay/oauth/callback?code=auth_code&state=bad_state');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_state');
    expect(res.body.hint).toBeTruthy();
  });

  it('returns status code from EbayOAuthTokenError', async () => {
    mockCallbackEbayOAuth.mockRejectedValue(
      new EbayOAuthTokenError('eBay token exchange failed', 400, { error: 'invalid_grant' }),
    );

    const res = await request(server)
      .get('/api/ebay/oauth/callback?code=bad_code&state=nonce123');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/token exchange/i);
    expect(res.body.detail).toBeDefined();
  });
});

// ── GET /api/dropbox/oauth/start ──────────────────────────────────────────────

describe('GET /api/dropbox/oauth/start', () => {
  it('redirects (302) to Dropbox auth URL on success', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockStartDropboxOAuth.mockResolvedValue({ redirectUrl: DROPBOX_AUTH_URL, state: 'nonce456' });

    const res = await request(server)
      .get('/api/dropbox/oauth/start')
      .set('Authorization', 'Bearer tok')
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(DROPBOX_AUTH_URL);
  });

  it('returns JSON redirect URL when mode=json', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockStartDropboxOAuth.mockResolvedValue({ redirectUrl: DROPBOX_AUTH_URL, state: 'nonce456' });

    const res = await request(server)
      .get('/api/dropbox/oauth/start?mode=json')
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(200);
    expect(res.body.redirect).toBe(DROPBOX_AUTH_URL);
  });

  it('returns 401 JSON when authentication fails (mode=json)', async () => {
    mockRequireUserAuth.mockRejectedValue(new Error('auth: missing token'));

    const res = await request(server)
      .get('/api/dropbox/oauth/start?mode=json');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  it('returns 500 when startDropboxOAuth throws config error', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockStartDropboxOAuth.mockRejectedValue(new DropboxOAuthConfigError('Missing DROPBOX_CLIENT_ID'));

    const res = await request(server)
      .get('/api/dropbox/oauth/start?mode=json')
      .set('Authorization', 'Bearer tok');

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/DROPBOX_CLIENT_ID/i);
  });
});

// ── GET /api/dropbox/oauth/callback ──────────────────────────────────────────

describe('GET /api/dropbox/oauth/callback', () => {
  it('redirects to /index.html by default on success', async () => {
    mockCallbackDropboxOAuth.mockResolvedValue({
      sub: MOCK_USER.sub,
      returnTo: null,
      isPopup: false,
    });

    const res = await request(server)
      .get('/api/dropbox/oauth/callback?code=dbx_code&state=nonce456')
      .redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/index.html');
  });

  it('returns popup HTML page when isPopup is true', async () => {
    mockCallbackDropboxOAuth.mockResolvedValue({
      sub: MOCK_USER.sub,
      returnTo: 'popup',
      isPopup: true,
    });

    const res = await request(server)
      .get('/api/dropbox/oauth/callback?code=dbx_code&state=nonce456');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('Dropbox Connected');
    expect(res.text).toContain("service: 'dropbox'");
  });

  it('returns 400 when ?code is missing', async () => {
    const res = await request(server)
      .get('/api/dropbox/oauth/callback?state=nonce456');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/code/i);
  });

  it('returns 400 with invalid_state when state validation fails', async () => {
    mockCallbackDropboxOAuth.mockRejectedValue(
      new DropboxOAuthStateError('Invalid or expired state'),
    );

    const res = await request(server)
      .get('/api/dropbox/oauth/callback?code=dbx_code&state=bad');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_state');
  });

  it('returns status code from DropboxOAuthTokenError', async () => {
    mockCallbackDropboxOAuth.mockRejectedValue(
      new DropboxOAuthTokenError('Dropbox token exchange failed', 400, { error: 'invalid_grant' }),
    );

    const res = await request(server)
      .get('/api/dropbox/oauth/callback?code=bad_code&state=nonce456');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/token exchange/i);
  });
});

// ── POST /api/connections/disconnect ─────────────────────────────────────────

describe('POST /api/connections/disconnect', () => {
  it('disconnects eBay successfully', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockDisconnectService.mockResolvedValue({
      ok: true,
      service: 'ebay',
      message: 'ebay disconnected successfully',
    });

    const res = await request(server)
      .post('/api/connections/disconnect')
      .set('Authorization', 'Bearer tok')
      .send({ service: 'ebay' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.service).toBe('ebay');
    expect(mockDisconnectService).toHaveBeenCalledWith(MOCK_USER.userId, 'ebay');
  });

  it('disconnects Dropbox successfully', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockDisconnectService.mockResolvedValue({
      ok: true,
      service: 'dropbox',
      message: 'dropbox disconnected successfully',
    });

    const res = await request(server)
      .post('/api/connections/disconnect')
      .set('Authorization', 'Bearer tok')
      .send({ service: 'dropbox' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.service).toBe('dropbox');
  });

  it('returns 400 for invalid service parameter', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);

    const res = await request(server)
      .post('/api/connections/disconnect')
      .set('Authorization', 'Bearer tok')
      .send({ service: 'github' });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/service/i);
    expect(mockDisconnectService).not.toHaveBeenCalled();
  });

  it('returns 400 when service is missing', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);

    const res = await request(server)
      .post('/api/connections/disconnect')
      .set('Authorization', 'Bearer tok')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('returns 401 when unauthenticated', async () => {
    mockRequireUserAuth.mockRejectedValue(new Error('auth: missing token'));

    const res = await request(server)
      .post('/api/connections/disconnect')
      .send({ service: 'ebay' });

    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });

  it('returns 500 on unexpected service error', async () => {
    mockRequireUserAuth.mockResolvedValue(MOCK_USER);
    mockDisconnectService.mockRejectedValue(new Error('Redis unavailable'));

    const res = await request(server)
      .post('/api/connections/disconnect')
      .set('Authorization', 'Bearer tok')
      .send({ service: 'ebay' });

    expect(res.status).toBe(500);
  });
});
