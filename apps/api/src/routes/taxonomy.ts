/**
 * taxonomy.ts — Express routes for custom taxonomy management.
 *
 * Mounts under /api/taxonomy  (registered in routes/index.ts)
 *
 * Mirrors Netlify functions:
 *   GET  /api/taxonomy/?slug=  ← taxonomy-get.ts        (admin)
 *   GET  /api/taxonomy/list    ← taxonomy-list.ts       (admin)
 *   POST /api/taxonomy/        ← taxonomy-upsert.ts     (admin)
 *   POST /api/taxonomy/override← taxonomy-override-upsert.ts (user)
 */

import { Router } from 'express';
import { requireUserAuth } from '../../../../src/lib/auth-user.js';
import { requireAdminAuth } from '../../../../src/lib/auth-admin.js';
import { getCategory, listCategories, putCategory } from '../../../../src/lib/taxonomy-store.js';
import type { CategoryDef, ItemSpecific } from '../../../../src/lib/taxonomy-schema.js';
import { k } from '../../../../src/lib/user-keys.js';
import { serverError } from '../http/respond.js';

const router = Router();

// ---------------------------------------------------------------------------
// Normalization helpers (from taxonomy-upsert.ts)
// ---------------------------------------------------------------------------
function normalizeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function coerceItemSpecifics(input: unknown): ItemSpecific[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((spec) => (typeof spec === 'object' && spec ? spec : null))
    .filter((spec): spec is Record<string, unknown> => Boolean(spec))
    .map((spec) => ({
      name: String(spec.name ?? '').trim(),
      type: (spec.type === 'enum' ? 'enum' : 'string') as ItemSpecific['type'],
      enum: Array.isArray(spec.enum) ? spec.enum.map((e) => String(e)) : undefined,
      source: (spec.source === 'static' ? 'static' : 'group') as ItemSpecific['source'],
      from: typeof spec.from === 'string' ? (spec.from as ItemSpecific['from']) : undefined,
      static: typeof spec.static === 'string' ? spec.static : undefined,
      required: Boolean(spec.required),
    }))
    .filter((spec) => Boolean(spec.name));
}

type ConditionVal = 'NEW' | 'USED' | 'LIKE_NEW' | undefined;
function normalizeCondition(value: unknown): ConditionVal {
  if (typeof value !== 'string') return undefined;
  const upper = value.toUpperCase();
  if (upper === 'NEW' || upper === 'USED' || upper === 'LIKE_NEW') return upper as ConditionVal;
  return undefined;
}

// ---------------------------------------------------------------------------
// Upstash REST helper (for override-upsert — direct SET without a lib wrapper)
// ---------------------------------------------------------------------------
const UPSTASH_BASE =
  process.env.UPSTASH_REST_URL || process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN =
  process.env.UPSTASH_REST_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function upstash<T = unknown>(cmd: unknown[]): Promise<{ result?: T; error?: string }> {
  if (!UPSTASH_BASE || !UPSTASH_TOKEN) return { error: 'Upstash not configured' };
  const r = await fetch(UPSTASH_BASE, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) return { error: `Upstash ${r.status}` };
  return (await r.json()) as { result?: T; error?: string };
}

