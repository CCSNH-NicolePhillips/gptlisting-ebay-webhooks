/**
 * listings.ts — Express routes for listing plan generation.
 *
 * Mounts under /api/listings  (registered in routes/index.ts)
 *
 * Mirrors the JSON contracts of these Netlify functions:
 *   GET    /api/listings/plan        ← /.netlify/functions/listing-plan
 */

import { Router } from 'express';
import { requireUserAuth } from '../../../../src/lib/auth-user.js';
import {
  getListingPlan,
  DropboxNotConnectedError,
  SkuNotFoundError,
} from '../../../../src/services/listing-plan.service.js';
import {
  bindListingEntry,
  getBinding,
  getJobBindings,
  deleteBinding,
} from '../../../../packages/core/src/services/listings/bind.js';
import { badRequest, serverError } from '../http/respond.js';

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/listings/plan
// Build a listing plan for a SKU from Dropbox-hosted images.
//
// Reads images from the specified Dropbox folder, computes eBay pricing,
// and returns a structured plan ready for the draft wizard.
//
// Query params:
//   sku     — SKU prefix to match files (required)
//   folder  — Dropbox folder path (default: /EBAY)
// ---------------------------------------------------------------------------
router.get('/plan', async (req, res) => {
  try {
    await requireUserAuth(req.headers.authorization || '');

    const sku = (req.query.sku || req.query.id) as string | undefined;
    const folder = (req.query.folder || req.query.path || '/EBAY') as string;

    if (!sku) {
      return badRequest(res, 'Missing sku');
    }

    // Derive base URL for image-proxy links from the incoming request
    const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const baseUrl = host ? `${proto}://${host}` : null;

    const plan = await getListingPlan(sku, folder, baseUrl as string | null);
    return res.status(200).json({ ok: true, plan });
  } catch (err) {
    if (err instanceof DropboxNotConnectedError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof SkuNotFoundError) {
      return res.status(404).json({ error: err.message });
    }
    if (err instanceof Error && err.message.toLowerCase().includes('auth')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/listings/bind
// Retrieve binding(s) for a job or specific group.
//
// Mirrors: /.netlify/functions/bind-listing (GET)
//
// Query params:
//   jobId   — required
//   groupId — optional; if omitted returns all bindings for the job
// ---------------------------------------------------------------------------
router.get('/bind', async (req, res) => {
  try {
    await requireUserAuth(req.headers.authorization || '');
    const jobId = (req.query.jobId as string | undefined)?.trim() ?? '';
    if (!jobId) return badRequest(res, 'jobId required');
    const groupId = (req.query.groupId as string | undefined)?.trim() ?? '';
    if (groupId) {
      const binding = await getBinding(jobId, groupId);
      return res.status(200).json({ ok: true, binding });
    }
    const bindings = await getJobBindings(jobId);
    return res.status(200).json({ ok: true, bindings });
  } catch (err) {
    if (err instanceof Error && err.message.toLowerCase().includes('auth')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/listings/bind
// Create or update a price-reduction binding for a listing group.
//
// Mirrors: /.netlify/functions/bind-listing (POST)
//
// Body: { jobId, groupId, offerId, sku, price, auto?, ... }
// ---------------------------------------------------------------------------
router.post('/bind', async (req, res) => {
  try {
    await requireUserAuth(req.headers.authorization || '');
    const body = req.body as Record<string, unknown>;
    const jobId = (body.jobId as string | undefined)?.trim() ?? '';
    const groupId = (body.groupId as string | undefined)?.trim() ?? '';
    if (!jobId) return badRequest(res, 'jobId required');
    if (!groupId) return badRequest(res, 'groupId required');
    const result = await bindListingEntry(body as any);
    return res.status(200).json({ ok: true, result });
  } catch (err) {
    if (err instanceof Error && err.message.toLowerCase().includes('auth')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/listings/bind
// Remove a price-reduction binding.
//
// Mirrors: /.netlify/functions/bind-listing (DELETE)
//
// Query params or body:
//   jobId   — required
//   groupId — required
// ---------------------------------------------------------------------------
router.delete('/bind', async (req, res) => {
  try {
    await requireUserAuth(req.headers.authorization || '');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const jobId =
      ((req.query.jobId as string | undefined) ?? (body.jobId as string | undefined) ?? '').trim();
    const groupId =
      ((req.query.groupId as string | undefined) ??
        (body.groupId as string | undefined) ??
        ''
      ).trim();
    if (!jobId) return badRequest(res, 'jobId required');
    if (!groupId) return badRequest(res, 'groupId required');
    await deleteBinding(jobId, groupId);
    return res.status(200).json({ ok: true });
  } catch (err) {
    if (err instanceof Error && err.message.toLowerCase().includes('auth')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return serverError(res, err);
  }
});

export default router;
