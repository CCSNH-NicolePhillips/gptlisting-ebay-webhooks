/**
 * _template.ts  —  Migration template for a Netlify → Express route
 *
 * Copy this file to apps/api/src/routes/<group>.ts (or add to an existing
 * router file) and follow the inline TODO comments.
 *
 * See also: docs/migration-checklist.md
 *
 * Checklist before opening a PR:
 *   [ ] JSON request/response contract matches the original Netlify function
 *   [ ] HTTP status codes match (200, 400, 404, 500 …)
 *   [ ] Auth guard matches (none / user / admin)
 *   [ ] dryRun flag forwarded for any eBay write operations
 *   [ ] At least one supertest test covers the happy path
 *   [ ] At least one supertest test covers the auth-missing path (if auth required)
 *   [ ] Inventory updated in docs/endpoints-migration.md (status → ported)
 *   [ ] Frontend caller URL updated from /.netlify/functions/<name> → /api/...
 */

import { Router } from 'express';
// TODO: swap these imports for the real location of your business logic
import { requireUserAuth } from '../../../../src/lib/auth-user.js';
import { ok, badRequest, serverError } from '../http/respond.js';

const router = Router();

// ---------------------------------------------------------------------------
// TODO: replace "my-resource" with the actual resource name everywhere below.
// ---------------------------------------------------------------------------

/**
 * GET /api/<group>/my-resource
 *
 * Same JSON contract as /.netlify/functions/<netlify-function-name>.
 *
 * TODO: fill in the real response shape.
 */
router.get('/my-resource', async (req, res) => {
  // --- auth (remove if endpoint is public) ---
  try {
    await requireUserAuth(req.headers.authorization || '');
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // --- validate query params ---
  const { id } = req.query as { id?: string };
  if (!id) {
    return badRequest(res, "'id' query param is required");
  }

  // --- business logic ---
  try {
    // TODO: call the service function that was extracted from the Netlify handler.
    // const result = await myService.getResource(id);
    const result = { id, placeholder: true };

    return ok(res, result);
  } catch (err) {
    return serverError(res, err);
  }
});

/**
 * POST /api/<group>/my-resource
 *
 * Same JSON contract as /.netlify/functions/<netlify-function-name>.
 *
 * TODO: fill in the real request/response shapes.
 */
router.post('/my-resource', async (req, res) => {
  // --- auth (remove if endpoint is public) ---
  try {
    await requireUserAuth(req.headers.authorization || '');
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // --- validate body ---
  const { name } = req.body as { name?: string };
  if (!name) {
    return badRequest(res, "'name' is required");
  }

  // --- business logic ---
  try {
    // TODO: call the service function.
    // const result = await myService.createResource({ name });
    const result = { ok: true, name };

    return ok(res, result);
  } catch (err) {
    return serverError(res, err);
  }
});

export default router;

// ---------------------------------------------------------------------------
// Test skeleton (copy to tests/api/<group>.test.ts)
// ---------------------------------------------------------------------------
/*
import request from 'supertest';
import { app } from '../../apps/api/src/index.js';

describe('GET /api/<group>/my-resource', () => {
  it('returns 400 when id is missing', async () => {
    const res = await request(app)
      .get('/api/<group>/my-resource')
      .set('Authorization', 'Bearer test-token');
    expect(res.status).toBe(400);
  });

  it('returns 200 on happy path', async () => {
    const res = await request(app)
      .get('/api/<group>/my-resource?id=abc')
      .set('Authorization', 'Bearer test-token');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id', 'abc');
  });
});

describe('POST /api/<group>/my-resource', () => {
  it('returns 401 when auth header is missing', async () => {
    const res = await request(app)
      .post('/api/<group>/my-resource')
      .send({ name: 'test' });
    expect(res.status).toBe(401);
  });

  it('returns 400 when name is missing', async () => {
    const res = await request(app)
      .post('/api/<group>/my-resource')
      .set('Authorization', 'Bearer test-token')
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns 200 on happy path', async () => {
    const res = await request(app)
      .post('/api/<group>/my-resource')
      .set('Authorization', 'Bearer test-token')
      .send({ name: 'test' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
  });
});
*/
