/**
 * brand-registry.ts — Express routes for the Brand→ASIN registry.
 *
 * Mounts under /api/brand-registry (registered in routes/index.ts)
 *
 * Lets users pin a known Amazon ASIN for a brand + product so the
 * pricing pipeline bypasses Brave/SearchAPI keyword search and looks
 * up the exact product instead.
 *
 * Endpoints:
 *   GET    /api/brand-registry        — list all registered entries
 *   POST   /api/brand-registry        — save/update an entry  { brand, product, asin }
 *   DELETE /api/brand-registry        — remove an entry        { brand, product }
 */

import { Router } from 'express';
import { requireUserAuth } from '../../../../src/lib/auth-user.js';
import {
  listBrandRegistry,
  saveAmazonAsin,
  deleteAmazonAsin,
} from '../../../../src/lib/brand-registry.js';
import { badRequest, serverError } from '../http/respond.js';

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/brand-registry
// Returns all registered brand→ASIN entries (sorted newest first).
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    await requireUserAuth(req.headers.authorization || '');
    const entries = await listBrandRegistry();
    return res.status(200).json({ ok: true, entries });
  } catch (err) {
    if (err instanceof Error && err.message.toLowerCase().includes('auth')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/brand-registry
// Body: { brand: string, product: string, asin: string }
// Saves a verified brand→ASIN mapping in Redis.
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  try {
    await requireUserAuth(req.headers.authorization || '');

    const { brand, product, asin } = req.body as {
      brand?: string;
      product?: string;
      asin?: string;
    };

    if (!brand || typeof brand !== 'string' || !brand.trim()) {
      return badRequest(res, 'brand is required');
    }
    if (!product || typeof product !== 'string' || !product.trim()) {
      return badRequest(res, 'product is required');
    }
    if (!asin || typeof asin !== 'string' || !asin.trim()) {
      return badRequest(res, 'asin is required');
    }

    // Strip full Amazon URLs down to ASIN if user pastes a URL
    const cleanAsin = extractAsin(asin.trim());
    if (!cleanAsin) {
      return badRequest(res, 'Could not extract a valid ASIN (10-char alphanumeric) from the provided value');
    }

    await saveAmazonAsin(brand.trim(), product.trim(), cleanAsin, true);

    return res.status(200).json({
      ok: true,
      entry: {
        brand: brand.trim(),
        product: product.trim(),
        asin: cleanAsin,
        url: `https://www.amazon.com/dp/${cleanAsin}`,
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
// DELETE /api/brand-registry
// Body: { brand: string, product: string }
// Removes the entry from Redis.
// ---------------------------------------------------------------------------
router.delete('/', async (req, res) => {
  try {
    await requireUserAuth(req.headers.authorization || '');

    const { brand, product } = req.body as { brand?: string; product?: string };

    if (!brand || !product) {
      return badRequest(res, 'brand and product are required');
    }

    const deleted = await deleteAmazonAsin(brand.trim(), product.trim());
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

/**
 * Extract a bare ASIN from either a bare ASIN string or a full Amazon URL.
 * Returns null if no valid ASIN found.
 */
function extractAsin(value: string): string | null {
  // Full URL: /dp/B0B83PXLXW or /product/B0B83PXLXW
  const urlMatch = value.match(/\/(?:dp|product)\/([A-Z0-9]{10})/i);
  if (urlMatch) return urlMatch[1].toUpperCase();

  // Bare ASIN: exactly 10 alphanumeric characters
  const bareMatch = value.match(/^([A-Z0-9]{10})$/i);
  if (bareMatch) return bareMatch[1].toUpperCase();

  return null;
}

export default router;
