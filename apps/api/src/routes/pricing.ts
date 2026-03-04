import { Router } from 'express';
import { requireUserAuth } from '../../../../src/lib/auth-user.js';
import {
  getPricingDecision,
  type DeliveredPricingSettings,
} from '../../../../src/lib/pricing/index.js';
import { listPriceReductions } from '../../../../src/services/price-reduction.service.js';
import {
  updatePriceReduction,
  BindingNotFoundError,
  UnauthorizedBindingError,
  InvalidReductionParamsError,
} from '../../../../packages/core/src/services/pricing/reduction-update.js';
import { runPriceTick } from '../../../../packages/core/src/services/pricing/tick.js';
import { ok, badRequest, serverError } from '../http/respond.js';

const router = Router();

const DEFAULT_SETTINGS: Partial<DeliveredPricingSettings> = {
  mode: 'market-match',
  shippingEstimateCents: 600,
  minItemCents: 499,
  lowPriceMode: 'FLAG_ONLY',
  useSmartShipping: true,
};

/**
 * POST /api/pricing/reprice
 *
 * Same JSON contract as /.netlify/functions/reprice.
 * Body: { brand?: string; productName?: string }
 */
router.post('/reprice', async (req, res) => {
  try {
    await requireUserAuth(req.headers.authorization || '');

    const { brand, productName } = req.body as {
      brand?: string;
      productName?: string;
    };

    if (!brand && !productName) {
      return badRequest(res, 'brand or productName is required');
    }

    const pricingResult = await getPricingDecision({
      brand: brand || '',
      productName: productName || '',
      settings: DEFAULT_SETTINGS,
    });

    const summary = pricingResult.pricingEvidence?.summary;
    const finalItemCents = pricingResult.finalItemCents ?? 0;
    const finalShipCents = pricingResult.finalShipCents ?? 0;
    const targetDeliveredCents = finalItemCents + finalShipCents;

    return ok(res, {
      success: true,
      suggestedPrice: finalItemCents / 100,
      shippingPrice: finalShipCents / 100,
      freeShipping: summary?.freeShipApplied ?? (finalShipCents === 0),
      canCompete: summary?.canCompete ?? true,
      matchConfidence: summary?.matchConfidence ?? 'medium',
      status: pricingResult.status,
      debug: {
        targetDeliveredCents,
        finalItemCents,
        finalShipCents,
        ebayCompsCount: pricingResult.pricingEvidence?.ebayCompsCount ?? 0,
        retailCompsCount: summary?.retailCompsCount ?? 0,
        amazonPriceCents: summary?.amazonPriceCents ?? null,
        walmartPriceCents: summary?.walmartPriceCents ?? null,
        soldMedianDeliveredCents: summary?.soldMedianDeliveredCents ?? null,
        soldCount: summary?.soldCount ?? 0,
        shippingEstimateSource: summary?.shippingEstimateSource ?? 'default',
        compsSource: summary?.compsSource ?? 'fallback',
        warnings: pricingResult.warnings,
      },
    });
  } catch (err: unknown) {
    console.error('[api/pricing/reprice] Error:', err);
    return serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/pricing/reductions
// List auto price-reduction bindings for the authenticated user.
//
// Mirrors: /.netlify/functions/price-reduction-list
//
// Query params:
//   status — 'active' | 'all' (default: 'all')
//            Use 'active' to filter to items with auto-reduction enabled and running.
// ---------------------------------------------------------------------------
router.get('/reductions', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization || '');
    const status = req.query.status === 'active' ? 'active' : 'all';
    const result = await listPriceReductions(userId, status);
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof Error && err.message.toLowerCase().includes('auth')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/pricing/reductions
// Update the auto price-reduction config for a specific binding.
//
// Mirrors: /.netlify/functions/price-reduction-update
//
// Body: { jobId: string, groupId: string, auto: { reduceBy, reduceByType, everyDays, minPrice } | null }
// ---------------------------------------------------------------------------
router.post('/reductions', async (req, res) => {
  try {
    const { userId } = await requireUserAuth(req.headers.authorization || '');
    const body = req.body as Record<string, unknown>;
    const jobId = (body.jobId as string | undefined)?.trim() ?? '';
    const groupId = (body.groupId as string | undefined)?.trim() ?? '';
    if (!jobId) return badRequest(res, 'jobId required');
    if (!groupId) return badRequest(res, 'groupId required');
    const result = await updatePriceReduction(userId, jobId, groupId, body.auto as any);
    return res.status(200).json({ ok: true, binding: result });
  } catch (err) {
    if (err instanceof BindingNotFoundError) {
      return res.status(404).json({ ok: false, error: err.message });
    }
    if (err instanceof UnauthorizedBindingError) {
      return res.status(403).json({ ok: false, error: err.message });
    }
    if (err instanceof InvalidReductionParamsError) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    if (err instanceof Error && err.message.toLowerCase().includes('auth')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/pricing/tick
// Trigger a price-reduction tick (system / cron use).
//
// Mirrors: /.netlify/functions/price-tick
//
// Body (optional): { dryRun?: boolean, source?: string }
// ---------------------------------------------------------------------------
router.post('/tick', async (req, res) => {
  try {
    await requireUserAuth(req.headers.authorization || '');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const dryRun = body.dryRun === true;
    const source = (body.source as string | undefined) ?? 'http';
    const result = await runPriceTick({ dryRun, source: source as any });
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof Error && err.message.toLowerCase().includes('auth')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return serverError(res, err);
  }
});

export default router;
