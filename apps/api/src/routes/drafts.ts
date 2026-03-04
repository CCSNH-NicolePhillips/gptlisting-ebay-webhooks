/**
 * drafts.ts — Express routes for draft management.
 *
 * Mounts under /api/drafts  (registered in routes/index.ts)
 *
 * Mirrors the JSON contracts of these Netlify functions:
 *   GET    /api/drafts/logs          ← /.netlify/functions/draft-logs-get
 */

import { Router } from 'express';
import { requireUserAuth } from '../../../../src/lib/auth-user.js';
import { fetchDraftLogs } from '../../../../src/services/draft-logs.service.js';
import {
  createEbayDraftsFromGroups,
  BlockingIssuesError,
  MappingError,
  MissingRequiredSpecificsError,
  InvalidLocationError,
  EbayAuthError,
  DraftCreationError,
} from '../../../../packages/core/src/services/drafts/create-draft-user.js';
import { badRequest, serverError } from '../http/respond.js';

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/drafts/logs
// Retrieve AI-reasoning / pricing logs for a specific draft.
//
// Respects the user's `showPricingLogs` setting — returns { enabled: false }
// when the feature is disabled in user settings.
//
// Query params:
//   sku     — look up by inventory SKU
//   offerId — look up by eBay offer ID (fallback if SKU has no logs)
// ---------------------------------------------------------------------------
router.get('/logs', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization || '');

    const sku = req.query.sku as string | undefined;
    const offerId = req.query.offerId as string | undefined;

    if (!sku && !offerId) {
      return badRequest(res, 'Provide sku or offerId');
    }

    const result = await fetchDraftLogs(userId, { sku, offerId });
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof Error && err.message.toLowerCase().includes('auth')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/drafts
// Create eBay draft listings (inventory item + offer) from product groups.
//
// Mirrors: /.netlify/functions/create-ebay-draft-user
//
// Body: { jobId: string, groups: GroupInput[] }
// Response 200: { ok: true, created: number, results: [{sku, offerId, warnings}] }
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization || '');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const jobId = (body.jobId as string | undefined)?.trim() ?? '';
    const groups = Array.isArray(body.groups) ? body.groups : [];
    if (!jobId) return badRequest(res, 'jobId required');
    if (groups.length === 0) return badRequest(res, 'groups array required');
    const results = await createEbayDraftsFromGroups(userId, jobId, groups as any);
    return res.status(200).json({ ok: true, created: results.length, results });
  } catch (err) {
    if (err instanceof BlockingIssuesError) {
      return res.status(400).json({
        ok: false,
        error: err.message,
        groupId: err.groupId,
        attentionReasons: err.attentionReasons,
      });
    }
    if (err instanceof MissingRequiredSpecificsError) {
      return res.status(400).json({
        ok: false,
        error: err.message,
        groupId: err.groupId,
        missing: err.missing,
      });
    }
    if (err instanceof InvalidLocationError) {
      return res.status(400).json({
        ok: false,
        error: err.message,
        groupId: err.groupId,
        availableKeys: err.availableKeys,
      });
    }
    if (err instanceof MappingError) {
      return res.status(400).json({ ok: false, error: err.message, groupId: err.groupId });
    }
    if (err instanceof EbayAuthError) {
      return res.status(502).json({ ok: false, error: err.message });
    }
    if (err instanceof DraftCreationError) {
      return res.status(502).json({ ok: false, error: err.message, groupId: err.groupId });
    }
    if (err instanceof Error && err.message.toLowerCase().includes('auth')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return serverError(res, err);
  }
});

export default router;
