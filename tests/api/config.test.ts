/**
 * Express API — GET /api/config
 */

import http from 'http';
import request from 'supertest';

let server: http.Server;

beforeAll(async () => {
  const { app } = await import('../../apps/api/src/index.js');
  server = app.listen(0);
});

afterAll((done) => { server.close(done); });

describe('GET /api/config', () => {
  it('returns 200 with AUTH_MODE when no Auth0 config is set', async () => {
    const saved = { ...process.env };
    delete process.env.AUTH0_DOMAIN;
    delete process.env.AUTH0_CLIENT_ID;
    process.env.AUTH_MODE = 'none';

    const res = await request(server).get('/api/config');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('AUTH_MODE');

    Object.assign(process.env, saved);
  });

  it('returns no-store cache control header', async () => {
    const res = await request(server).get('/api/config');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('includes AUTH0 fields when AUTH0_DOMAIN and CLIENT_ID are set', async () => {
    const saved = { ...process.env };
    process.env.AUTH_MODE = 'user';
    process.env.AUTH0_DOMAIN = 'example.auth0.com';
    process.env.AUTH0_CLIENT_ID = 'client_abc';
    delete process.env.AUTH0_AUDIENCE;

    const res = await request(server).get('/api/config');
    expect(res.status).toBe(200);
    expect(res.body.AUTH_MODE).toBe('auth0');
    expect(res.body.AUTH0_DOMAIN).toBe('example.auth0.com');
    expect(res.body.AUTH0_CLIENT_ID).toBe('client_abc');
    expect(res.body).not.toHaveProperty('AUTH0_AUDIENCE');

    Object.assign(process.env, saved);
  });

  it('includes AUTH_MODE_RAW when mode was normalised', async () => {
    const saved = { ...process.env };
    process.env.AUTH_MODE = 'admin';
    process.env.AUTH0_DOMAIN = 'example.auth0.com';
    process.env.AUTH0_CLIENT_ID = 'client_abc';

    const res = await request(server).get('/api/config');
    expect(res.status).toBe(200);
    expect(res.body.AUTH_MODE).toBe('auth0');
    expect(res.body.AUTH_MODE_RAW).toBe('admin');

    Object.assign(process.env, saved);
  });
});
