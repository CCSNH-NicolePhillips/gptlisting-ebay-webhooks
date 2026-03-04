import { Router } from 'express';
import { requireUserAuth } from '../../../../src/lib/auth-user.js';
import {
  createDraftForProduct,
  type PairedProduct,
  type Draft,
} from '../../../../src/services/smartdrafts-create-drafts.service.js';
import { getJobStatus, JobNotFoundError } from '../../../../src/services/job-status.service.js';
import { normalizeJobStatus } from '../../../../src/lib/jobs/job-status.js';
import { saveDrafts, type SaveDraftsInput } from '../../../../src/services/smartdrafts-save-drafts.service.js';
import { getDraft } from '../../../../src/services/smartdrafts-get-draft.service.js';
import {
  startCreateDraftsJob,
  startScanJob,
  QuotaExceededError,
  BgInvokeError,
} from '../../../../packages/core/src/services/smartdrafts/bg-jobs.js';
import { resetSmartDrafts } from '../../../../packages/core/src/services/smartdrafts/reset.js';
import {
  updateDraft,
  InvalidDraftError,
  EbayApiError as SmartdraftsEbayApiError,
} from '../../../../packages/core/src/services/smartdrafts/update-draft.js';
import {
  startPairingV2Job,
  getPairingV2Status,
  PairingJobNotFoundError,
  InvalidPairingParamsError,
} from '../../../../packages/core/src/services/smartdrafts/pairing-v2.js';
import { EbayNotConnectedError } from '../../../../src/lib/ebay-client.js';
import { ok, badRequest, serverError } from '../http/respond.js';
import { runDirectScan } from '../../../../packages/core/src/services/smartdrafts/scan-direct.service.js';
import {
  startPairingFromScan,
  ScanJobNotFoundError,
  ScanJobNotCompleteError,
  PairingFromScanError,
} from '../../../../packages/core/src/services/smartdrafts/pairing-from-scan.service.js';
import {
  startQuickList,
  getQuickListStatus,
  QuickListNotFoundError,
} from '../../../../packages/core/src/services/smartdrafts/quick-list.service.js';
import { wrapHandler } from '../lib/netlify-adapter.js';
import { handler as createDraftsBgHandler } from '../handlers/smartdrafts-create-drafts-background.js';
import { handler as scanBackgroundHandler } from '../handlers/smartdrafts-scan-background.js';
import { handler as quickListProcessorHandler } from '../handlers/smartdrafts-quick-list-processor.js';
import { handler as pairingBgHandler } from '../handlers/pairing-v2-processor-background.js';

const router = Router();

/**
 * POST /api/smartdrafts/create-drafts
 *
 * Identical JSON contract to /.netlify/functions/smartdrafts-create-drafts.
 * Body: { products: PairedProduct[], promotion?: { enabled: boolean, rate: number | null } }
 *
 * Response 200:
 *   { ok: true, drafts: Draft[], errors?: ..., summary: { total, succeeded, failed } }
 * Response 400: { ok: false, error: string }
 */
