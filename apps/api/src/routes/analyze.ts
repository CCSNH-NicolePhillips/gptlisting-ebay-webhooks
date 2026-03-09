/**
 * analyze.ts — Express routes for analytics, job management and image analysis.
 *
 * Mounts under /api/analyze  (registered in routes/index.ts)
 *
 * Endpoints:
 *   GET  /api/analyze/analytics              ← analyze-analytics.ts
 *   GET  /api/analyze/jobs/:jobId            ← analyze-job.ts        (admin)
 *   GET  /api/analyze/jobs                   ← analyze-jobs.ts       (admin)
 *   GET  /api/analyze/user/jobs              ← analyze-jobs-user.ts  (user)
 *   GET  /api/analyze/images/status          ← analyze-images-status.ts (admin)
 *   GET  /api/analyze/user/images/status     ← analyze-images-status-user.ts (user)
 *   POST /api/analyze/images                 ← analyze-images.ts     (admin, sync)
 *   POST /api/analyze/user/images            ← analyze-images-user.ts (user, sync)
 *   POST /api/analyze/images/bg              ← analyze-images-bg.ts  (admin, bg trigger)
 *   POST /api/analyze/user/images/bg         ← analyze-images-bg-user.ts (user, bg trigger)
 *   POST /api/analyze/images/background      ← analyze-images-background.ts (internal worker)
 *   POST /api/analyze/gpt-drafts             ← ai-gpt-drafts.ts      (user)
 *   GET  /api/analyze/process                ← process.ts            (user, stub)
 */

import crypto from 'crypto';
import { Router } from 'express';
import { requireAdminAuth } from '../../../../src/lib/auth-admin.js';
import { requireUserAuth } from '../../../../src/lib/auth-user.js';
import { serverError } from '../http/respond.js';
import { getAnalytics } from '../../../../packages/core/src/services/analyze/analytics.service.js';
import { fetchJobDetail, fetchJobSummaries } from '../../../../src/lib/job-analytics.js';
import { normalizeJobStatus } from '../../../../src/lib/jobs/job-status.js';
import { listJobsForUser } from '../../../../src/lib/job-store-user.js';
import { getJob, putJob } from '../../../../src/lib/job-store.js';
import { k } from '../../../../src/lib/user-keys.js';
import { runAnalysis } from '../../../../src/lib/analyze-core.js';
import { sanitizeUrls, toDirectDropbox } from '../../../../src/lib/merge.js';
import { canConsumeImages, consumeImages, canStartJob, incRunning, decRunning } from '../../../../src/lib/quota.js';
import { pickCategoryForGroup } from '../../../../src/lib/taxonomy-select.js';
import { openai } from '../../../../src/lib/openai.js';
import { tokensStore } from '../../../../src/lib/redis-store.js';
import { getJwtSubUnverified, userScopedKey, getBearerToken } from '../../../../src/lib/_auth.js';

const router = Router();

// ---------------------------------------------------------------------------
// Helper: derive background base URL
// ---------------------------------------------------------------------------
function appBaseUrl(): string {
  return (
    process.env.APP_URL ||
    process.env.URL ||
    process.env.DEPLOY_PRIME_URL ||
    process.env.DEPLOY_URL ||
    'http://localhost:3001'
  );
}