// ---------------------------------------------------------------------------
// GET /api/taxonomy/?slug=:slug   — admin auth
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    requireAdminAuth(req.headers.authorization);
  } catch {
    return void res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const slug = ((req.query.slug as string) || '').trim();
    if (!slug) return void res.status(400).json({ error: 'Missing slug' });
    const category = await getCategory(slug);
    if (!category) return void res.status(404).json({ error: 'Category not found' });
    res.json(category);
  } catch (err) {
    serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/taxonomy/list   — admin auth
// ---------------------------------------------------------------------------
router.get('/list', async (req, res) => {
  try {
    requireAdminAuth(req.headers.authorization);
  } catch {
    return void res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const categories = await listCategories();
    res.json({ categories, count: categories.length });
  } catch (err) {
    serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/taxonomy/   — admin auth, creates/updates a CategoryDef
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  try {
    requireAdminAuth(req.headers.authorization);
  } catch {
    return void res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const body: any = req.body ?? {};
    const id = String(body.id ?? '').trim();
    const slugInput = String(body.slug ?? id ?? '').trim();
    const marketplaceId = String(body.marketplaceId ?? '').trim();
    const title = String(body.title ?? '').trim();

    if (!id || !slugInput || !marketplaceId || !title) {
      return void res.status(400).json({ error: 'Missing required fields' });
    }

    const slug = normalizeSlug(slugInput);
    const now = Date.now();
    const version = Number(body.version ?? 1) || 1;

    const cat: CategoryDef = {
      id,
      slug,
      title,
      marketplaceId,
      scoreRules:
        body.scoreRules && typeof body.scoreRules === 'object'
          ? {
              includes: Array.isArray(body.scoreRules.includes)
                ? body.scoreRules.includes.map((e: unknown) => String(e)).filter(Boolean)
                : undefined,
              excludes: Array.isArray(body.scoreRules.excludes)
                ? body.scoreRules.excludes.map((e: unknown) => String(e)).filter(Boolean)
                : undefined,
              minScore: Number(body.scoreRules.minScore) || undefined,
            }
          : undefined,
      itemSpecifics: coerceItemSpecifics(body.itemSpecifics),
      defaults:
        body.defaults && typeof body.defaults === 'object'
          ? {
              condition: normalizeCondition(body.defaults.condition),
              quantity: Number(body.defaults.quantity ?? 0) || undefined,
              fulfillmentPolicyId: body.defaults.fulfillmentPolicyId
                ? String(body.defaults.fulfillmentPolicyId)
                : undefined,
              paymentPolicyId: body.defaults.paymentPolicyId
                ? String(body.defaults.paymentPolicyId)
                : undefined,
              returnPolicyId: body.defaults.returnPolicyId
                ? String(body.defaults.returnPolicyId)
                : undefined,
            }
          : undefined,
      version,
      updatedAt: now,
    };

    await putCategory(cat);
    res.json({ ok: true, slug: cat.slug, version: cat.version });
  } catch (err) {
    serverError(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/taxonomy/override   — user auth, stores per-user category override
// ---------------------------------------------------------------------------
router.post('/override', async (req, res) => {
  let userId: string;
  try {
    const auth = await requireUserAuth(req.headers.authorization || '');
    userId = auth.userId;
  } catch {
    return void res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const body: any = req.body ?? {};
    const { jobId, groupId, aspects, categoryId, offer } = body;
    if (!jobId || !groupId) {
      return void res.status(400).json({ error: 'Missing jobId or groupId' });
    }

    const key = k.override(userId, jobId, groupId);
    const record: any = { inventory: { product: { aspects: aspects || {} } } };

    if (categoryId) {
      record.offer = { ...(record.offer || {}), categoryId };
      record._meta = {
        ...(record._meta || {}),
        selectedCategory: { id: categoryId, slug: String(categoryId), title: String(categoryId) },
      };
    }

    if (offer && typeof offer === 'object') {
      const o: any = {};
      if (typeof offer.price === 'number' && Number.isFinite(offer.price) && offer.price > 0) {
        o.price = Math.round(offer.price * 100) / 100;
        record._meta = { ...(record._meta || {}), price: o.price };
      }
      if (typeof offer.quantity === 'number' && Number.isFinite(offer.quantity) && offer.quantity > 0)
        o.quantity = Math.trunc(offer.quantity);
      if (typeof offer.merchantLocationKey === 'string' && offer.merchantLocationKey.trim())
        o.merchantLocationKey = offer.merchantLocationKey.trim();
      if (typeof offer.marketplaceId === 'string' && offer.marketplaceId.trim())
        o.marketplaceId = offer.marketplaceId.trim();
      if (typeof offer.description === 'string' && offer.description.trim())
        o.description = offer.description.trim();
      ['fulfillmentPolicyId', 'paymentPolicyId', 'returnPolicyId'].forEach((pk) => {
        if (Object.prototype.hasOwnProperty.call(offer, pk)) (o as any)[pk] = (offer as any)[pk] ?? null;
      });
      if (Object.keys(o).length) record.offer = { ...(record.offer || {}), ...o };
    }

    const setRes = await upstash(['SET', key, JSON.stringify(record)]);
    if (setRes.error) {
      return void res.status(500).json({ error: 'override_upsert_failed', detail: setRes.error });
    }
    res.json({ ok: true });
  } catch (err) {
    serverError(res, err);
  }
});

export default router;
