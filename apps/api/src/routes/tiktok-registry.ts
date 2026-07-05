/**
 * tiktok-registry.ts — Express routes for the Brand→TikTok Shop pin registry.
 *
 * Mounts under /api/tiktok-registry (registered in routes/index.ts)
 *
 * Lets users pin a known TikTok Shop product URL for a brand + product so the
 * pricing pipeline can price/describe items that aren't carried on Amazon at all
 * (common for TikTok-exclusive/viral products) instead of falling through to
 * NEEDS_REVIEW.
 *
 * Endpoints:
 *   GET    /api/tiktok-registry        — list all registered pins
 *   POST   /api/tiktok-registry        — save/update a pin  { brand, product, url }
 *   DELETE /api/tiktok-registry        — remove a pin        { brand, product }
 */

import { Router } from 'express';
import { requireUserAuth } from '../../../../src/lib/auth-user.js';
import {
  listTikTokShopPins,
  saveTikTokShopPin,
  deleteTikTokShopPin,
} from '../../../../src/lib/brand-registry.js';
import { badRequest, serverError } from '../http/respond.js';

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/tiktok-registry
// Returns all registered brand→TikTok Shop pins (sorted newest first).
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    await requireUserAuth(req.headers.authorization || '');
    const entries = await listTikTokShopPins();
    return res.status(200).json({ ok: true, entries });
  } catch (err) {
    if (err instanceof Error && err.message.toLowerCase().includes('auth')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/tiktok-registry
// Body: { brand: string, product: string, url: string }
// Saves a verified brand→TikTok Shop URL pin in Redis.
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  try {
    await requireUserAuth(req.headers.authorization || '');

    const { brand, product, url } = req.body as {
      brand?: string;
      product?: string;
      url?: string;
    };

    if (!brand || typeof brand !== 'string' || !brand.trim()) {
      return badRequest(res, 'brand is required');
    }
    if (!product || typeof product !== 'string' || !product.trim()) {
      return badRequest(res, 'product is required');
    }
    if (!url || typeof url !== 'string' || !isTikTokShopUrl(url.trim())) {
      return badRequest(res, 'url must be a valid tiktok.com or shop.tiktok.com product URL');
    }

    await saveTikTokShopPin(brand.trim(), product.trim(), url.trim(), true);

    return res.status(200).json({
      ok: true,
      entry: {
        brand: brand.trim(),
        product: product.trim(),
        url: url.trim(),
      },
    });
  } catch (err) {
    if (err instanceof Error && err.message.toLowerCase().includes('auth')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/tiktok-registry
// Body: { brand: string, product: string }
// Removes the pin from Redis.
// ---------------------------------------------------------------------------
router.delete('/', async (req, res) => {
  try {
    await requireUserAuth(req.headers.authorization || '');

    const { brand, product } = req.body as { brand?: string; product?: string };

    if (!brand || !product) {
      return badRequest(res, 'brand and product are required');
    }

    const deleted = await deleteTikTokShopPin(brand.trim(), product.trim());
    return res.status(200).json({ ok: true, deleted });
  } catch (err) {
    if (err instanceof Error && err.message.toLowerCase().includes('auth')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTikTokShopUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return /(^|\.)tiktok\.com$/.test(parsed.hostname);
  } catch {
    return false;
  }
}

export default router;
