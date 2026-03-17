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
import { getPolicyDefaults, getPolicy } from '../../../../packages/core/src/services/ebay/policies.service.js';
import { hasFreeShipping } from '../../../../src/lib/policy-helpers.js';

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
    const { userId } = await requireUserAuth(req.headers.authorization || '');

    const { brand, productName, ebayTitle, servingCount } = req.body as {
      brand?: string;
      productName?: string;
      ebayTitle?: string;
      servingCount?: number | null;
    };

    console.log(`[reprice] RAW body: brand="${brand}" productName="${String(productName).slice(0, 120)}" ebayTitle="${String(ebayTitle || '').slice(0, 80)}" servingCount=${servingCount ?? 'null'}`);

    if (!brand && !productName) {
      return badRequest(res, 'brand or productName is required');
    }

    // Normalise productName: strip the brand prefix if the frontend didn't already,
    // then truncate at common eBay title separators ("|", " by ", ",").
    // e.g. "Root ReLive Greens by Dr. Rahm's | Superfood Powerhouse..." → "ReLive Greens"
    // This ensures the brand-registry Redis key always matches the pinned short name
    // regardless of which frontend version (or browser cache) sent the request.
    let cleanBrand = (brand || '').trim();
    let cleanProduct = (productName || '').trim();
    if (cleanBrand && cleanProduct.toLowerCase().startsWith(cleanBrand.toLowerCase())) {
      cleanProduct = cleanProduct.slice(cleanBrand.length).replace(/^[\s\-–—]+/, '');
    }
    cleanProduct = cleanProduct.split(/\s+by\s+|\s*[|,]\s*/i)[0].trim();
    console.log(`[reprice] Normalised: brand="${cleanBrand}" productName="${cleanProduct}" (raw: "${brand}" / "${productName}")`);

    // Cross-validate classification brand against the eBay offer title.
    // When the scan misidentifies a product (e.g. classifies "Root ReLive Greens" images as
    // "beam Kids All-In-One Superpowder"), the brand will NOT appear anywhere in the eBay
    // listing title.  In that case derive brand/productName from the eBay title instead
    // so the Amazon price lookup targets the correct product.
    let finalBrand = cleanBrand;
    let finalProduct = cleanProduct;
    let additionalContext: string | undefined;

    const titleStr = (ebayTitle || '').trim();
    if (titleStr) {
      const brandInTitle = finalBrand && titleStr.toLowerCase().includes(finalBrand.toLowerCase());
      if (!brandInTitle) {
        const titleWords = titleStr.split(/\s+/);
        const derivedBrand = titleWords[0] ?? finalBrand;
        const derivedProduct = titleWords.slice(1).join(' ')
          .split(/\s*[|,]\s*|\s+by\s+/i)[0].trim()
          .split(/\s+/).slice(0, 5).join(' ');
        console.warn(
          `[reprice] Brand "${finalBrand}" not in eBay title "${titleStr.slice(0, 70)}"` +
          ` — overriding: brand="${derivedBrand}" product="${derivedProduct}"`,
        );
        finalBrand = derivedBrand;
        finalProduct = derivedProduct;
      }

      // Extract additional variant terms from eBay title (flavour, sub-type, size keywords)
      // that are NOT already captured in brand+productName.  Appending these to the Amazon
      // query helps it find the exact variant instead of a generic / differently-sized one.
      const NOISE = /^(supplement|powder|vitamin|natural|organic|vegan|gluten|capsule|capsules|tablet|tablets|serum|lotion|cream|spray|formula|complex|hydrating|support|skin|care|beauty|health|personal)$/i;
      const baseLc = `${finalBrand} ${finalProduct}`.toLowerCase().split(/\s+/).filter(t => t.length > 2);
      const extraTerms = titleStr.split(/\s+/)
        .filter(w => w.length > 3 && !NOISE.test(w))
        .filter(w => !baseLc.some(b => b.includes(w.toLowerCase()) || w.toLowerCase().includes(b)));
      if (extraTerms.length > 0) {
        additionalContext = extraTerms.slice(0, 4).join(' ');
        console.log(`[reprice] additionalContext from title: "${additionalContext}"`);
      }
    }

    // Detect free shipping from user's default fulfillment policy.
    // Check BOTH fulfillment (used for items >= $50) and fulfillmentFree (items < $50).
    // If EITHER is free, honour it — the user may have set only one policy as "always free".
    let shippingEstimateCents = 600;
    let policyFreeShipping = false;
    try {
      const defaultsResult = await getPolicyDefaults(userId);
      const defaults = defaultsResult.defaults ?? {};

      // Collect policy IDs to check — fulfillment first, then fulfillmentFree as fallback
      const policyIdsToCheck: string[] = [];
      if (defaults.fulfillment) policyIdsToCheck.push(defaults.fulfillment);
      if (defaults.fulfillmentFree && defaults.fulfillmentFree !== defaults.fulfillment) {
        policyIdsToCheck.push(defaults.fulfillmentFree);
      }

      for (const policyId of policyIdsToCheck) {
        try {
          const policyResult = await getPolicy(userId, 'fulfillment', policyId);
          if (policyResult.ok && hasFreeShipping(policyResult.policy)) {
            shippingEstimateCents = 0;
            policyFreeShipping = true;
            console.log(`[reprice] Free shipping detected on policy ${policyId} — shippingEstimateCents=0`);
            break;
          }
          console.log(`[reprice] Policy ${policyId} — paid shipping`);
        } catch (innerErr) {
          console.warn(`[reprice] Could not fetch policy ${policyId}:`, innerErr instanceof Error ? innerErr.message : String(innerErr));
        }
      }

      if (policyIdsToCheck.length === 0) {
        console.log('[reprice] No fulfillment policy configured — using default $6 shipping estimate');
      }
    } catch (policyErr) {
      console.warn('[reprice] Could not load policy defaults, using default shipping cost:', policyErr);
    }

    const settings: Partial<DeliveredPricingSettings> = {
      ...DEFAULT_SETTINGS,
      shippingEstimateCents,
    };

    const pricingResult = await getPricingDecision({
      brand: finalBrand,
      productName: finalProduct,
      additionalContext,
      settings,
      servingCount: typeof servingCount === 'number' ? servingCount : null,
    });

    const summary = pricingResult.pricingEvidence?.summary;
    const finalItemCents = pricingResult.finalItemCents ?? 0;
    const finalShipCents = pricingResult.finalShipCents ?? 0;
    const targetDeliveredCents = finalItemCents + finalShipCents;
    const isFreeShip = summary?.freeShipApplied ?? policyFreeShipping ?? (finalShipCents === 0);

    // Build calculation steps in the same format as draft-logs.ts
    const ebayCompsCount = pricingResult.pricingEvidence?.ebayCompsCount ?? 0;
    const retailCompsCount = summary?.retailCompsCount ?? 0;
    const amazonPriceCents = summary?.amazonPriceCents ?? null;
    const walmartPriceCents = summary?.walmartPriceCents ?? null;
    const soldMedianDeliveredCents = summary?.soldMedianDeliveredCents ?? null;
    const subsidyCents = summary?.subsidyCents ?? 0;

    const calculations = [
      {
        step: '1. Gather Competitor Prices',
        input: {
          brand: finalBrand || '(none)',
          productName: finalProduct || '(none)',
        },
        output: {
          ebayCompsCount,
          retailCompsCount,
          amazonPrice: amazonPriceCents != null ? `$${(amazonPriceCents / 100).toFixed(2)}` : null,
          walmartPrice: walmartPriceCents != null ? `$${(walmartPriceCents / 100).toFixed(2)}` : null,
          soldMedianDelivered: soldMedianDeliveredCents != null ? `$${(soldMedianDeliveredCents / 100).toFixed(2)}` : null,
        },
        formula: null,
        notes: `Found ${ebayCompsCount} eBay comps, ${retailCompsCount} retail comps`,
      },
      {
        step: '2. Calculate Target Delivered Price',
        input: {
          mode: settings.mode ?? 'market-match',
          compsSource: summary?.compsSource ?? 'fallback',
        },
        output: {
          targetDelivered: `$${(targetDeliveredCents / 100).toFixed(2)}`,
        },
        formula: 'TargetDelivered = BestCompPrice × Multiplier',
        notes: `Status: ${pricingResult.status}`,
      },
      {
        step: '3. Split Into Item + Shipping',
        input: {
          targetDelivered: `$${(targetDeliveredCents / 100).toFixed(2)}`,
          shippingEstimate: `$${(shippingEstimateCents / 100).toFixed(2)}`,
          freeShippingApplied: isFreeShip,
          policyFreeShipping,
        },
        output: {
          itemPrice: `$${(finalItemCents / 100).toFixed(2)}`,
          shippingCharge: `$${(finalShipCents / 100).toFixed(2)}`,
          subsidyAmount: `$${(subsidyCents / 100).toFixed(2)}`,
        },
        formula: isFreeShip
          ? 'ItemPrice = TargetDelivered (free shipping absorbed by seller)'
          : 'ItemPrice = TargetDelivered − ShippingCharge',
        notes: isFreeShip
          ? 'Policy has free shipping — seller absorbs shipping cost'
          : `Buyer pays shipping separately ($${(shippingEstimateCents / 100).toFixed(2)} estimated)`,
      },
      {
        step: '4. Final Price',
        input: {
          canCompete: summary?.canCompete ?? true,
          matchConfidence: summary?.matchConfidence ?? 'medium',
        },
        output: {
          finalItemPrice: `$${(finalItemCents / 100).toFixed(2)}`,
          finalShippingCharge: `$${(finalShipCents / 100).toFixed(2)}`,
        },
        formula: null,
        notes: (pricingResult.warnings ?? []).join('; ') || 'No warnings',
      },
    ];

    return ok(res, {
      success: true,
      suggestedPrice: finalItemCents / 100,
      shippingPrice: finalShipCents / 100,
      freeShipping: isFreeShip,
      canCompete: summary?.canCompete ?? true,
      matchConfidence: summary?.matchConfidence ?? 'medium',
      status: pricingResult.status,
      calculations,
      debug: {
        targetDeliveredCents,
        finalItemCents,
        finalShipCents,
        policyFreeShipping,
        shippingEstimateCents,
        ebayCompsCount,
        retailCompsCount,
        amazonPriceCents,
        walmartPriceCents,
        soldMedianDeliveredCents,
        soldCount: summary?.soldCount ?? 0,
        shippingEstimateSource: policyFreeShipping ? 'policy-free' : (summary?.shippingEstimateSource ?? 'default'),
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