router.post('/create-drafts', async (req, res) => {
  try {
    await requireUserAuth(req.headers.authorization || '');

    const body = req.body as { products?: unknown };
    const rawProducts: PairedProduct[] = Array.isArray(body?.products)
      ? (body.products as PairedProduct[])
      : [];

    if (rawProducts.length === 0) {
      return badRequest(res, 'No products provided. Expected { products: [...] }');
    }

    const drafts: Draft[] = [];
    const errors: Array<{ productId: string; error: string }> = [];

    for (const product of rawProducts) {
      try {
        const draft = await createDraftForProduct(product);
        // Gating: NEEDS_REVIEW drafts are included but preserved as-is (not auto-published)
        drafts.push(draft);
      } catch (err) {
        errors.push({
          productId: product.productId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return ok(res, {
      ok: true,
      drafts,
      errors: errors.length > 0 ? errors : undefined,
      summary: {
        total: rawProducts.length,
        succeeded: drafts.length,
        failed: errors.length,
      },
    });
  } catch (err) {
    console.error('[api/smartdrafts/create-drafts]', err);
    return serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/smartdrafts/scan
//
// Synchronous in-process SmartDrafts scan (no background job).
//
// Mirrors: /.netlify/functions/smartdrafts-scan
//
// Body: { path: string, force?: boolean, limit?: number, debug?: boolean }
// Response 200: { ok, cached, folder, signature, count, warnings, groups, imageInsights }
// ---------------------------------------------------------------------------
router.post('/scan', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization || '');
    const body = req.body as { path?: string; force?: boolean; limit?: number; debug?: boolean };
    const folder = body?.path || '';
    if (!folder) return void badRequest(res, 'Missing path');
    const result = await runDirectScan(userId, folder, {
      force: !!body.force,
      limit: body.limit ? Number(body.limit) : undefined,
      debug: !!body.debug,
    });
    res.json(result);
  } catch (err: unknown) {
    if (err instanceof Error && err.message.toLowerCase().includes('auth')) {
      return void res.status(401).json({ error: 'Unauthorized' });
    }
    serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/smartdrafts/create-drafts/start
// Start a background create-drafts job.
//
// Mirrors: /.netlify/functions/smartdrafts-create-drafts-bg
//
// Body: { products: PairedProduct[], promotion?: { enabled: boolean, rate: number | null } }
// Response 202: { ok: true, jobId }
// ---------------------------------------------------------------------------
router.post('/create-drafts/start', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization || '');
    const body = req.body as Record<string, unknown>;
    const products = Array.isArray(body?.products) ? body.products : [];
    if (products.length === 0) return badRequest(res, 'products array required');
    const promotion = body?.promotion as any;
    const { jobId } = await startCreateDraftsJob(userId, products, promotion);
    return res.status(202).json({ ok: true, jobId });
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      return res.status(429).json({ ok: false, error: err.message });
    }
    if (err instanceof BgInvokeError) {
      return res.status(502).json({ ok: false, error: err.message });
    }
    if (err instanceof Error && err.message.toLowerCase().includes('auth')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/smartdrafts/scan/start
// Start a background vision-scan job.
//
// Mirrors: /.netlify/functions/smartdrafts-scan-bg
//
// Body: { jobId: string, files: string[], ... scan params }
// Response 202: { ok: true, jobId }
// ---------------------------------------------------------------------------
router.post('/scan/start', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization || '');
    const body = req.body as Record<string, unknown>;
    const jobId = (body.jobId as string | undefined)?.trim() ?? '';
    if (!jobId) return badRequest(res, 'jobId required');
    const files = Array.isArray(body.files) ? body.files as string[] : [];
    if (files.length === 0) return badRequest(res, 'files array required');
    const result = await startScanJob(userId, body as any);
    return res.status(202).json({ ok: true, jobId: result.jobId });
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      return res.status(429).json({ ok: false, error: err.message });
    }
    if (err instanceof BgInvokeError) {
      return res.status(502).json({ ok: false, error: err.message });
    }
    if (err instanceof Error && err.message.toLowerCase().includes('auth')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/smartdrafts/reset
// Clear all SmartDrafts job data for the authenticated user.
//
// Mirrors: /.netlify/functions/smartdrafts-reset
//
// Response 200: { ok: true, cleared: number }
// ---------------------------------------------------------------------------
router.post('/reset', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization || '');
    const result = await resetSmartDrafts(userId);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof Error && err.message.toLowerCase().includes('auth')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// PUT /api/smartdrafts/drafts/:offerId
// Update an eBay offer and its inventory item with new draft data.
//
// Mirrors: /.netlify/functions/smartdrafts-update-draft
//
// Body: DraftUpdate (title, description, images, price, condition, aspects, ...)
// Response 200: { ok: true }
// ---------------------------------------------------------------------------
router.put('/drafts/:offerId', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization || '');
    const { offerId } = req.params;
    if (!offerId) return badRequest(res, 'offerId required');
    const result = await updateDraft(userId, offerId, req.body as any);
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof InvalidDraftError) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    if (err instanceof SmartdraftsEbayApiError) {
      return res.status(err.statusCode).json({ ok: false, error: err.message, detail: err.body });
    }
    if (err instanceof EbayNotConnectedError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof Error && err.message.toLowerCase().includes('auth')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/smartdrafts/pairing/v2/start
// Start a background pairing-v2 job.
//
// Mirrors: /.netlify/functions/smartdrafts-pairing-v2-start
//
// Body: { jobId: string, items: ClassifiedItem[], ... }
// Response 202: { ok: true, jobId }
// ---------------------------------------------------------------------------
router.post('/pairing/v2/start', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization || '');
    const body = req.body as Record<string, unknown>;
    const jobId = (body.jobId as string | undefined)?.trim() ?? '';
    if (!jobId) return badRequest(res, 'jobId required');
    const result = await startPairingV2Job(userId, body as any);
    return res.status(202).json({ ok: true, jobId: result.jobId });
  } catch (err) {
    if (err instanceof InvalidPairingParamsError) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    if (err instanceof Error && err.message.toLowerCase().includes('auth')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/smartdrafts/pairing/v2/status
// Poll the status of a pairing-v2 background job.
//
// Mirrors: /.netlify/functions/smartdrafts-pairing-v2-status
//
// Query params:
//   jobId — required
// ---------------------------------------------------------------------------
router.get('/pairing/v2/status', async (req, res) => {
  try {
    await requireUserAuth(req.headers.authorization || '');
    const jobId = (req.query.jobId as string | undefined)?.trim() ?? '';
    if (!jobId) return badRequest(res, 'jobId required');
    const result = await getPairingV2Status(jobId);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof PairingJobNotFoundError) {
      return res.status(404).json({ ok: false, error: err.message });
    }
    if (err instanceof Error && err.message.toLowerCase().includes('auth')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/smartdrafts/create-drafts/status
// Poll the status of a background create-drafts job.
//
// Mirrors: /.netlify/functions/smartdrafts-create-drafts-status?jobId=xxx
//
// Query params:
//   jobId — background job ID (required)
// ---------------------------------------------------------------------------
router.get('/create-drafts/status', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization || '');
    const jobId = (req.query.jobId as string | undefined)?.trim() ?? '';
    if (!jobId) return badRequest(res, 'Provide jobId');
    const result = await getJobStatus(userId, jobId);
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof JobNotFoundError) {
      return res.status(404).json({ ok: false, error: err.message });
    }
    if (err instanceof Error && err.message.toLowerCase().includes('auth')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/smartdrafts/scan/status
// Poll the status of a background scan/vision job.
//
// Mirrors: /.netlify/functions/smartdrafts-scan-status?jobId=xxx
//
// Query params:
//   jobId — background job ID (required)
// ---------------------------------------------------------------------------
router.get('/scan/status', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization || '');
    const jobId = (req.query.jobId as string | undefined)?.trim() ?? '';
    if (!jobId) return badRequest(res, 'Provide jobId');
    const result = await getJobStatus(userId, jobId);
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof JobNotFoundError) {
      return res.status(404).json({ ok: false, error: err.message });
    }
    if (err instanceof Error && err.message.toLowerCase().includes('auth')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/smartdrafts/drafts
// Convert ChatGPT-generated drafts to eBay draft format.
//
// Mirrors: /.netlify/functions/smartdrafts-save-drafts
//
// Body: { jobId: string, drafts: ChatGptDraft[] }
// Response 200: { ok: true, groups: EbayDraftGroup[], count: number, jobId: string }
// ---------------------------------------------------------------------------
router.post('/drafts', async (req, res) => {
  try {
    await requireUserAuth(req.headers.authorization || '');
    const body = req.body as Partial<SaveDraftsInput>;
    if (!body.jobId) return badRequest(res, 'jobId required');
    if (!Array.isArray(body.drafts) || body.drafts.length === 0) {
      return badRequest(res, 'drafts array required');
    }
    const result = saveDrafts({ jobId: body.jobId, drafts: body.drafts });
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof Error && err.message.toLowerCase().includes('auth')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/smartdrafts/drafts
// Fetch eBay offer data in draft-edit format (offer + inventory + category aspects).
//
// Mirrors: /.netlify/functions/smartdrafts-get-draft?offerId=xxx
//
// Query params:
//   offerId — eBay offer ID to fetch (required)
// ---------------------------------------------------------------------------
router.get('/drafts', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization || '');
    const offerId = (req.query.offerId as string | undefined)?.trim() ?? '';
    if (!offerId) return badRequest(res, 'Missing offerId parameter');
    const result = await getDraft(userId, offerId);
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof EbayNotConnectedError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof Error && (err as any).statusCode) {
      return res.status((err as any).statusCode).json({ ok: false, error: err.message, detail: (err as any).detail });
    }
    if (err instanceof Error && err.message.toLowerCase().includes('auth')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/smartdrafts/analyze
//
// Trigger a vision classify + group scan of a Dropbox folder and wait for
// completion (polls internally, 120 s hard timeout).
//
// Mirrors: /.netlify/functions/smartdrafts-analyze
//
// Query params:
//   folder — Dropbox folder path (required)
//   force  — "true" to bypass cache and rescan
//
// Response 200: { ok: true, groups, imageInsights, cached, folder, jobId }
// Response 504: { error: 'Scan timeout', jobId }
// ---------------------------------------------------------------------------
router.get('/analyze', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization || '');
    const folder = (req.query.folder as string | undefined)?.trim() ?? '';
    const force = req.query.force === 'true';

    if (!folder) {
      return badRequest(res, 'folder parameter required');
    }

    // Start background scan job
    const { jobId } = await startScanJob(userId, { folder, force });

    // Poll until complete or timeout (120 s)
    const TIMEOUT_MS = 120_000;
    const POLL_INTERVAL_MS = 1_500;
    const deadline = Date.now() + TIMEOUT_MS;

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));

    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      try {
        const { job } = await getJobStatus(userId, jobId);
        const status = normalizeJobStatus(job as Record<string, unknown>);

        if (status === 'completed') {
          return res.status(200).json({
            ok: true,
            jobId,
            folder,
            groups: (job as any).result?.groups ?? [],
            imageInsights: (job as any).result?.imageInsights ?? [],
            cached: (job as any).result?.cached ?? false,
          });
        }
        if (status === 'failed') {
          return res.status(500).json({
            ok: false,
            error: (job as any).error || 'Scan failed',
            jobId,
          });
        }
      } catch (pollErr) {
        if (pollErr instanceof JobNotFoundError) {
          // Job may not be persisted yet; wait and retry
          continue;
        }
        throw pollErr;
      }
    }

    // Timed out
    return res.status(504).json({ ok: false, error: 'Scan timeout', jobId });
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      return res.status(429).json({ ok: false, error: err.message });
    }
    if (err instanceof Error && err.message.toLowerCase().includes('auth')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/smartdrafts/pairing/v2/start-local
//
// Start a pairing-v2 job for a set of pre-staged image URLs
// (uploaded via local-init + local-complete).
//
// Mirrors: /.netlify/functions/smartdrafts-pairing-v2-start-local
//
// Body: { stagedUrls: string[] }
//
// Response 202: { ok: true, jobId: string, imageCount: number }
// Response 400: missing / invalid stagedUrls
// ---------------------------------------------------------------------------
router.post('/pairing/v2/start-local', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization || '');
    const body = req.body as { stagedUrls?: unknown };

    if (!Array.isArray(body?.stagedUrls) || (body.stagedUrls as unknown[]).length === 0) {
      return badRequest(res, 'Missing or invalid stagedUrls (must be a non-empty array)');
    }

    const stagedUrls = body.stagedUrls as string[];
    const { jobId } = await startPairingV2Job(userId, { stagedUrls });

    return res.status(202).json({ ok: true, jobId, imageCount: stagedUrls.length });
  } catch (err) {
    if (err instanceof InvalidPairingParamsError) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    if (err instanceof QuotaExceededError) {
      return res.status(429).json({ ok: false, error: err.message });
    }
    if (err instanceof Error && err.message.toLowerCase().includes('auth')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/smartdrafts/pairing/v2/start-from-scan
//
// Start a pairing-v2 job seeded from a completed scan job.
//
// Mirrors: /.netlify/functions/smartdrafts-pairing-v2-start-from-scan
//
// Body: { scanJobId: string }
// Response 202: { ok: true, jobId, imageCount, uploadMethod }
// ---------------------------------------------------------------------------
router.post('/pairing/v2/start-from-scan', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization || '');
    const body = req.body as { scanJobId?: string };
    if (!body?.scanJobId) return void badRequest(res, 'Missing scanJobId');
    const result = await startPairingFromScan(userId, body.scanJobId);
    res.status(202).json(result);
  } catch (err: unknown) {
    if (err instanceof ScanJobNotFoundError) return void res.status(404).json({ ok: false, error: err.message });
    if (err instanceof ScanJobNotCompleteError) return void res.status(400).json({ ok: false, error: err.message });
    if (err instanceof PairingFromScanError) return void res.status(500).json({ ok: false, error: err.message });
    if (err instanceof Error && err.message.toLowerCase().includes('auth')) {
      return void res.status(401).json({ error: 'Unauthorized' });
    }
    serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/smartdrafts/quick-list
//
// Create a quick-list pipeline job.
//
// Mirrors: /.netlify/functions/smartdrafts-quick-list-pipeline (POST)
//
// Body: { scanJobId?: string }
// Response 200: { ok: true, jobId }
// ---------------------------------------------------------------------------
router.post('/quick-list', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization || '');
    const body = req.body as { scanJobId?: string };
    const result = await startQuickList(userId, body?.scanJobId);
    res.json(result);
  } catch (err: unknown) {
    if (err instanceof Error && err.message.toLowerCase().includes('auth')) {
      return void res.status(401).json({ error: 'Unauthorized' });
    }
    serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/smartdrafts/quick-list
//
// Get the status of a quick-list pipeline job.
//
// Mirrors: /.netlify/functions/smartdrafts-quick-list-pipeline (GET)
//
// Query: ?jobId=<uuid>
// Response 200: QuickListJob
// ---------------------------------------------------------------------------
router.get('/quick-list', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization || '');
    const jobId = req.query.jobId as string;
    if (!jobId) return void badRequest(res, 'Missing jobId query param');
    const job = await getQuickListStatus(userId, jobId);
    res.json({ ok: true, ...job });
  } catch (err: unknown) {
    if (err instanceof QuickListNotFoundError) return void res.status(404).json({ ok: false, error: err.message });
    if (err instanceof Error && err.message.toLowerCase().includes('auth')) {
      return void res.status(401).json({ error: 'Unauthorized' });
    }
    serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Background worker endpoints — invoked internally by bg-jobs.ts
// These are long-running task processors, not user-facing API endpoints.
// ---------------------------------------------------------------------------

// POST /api/smartdrafts/create-drafts/background
// Long-running background job that generates eBay draft listings.
// Mirrors: /.netlify/functions/smartdrafts-create-drafts-background
router.post('/create-drafts/background', wrapHandler(createDraftsBgHandler));

// POST /api/smartdrafts/scan/background
// Background image scan + classification job.
// Mirrors: /.netlify/functions/smartdrafts-scan-background
router.post('/scan/background', wrapHandler(scanBackgroundHandler));

// POST /api/smartdrafts/quick-list/process
// Background quick-list pipeline processor.
// Mirrors: /.netlify/functions/smartdrafts-quick-list-processor
router.post('/quick-list/process', wrapHandler(quickListProcessorHandler));

// POST /api/smartdrafts/pairing/background
// Background pairing-v2 processor.
// Mirrors: /.netlify/functions/pairing-v2-processor-background
router.post('/pairing/background', wrapHandler(pairingBgHandler));

export default router;