// ---------------------------------------------------------------------------
// GET /api/analyze/analytics — aggregate pricing data (admin)
// ---------------------------------------------------------------------------
router.get('/analytics', async (req, res) => {
  try {
    requireAdminAuth(req.headers.authorization);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const result = await getAnalytics(limit);
    res.json({ ok: true, ...result });
  } catch (err: unknown) {
    if (err instanceof Error && err.message.toLowerCase().includes('unauthorized')) {
      return void res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/analyze/jobs?limit=  — list job summaries (admin)
// ---------------------------------------------------------------------------
router.get('/jobs', async (req, res) => {
  try {
    requireAdminAuth(req.headers.authorization);
  } catch {
    return void res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const limit = Math.min(200, Math.max(1, Math.trunc(Number(req.query.limit) || 50)));
    const jobs = await fetchJobSummaries(limit);
    res.json({ jobs, count: jobs.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to fetch jobs';
    const status = /upstash/i.test(msg) ? 503 : 500;
    res.status(status).json({ error: msg });
  }
});

// ---------------------------------------------------------------------------
// GET /api/analyze/jobs/:jobId  — single job detail (admin)
// ---------------------------------------------------------------------------
router.get('/jobs/:jobId', async (req, res) => {
  try {
    requireAdminAuth(req.headers.authorization);
  } catch {
    return void res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const jobId = (req.params.jobId || '').trim();
    if (!jobId) return void res.status(400).json({ error: 'Missing jobId' });
    const job = await fetchJobDetail(jobId);
    if (!job) return void res.status(404).json({ error: 'Job not found' });
    res.json({ job });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to load job';
    const status = /upstash/i.test(msg) ? 503 : 500;
    res.status(status).json({ error: msg });
  }
});

// ---------------------------------------------------------------------------
// GET /api/analyze/user/jobs   — list user's own jobs (user)
// ---------------------------------------------------------------------------
router.get('/user/jobs', async (req, res) => {
  let userId: string;
  try {
    ({ userId } = await requireUserAuth(req.headers.authorization || ''));
  } catch {
    return void res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const jobs = await listJobsForUser(userId, 50);
    const simplified = jobs.map((job: any) => ({
      jobId: job.jobId,
      status: normalizeJobStatus(job as Record<string, unknown>),
      startedAt: job.startedAt ?? null,
      finishedAt: job.finishedAt ?? null,
      totalGroups: job.summary?.totalGroups ?? 0,
      warningsCount: Array.isArray(job.warnings) ? job.warnings.length : 0,
    }));
    res.json({ jobs: simplified });
  } catch (err) {
    serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/analyze/images/status?jobId=  — admin job status
// ---------------------------------------------------------------------------
router.get('/images/status', async (req, res) => {
  try {
    requireAdminAuth(req.headers.authorization);
  } catch {
    return void res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const jobId = ((req.query.jobId as string) || '').trim();
    if (!jobId) return void res.status(400).json({ error: 'Missing jobId' });
    const data = await getJob(jobId);
    if (!data) return void res.status(404).json({ error: 'Job not found' });
    res.json(data);
  } catch (err) {
    serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/analyze/user/images/status?jobId=  — user job status
// ---------------------------------------------------------------------------
router.get('/user/images/status', async (req, res) => {
  let userId: string;
  try {
    ({ userId } = await requireUserAuth(req.headers.authorization || ''));
  } catch {
    return void res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const jobId = ((req.query.jobId as string) || '').trim();
    if (!jobId) return void res.status(400).json({ error: 'Missing jobId' });
    const job = await getJob(jobId, { key: k.job(userId, jobId) });
    if (!job) return void res.status(404).json({ error: 'Job not found' });
    res.json(job);
  } catch (err) {
    serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/analyze/images  — sync analysis (admin, ≤3 images)
// ---------------------------------------------------------------------------
router.post('/images', async (req, res) => {
  try {
    requireAdminAuth(req.headers.authorization);
  } catch {
    return void res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const body: any = req.body ?? {};
    const rawImages = Array.isArray(body.images) ? body.images : [];
    const images = sanitizeUrls(rawImages).map(toDirectDropbox);
    if (!images.length) return void res.status(400).json({ error: 'No valid image URLs provided.' });
    if (images.length > 3) {
      return void res.status(202).json({
        status: 'redirect',
        message: 'Use background endpoint for more than 3 images',
        endpoint: '/api/analyze/images/bg',
      });
    }
    const rawBatch = Number(body.batchSize);
    const batchSize = Number.isFinite(rawBatch) ? Math.min(Math.max(rawBatch, 4), 12) : 12;
    const result = await runAnalysis(images, batchSize, { skipPricing: true });
    res.json({ status: 'ok', ...result });
  } catch (err) {
    serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/analyze/user/images  — sync analysis (user, quota-checked, ≤3 images)
// ---------------------------------------------------------------------------
router.post('/user/images', async (req, res) => {
  let userId: string;
  try {
    ({ userId } = await requireUserAuth(req.headers.authorization || ''));
  } catch {
    return void res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const body: any = req.body ?? {};
    const images = sanitizeUrls(Array.isArray(body.images) ? body.images : []).map(toDirectDropbox);
    if (!images.length) return void res.status(400).json({ error: 'No valid image URLs provided.' });
    if (images.length > 3) {
      return void res.status(202).json({ status: 'redirect', endpoint: '/api/analyze/user/images/bg' });
    }
    const allowed = await canConsumeImages(userId, images.length);
    if (!allowed) return void res.status(429).json({ error: 'Daily image quota exceeded' });
    await consumeImages(userId, images.length);
    const rawBatch = Number(body.batchSize);
    const batchSize = Number.isFinite(rawBatch) ? Math.min(Math.max(rawBatch, 4), 12) : 12;
    const result = await runAnalysis(images, batchSize);
    res.json({ ...result, user: true });
  } catch (err) {
    serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/analyze/images/bg  — enqueue background analysis job (admin)
// ---------------------------------------------------------------------------
router.post('/images/bg', async (req, res) => {
  try {
    requireAdminAuth(req.headers.authorization);
  } catch {
    return void res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const body: any = req.body ?? {};
    const rawImages = Array.isArray(body.images) ? body.images : [];
    const images = sanitizeUrls(rawImages).map(toDirectDropbox);
    if (!images.length) return void res.status(400).json({ error: 'No valid image URLs provided.' });

    const rawBatch = Number(body.batchSize);
    const batchSize = Number.isFinite(rawBatch) ? Math.min(Math.max(rawBatch, 4), 12) : 12;
    const userId = typeof body.userId === 'string' && body.userId.trim() ? body.userId.trim() : undefined;
    const jobId = crypto.randomUUID();
    const jobKey = userId ? k.job(userId, jobId) : undefined;

    await putJob(jobId, { jobId, userId, status: 'pending', createdAt: Date.now(), summary: null }, { key: jobKey });

    const backgroundUrl = `${appBaseUrl().replace(/\/$/, '')}/api/analyze/images/background`;
    fetch(backgroundUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, images, batchSize, userId }),
    })
      .then(async (r) => {
        if (r.ok) return;
        const detail = await r.text().catch(() => '');
        await putJob(jobId, { jobId, userId, status: 'failed', finishedAt: Date.now(), error: `${r.status}: ${detail.slice(0, 300)}` }, { key: jobKey });
      })
      .catch(async (err: any) => {
        await putJob(jobId, { jobId, userId, status: 'failed', finishedAt: Date.now(), error: err?.message || 'invoke failed' }, { key: jobKey });
      });

    res.json({ jobId });
  } catch (err) {
    serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/analyze/user/images/bg  — enqueue background analysis job (user, quota-checked)
// ---------------------------------------------------------------------------
router.post('/user/images/bg', async (req, res) => {
  let userId: string;
  try {
    ({ userId } = await requireUserAuth(req.headers.authorization || ''));
  } catch {
    return void res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const body: any = req.body ?? {};
    const images = sanitizeUrls(Array.isArray(body.images) ? body.images : []).map(toDirectDropbox);
    if (!images.length) return void res.status(400).json({ error: 'No valid image URLs provided.' });

    if (!(await canStartJob(userId))) return void res.status(429).json({ error: 'Too many running jobs' });
    if (!(await canConsumeImages(userId, images.length))) return void res.status(429).json({ error: 'Daily image quota exceeded' });

    await incRunning(userId);
    try {
      await consumeImages(userId, images.length);
    } catch (err) {
      await decRunning(userId);
      return void serverError(res, err);
    }

    const rawBatch = Number(body.batchSize);
    const batchSize = Number.isFinite(rawBatch) ? Math.min(Math.max(rawBatch, 4), 12) : 12;
    const force = Boolean(body.force);
    const jobId = crypto.randomUUID();
    const jobKey = k.job(userId, jobId);

    await putJob(jobId, { jobId, userId, state: 'pending', createdAt: Date.now(), summary: null }, { key: jobKey });

    const backgroundUrl = `${appBaseUrl().replace(/\/$/, '')}/api/analyze/images/background`;
    try {
      const resp = await fetch(backgroundUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, images, batchSize, userId, force }),
      });
      if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        await putJob(jobId, { jobId, userId, state: 'error', finishedAt: Date.now(), error: `${resp.status}: ${detail.slice(0, 300)}` }, { key: jobKey });
        await decRunning(userId);
        return void res.status(502).json({ error: 'Background invoke failed', jobId });
      }
    } catch (err: any) {
      await putJob(jobId, { jobId, userId, state: 'error', finishedAt: Date.now(), error: err?.message || 'fetch failed' }, { key: jobKey });
      await decRunning(userId);
      return void res.status(502).json({ error: 'Background fetch exception', jobId });
    }

    res.json({ jobId });
  } catch (err) {
    serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/analyze/images/background  — background worker (internal / no-auth)
// ---------------------------------------------------------------------------
router.post('/images/background', async (req, res) => {
  // This endpoint is called only by the trigger endpoints above.
  // Respond 200 immediately so the caller isn't blocked, then run analysis.
  res.status(200).end();

  const body: any = req.body ?? {};
  const jobId: string | undefined = typeof body.jobId === 'string' ? body.jobId : undefined;
  const userId: string | undefined = typeof body.userId === 'string' && body.userId.trim() ? body.userId.trim() : undefined;
  const jobKey = userId && jobId ? k.job(userId, jobId) : undefined;

  async function releaseSlot() {
    if (!userId) return;
    try { await decRunning(userId); } catch { /* best effort */ }
  }

  if (!jobId) return;

  try {
    const images = Array.isArray(body.images) ? body.images : [];
    const rawBatch = Number(body.batchSize);
    const batchSize = Number.isFinite(rawBatch) ? Math.min(Math.max(rawBatch, 4), 12) : 12;
    const force = Boolean(body.force);

    const sanitizedImages = sanitizeUrls(images).map(toDirectDropbox);
    if (!sanitizedImages.length) {
      await putJob(jobId, { jobId, userId, status: 'failed', finishedAt: Date.now(), error: 'No images provided' }, { key: jobKey });
      await releaseSlot();
      return;
    }

    await putJob(jobId, { jobId, userId, status: 'processing', startedAt: Date.now() }, { key: jobKey });
    try {
      const result = await runAnalysis(sanitizedImages, batchSize, { force });
      await putJob(jobId, {
        jobId, userId, status: 'completed', finishedAt: Date.now(),
        info: result.info, summary: result.summary, warnings: result.warnings, groups: result.groups,
      }, { key: jobKey });
    } catch (err: any) {
      await putJob(jobId, { jobId, userId, status: 'failed', finishedAt: Date.now(), error: err?.message || 'Unknown error' }, { key: jobKey });
    }
    await releaseSlot();
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unexpected error';
    try { await putJob(jobId, { jobId, userId, status: 'failed', finishedAt: Date.now(), error: msg }, { key: jobKey }); } catch { /* best effort */ }
    await releaseSlot();
  }
});

// ---------------------------------------------------------------------------
// POST /api/analyze/gpt-drafts  — GPT-based eBay draft generation (user)
// ---------------------------------------------------------------------------

const GPT_MODEL = process.env.GPT_MODEL || 'gpt-3.5-turbo';
const GPT_MAX_TOKENS = Math.max(100, Math.min(4000, Number(process.env.GPT_MAX_TOKENS || 700)));
const GPT_RETRY_ATTEMPTS = Math.max(1, Number(process.env.GPT_RETRY_ATTEMPTS || 2));
const GPT_RETRY_DELAY_MS = Math.max(250, Number(process.env.GPT_RETRY_DELAY_MS || 1500));

function gptSleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type GptSeed = {
  id?: string; brand?: string; product: string; variant?: string; size?: string;
  features?: string[]; keywords?: string[]; price?: number; folder?: string;
  groupName?: string; options?: Record<string, string[]>;
};
type GptDraft = {
  id?: string; title: string; bullets: string[]; description: string;
  aspects: Record<string, string[]>; category: { id?: string; name?: string };
};

function gptSanitizeString(value: unknown, max = 160): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  return t ? (t.length > max ? t.slice(0, max) : t) : undefined;
}

function gptSanitizeStringArray(value: unknown, maxItems = 12): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.map((e) => gptSanitizeString(e)).filter((e): e is string => typeof e === 'string');
  return out.length ? Array.from(new Set(out)).slice(0, maxItems) : undefined;
}

function gptNormalizeSeed(input: any): GptSeed | null {
  if (!input || typeof input !== 'object') return null;
  const product = gptSanitizeString(input.product, 200);
  if (!product) return null;
  return {
    product, id: gptSanitizeString(input.id, 80), brand: gptSanitizeString(input.brand, 120),
    variant: gptSanitizeString(input.variant, 120), size: gptSanitizeString(input.size, 80),
    features: gptSanitizeStringArray(input.features, 16), keywords: gptSanitizeStringArray(input.keywords, 20),
    price: (() => { const n = Number(input.price); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : undefined; })(),
    folder: gptSanitizeString(input.folder, 240), groupName: gptSanitizeString(input.groupName, 160),
  };
}

async function gptCallOpenAI(prompt: string): Promise<string> {
  if (!process.env.OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY');
  let lastError: unknown;
  for (let attempt = 1; attempt <= GPT_RETRY_ATTEMPTS; attempt++) {
    try {
      const completion = await openai.chat.completions.create({
        model: GPT_MODEL, temperature: 0.7, max_tokens: GPT_MAX_TOKENS,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are an expert eBay listing writer.\nReturn ONLY strict JSON with keys: title, bullets, description, aspects, category.\n- title: <=80 chars.\n- bullets: array of 3 short points.\n- description: 2-4 sentences.\n- aspects: include Brand if given.\n- category: {name:"<best>", id:""} (leave id blank if unsure).' },
          { role: 'user', content: prompt },
        ],
      });
      return completion.choices?.[0]?.message?.content || '{}';
    } catch (err) {
      lastError = err;
      if (attempt < GPT_RETRY_ATTEMPTS) await gptSleep(GPT_RETRY_DELAY_MS * attempt);
    }
  }
  throw new Error(lastError instanceof Error ? lastError.message : String(lastError || 'OpenAI error'));
}

function gptBuildDraft(seed: GptSeed, parsed: any, hint: { id: string; title: string } | null): GptDraft {
  const title = gptSanitizeString(parsed?.title, 80) || `${seed.brand ? `${seed.brand} ` : ''}${seed.product}`.slice(0, 80);
  const rawBullets = Array.isArray(parsed?.bullets) ? parsed.bullets : [];
  const bullets = rawBullets.map((e: unknown) => gptSanitizeString(e, 200)).filter((e: any): e is string => typeof e === 'string').slice(0, 3);
  const description = gptSanitizeString(parsed?.description, 1200) || `${title}.`;
  const aspects: Record<string, string[]> = {};
  if (parsed?.aspects && typeof parsed.aspects === 'object') {
    for (const [key, value] of Object.entries(parsed.aspects as Record<string, unknown>)) {
      const name = gptSanitizeString(key, 80);
      if (!name) continue;
      const arr = Array.isArray(value) ? value : [value];
      const vals = arr.map((e) => gptSanitizeString(e, 160)).filter((e): e is string => typeof e === 'string');
      if (vals.length) aspects[name] = Array.from(new Set(vals)).slice(0, 10);
    }
  }
  if (seed.brand && !aspects.Brand?.includes(seed.brand)) aspects.Brand = [seed.brand, ...(aspects.Brand || [])].slice(0, 3);
  const rawCat = parsed?.category && typeof parsed.category === 'object' ? parsed.category : {};
  return { id: seed.id, title, bullets, description, aspects, category: { name: gptSanitizeString((rawCat as any).name, 120) || hint?.title, id: gptSanitizeString((rawCat as any).id, 40) || hint?.id || '' } };
}

router.post('/gpt-drafts', async (req, res) => {
  try {
    await requireUserAuth(req.headers.authorization || '');
  } catch {
    return void res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  try {
    const payload: any = req.body ?? {};
    const rawSeeds: any[] = Array.isArray(payload?.seeds) ? payload.seeds : [];
    if (!rawSeeds.length) return void res.status(400).json({ ok: false, error: 'Provide {seeds:[...]}' });

    const drafts: GptDraft[] = [];
    for (const raw of rawSeeds) {
      const seed = gptNormalizeSeed(raw);
      if (!seed) { drafts.push({ id: undefined, title: '', bullets: [], description: 'ERROR: invalid seed', aspects: {}, category: {} }); continue; }
      try {
        let hint: any = null;
        try { hint = await pickCategoryForGroup({ brand: seed.brand, product: seed.product, variant: seed.variant, size: seed.size, claims: seed.features, keywords: seed.keywords }) ?? null; } catch { /* best effort */ }
        const hintObj = hint ? { id: (hint as any).id, title: (hint as any).title } : null;
        const lines = [
          `Brand: ${seed.brand || 'Unknown'}`, `Product: ${seed.product}`,
          ...(seed.variant ? [`Variant: ${seed.variant}`] : []),
          ...(seed.size ? [`Size: ${seed.size}`] : []),
          ...(seed.features?.length ? [`Features: ${seed.features.join(', ')}`] : []),
          ...(seed.keywords?.length ? [`Keywords: ${seed.keywords.join(', ')}`] : []),
          ...(typeof seed.price === 'number' ? [`Price hint: $${seed.price.toFixed(2)}`] : []),
          ...(hintObj ? [`Suggested eBay category: ${hintObj.title} (${hintObj.id})`] : []),
          'Fill optional fields when present, keep tone factual.',
        ];
        const rawResponse = await gptCallOpenAI(`Create an eBay-ready draft from:\n${lines.join('\n')}`);
        let parsed: any = {};
        try { parsed = JSON.parse(rawResponse); } catch (e) { throw new Error(`Invalid JSON from OpenAI: ${(e as Error).message}`); }
        drafts.push(gptBuildDraft(seed, parsed, hintObj));
      } catch (err: any) {
        drafts.push({ id: seed.id, title: '', bullets: [], description: `ERROR: ${err?.message || 'generation failed'}`, aspects: seed.brand ? { Brand: [seed.brand] } : {}, category: {} });
      }
    }
    res.json({ ok: true, count: drafts.length, drafts });
  } catch (err) {
    serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/analyze/process  — check Dropbox + eBay connectivity (user, stub)
// ---------------------------------------------------------------------------
router.get('/process', async (req, res) => {
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '').trim() || '';
  if (!bearer) return void res.status(401).json({ ok: false, error: 'Unauthorized' });
  try {
    // Quick connectivity check: ensure both Dropbox and eBay tokens exist
    const tokens = tokensStore();
    // Lightweight sub extraction without full JWT verification (matches Netlify version)
    const mockEvent = { headers: { authorization: req.headers.authorization || '' } } as any;
    const sub = getJwtSubUnverified(mockEvent);
    const testBearer = getBearerToken(mockEvent);
    if (!testBearer || !sub) return void res.status(401).json({ ok: false, error: 'Unauthorized' });

    const [dbx, ebay] = await Promise.all([
      tokens.get(userScopedKey(sub, 'dropbox.json'), { type: 'json' }) as Promise<any>,
      tokens.get(userScopedKey(sub, 'ebay.json'), { type: 'json' }) as Promise<any>,
    ]);
    if (!dbx?.refresh_token || !ebay?.refresh_token) {
      return void res.status(400).json({ ok: false, error: 'Connect Dropbox and eBay first' });
    }
    res.json({ ok: true, created: 0 });
  } catch (err) {
    serverError(res, err);
  }
});

export default router;
