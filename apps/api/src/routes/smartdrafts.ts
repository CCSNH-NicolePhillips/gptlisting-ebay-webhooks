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
import { schedulePairingV2Job } from '../../../../src/lib/pairingV2Jobs.js';
import { tokensStore } from '../../../../src/lib/redis-store.js';
import { userScopedKey } from '../../../../src/lib/_auth.js';
import { ok, badRequest, serverError } from '../http/respond.js';
import {
  getDraftLogs,
  getDraftLogsByOfferId,
} from '../../../../src/lib/draft-logs.js';
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
// Start a background pairing-v2 job from a Dropbox folder.
//
// Mirrors: /.netlify/functions/smartdrafts-pairing-v2-start
//
// Body: { folder: string, files?: string[] }
// Response 202: { ok: true, jobId, imageCount }
// ---------------------------------------------------------------------------

async function dropboxAccessTokenFromRefresh(refreshToken: string): Promise<string> {
  const clientId = process.env.DROPBOX_CLIENT_ID;
  const clientSecret = process.env.DROPBOX_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Dropbox client credentials not configured');
  const response = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }).toString(),
  });
  if (!response.ok) throw new Error(`Dropbox token refresh failed: ${response.status} ${await response.text()}`);
  const data: any = await response.json();
  return data.access_token;
}

async function listDropboxImages(accessToken: string, folder: string): Promise<string[]> {
  const response = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: folder === '/' ? '' : folder, recursive: false }),
  });
  if (!response.ok) throw new Error(`Dropbox list_folder failed: ${response.status} ${await response.text()}`);
  const data: any = await response.json();
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
  return (data.entries || [])
    .filter((e: any) => e['.tag'] === 'file' && imageExtensions.includes(e.name.toLowerCase().slice(e.name.lastIndexOf('.'))))
    .map((e: any) => e.path_display || e.path_lower);
}

async function getDropboxTemporaryLinks(accessToken: string, paths: string[]): Promise<string[]> {
  const links: string[] = [];
  for (let i = 0; i < paths.length; i += 25) {
    const batch = paths.slice(i, i + 25);
    const results = await Promise.all(batch.map(async (path) => {
      try {
        const r = await fetch('https://api.dropboxapi.com/2/files/get_temporary_link', {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ path }),
        });
        if (!r.ok) return '';
        const d: any = await r.json();
        return d.link || '';
      } catch { return ''; }
    }));
    links.push(...results);
  }
  return links;
}

router.post('/pairing/v2/start', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization || '');
    const body = req.body as Record<string, unknown>;
    const folder = (body.folder as string | undefined)?.trim() ?? '';
    if (!folder) return badRequest(res, 'folder required');

    const selectedFiles: string[] | undefined = Array.isArray(body.files)
      ? (body.files as string[]).filter(f => typeof f === 'string')
      : undefined;

    // Load Dropbox refresh token from Redis
    const dropboxData = await tokensStore().get(userScopedKey(userId, 'dropbox.json'), { type: 'json' }) as any;
    if (!dropboxData?.refresh_token) {
      return res.status(400).json({ error: 'Dropbox not connected. Please connect your Dropbox account first.' });
    }

    const accessToken = await dropboxAccessTokenFromRefresh(dropboxData.refresh_token);

    let imagePaths = await listDropboxImages(accessToken, folder);

    if (selectedFiles && selectedFiles.length > 0) {
      const selectedLower = new Set(selectedFiles.map(p => p.toLowerCase()));
      imagePaths = imagePaths.filter(p => selectedLower.has(p.toLowerCase()));
    }

    if (imagePaths.length === 0) {
      return res.status(400).json({ error: 'No images found in folder' });
    }

    const originalFilenames = imagePaths.map(p => p.split('/').pop() || 'unknown.jpg');

    let linksOrPaths: string[];
    let needsTempLinks = false;

    if (imagePaths.length <= 25) {
      const tempLinks = await getDropboxTemporaryLinks(accessToken, imagePaths);
      if (!tempLinks.some(l => l)) {
        return res.status(500).json({ error: 'Failed to get temporary links for any images' });
      }
      linksOrPaths = tempLinks;
    } else {
      linksOrPaths = imagePaths;
      needsTempLinks = true;
    }

    const jobId = await schedulePairingV2Job(
      userId, folder, linksOrPaths, accessToken, originalFilenames, needsTempLinks, imagePaths
    );

    return res.status(202).json({ ok: true, jobId, message: 'Pairing-v2 job started', imageCount: linksOrPaths.length });
  } catch (err) {
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
// GET /api/smartdrafts/logs
//
// Returns the full pipeline trace (vision classification, search queries,
// pricing decision, competitor data) for a specific draft.
// Only accessible to authenticated users — returns THEIR own logs only.
//
// Query params (one of):
//   sku     — fetch by SKU / productId
//   offerId — fetch by eBay offer ID (falls back to sku lookup if needed)
//
// Response 200: { ok: true, logs: DraftLogs }
// Response 404: { ok: false, error: 'No logs found' }
// ---------------------------------------------------------------------------
router.get('/logs', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization || '');
    const sku = (req.query.sku as string | undefined)?.trim() ?? '';
    const offerId = (req.query.offerId as string | undefined)?.trim() ?? '';

    if (!sku && !offerId) return badRequest(res, 'Provide sku or offerId');

    let logs = null;
    if (offerId) logs = await getDraftLogsByOfferId(userId, offerId);
    if (!logs && sku) logs = await getDraftLogs(userId, sku);

    if (!logs) return res.status(404).json({ ok: false, error: 'No logs found' });

    return res.status(200).json({ ok: true, logs });
  } catch (err) {
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

