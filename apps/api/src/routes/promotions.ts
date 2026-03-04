/**
 * promotions.ts — Express routes for promotion queue management
 *
 * Mounts under /api/promotions (registered in routes/index.ts)
 *
 * Mirrors these Netlify functions:
 *   GET  /api/promotions/status?jobId=   ← promotion-status.ts
 *   POST /api/promotions/queue           ← queue-promotion.ts
 *   GET  /api/promotions/process         ← promotion-process.ts
 *   POST /api/promotions/process         ← promotion-process.ts
 *   POST /api/promotions/worker          ← promotion-worker.ts
 */

import { Router } from 'express';
import { wrapHandler } from '../lib/netlify-adapter.js';
import { handler as promotionStatusHandler } from '../handlers/promotion-status.js';
import { handler as queuePromotionHandler } from '../handlers/queue-promotion.js';
import { handler as promotionProcessHandler } from '../handlers/promotion-process.js';
import { handler as promotionWorkerHandler } from '../handlers/promotion-worker.js';

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/promotions/status?jobId=
// Returns single job details (if jobId given) or queue stats.
// Mirrors: /.netlify/functions/promotion-status
// ---------------------------------------------------------------------------
router.get('/status', wrapHandler(promotionStatusHandler));

// ---------------------------------------------------------------------------
// POST /api/promotions/queue
// Queue a single or batch of promotion jobs.
// Body: { listingId, adRate, campaignId?, sku? }
//    or { batch: [{ listingId, adRate, campaignId?, sku? }, ...] }
// Mirrors: /.netlify/functions/queue-promotion
// ---------------------------------------------------------------------------
router.post('/queue', wrapHandler(queuePromotionHandler));

// ---------------------------------------------------------------------------
// GET+POST /api/promotions/process
// Internal background promotion processor.
// GET: trigger processing pass
// POST: process a specific job from the queue
// Mirrors: /.netlify/functions/promotion-process
// ---------------------------------------------------------------------------
router.get('/process', wrapHandler(promotionProcessHandler));
router.post('/process', wrapHandler(promotionProcessHandler));

// ---------------------------------------------------------------------------
// POST /api/promotions/worker
// Admin-only long-running promotion worker.
// Mirrors: /.netlify/functions/promotion-worker
// ---------------------------------------------------------------------------
router.post('/worker', wrapHandler(promotionWorkerHandler));

export default router;
