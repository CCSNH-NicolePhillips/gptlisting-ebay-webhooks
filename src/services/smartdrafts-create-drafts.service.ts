/**
 * SmartDrafts — create-drafts core service
 *
 * Platform-agnostic business logic for generating eBay listing drafts from
 * paired product photos.  Used by both the Netlify handler
 * (netlify/functions/smartdrafts-create-drafts.ts) and the Express API
 * (apps/api/src/routes/smartdrafts.ts).
 *
 * No Netlify or Express types are imported here.
 */

import { openai } from '../lib/openai.js';
import { pickCategoryForGroup } from '../lib/taxonomy-select.js';
import { listCategories } from '../lib/taxonomy-store.js';
import { getPricingDecision } from '../lib/pricing/index.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const MODEL = process.env.GPT_MODEL || 'gpt-4o';
const MAX_TOKENS = Number(process.env.GPT_MAX_TOKENS || 700);
const GPT_RETRY_ATTEMPTS = Math.max(1, Number(process.env.GPT_RETRY_ATTEMPTS || 1));
const GPT_RETRY_DELAY_MS = Math.max(250, Number(process.env.GPT_RETRY_DELAY_MS || 1500));
const GPT_TIMEOUT_MS = Math.max(5000, Number(process.env.GPT_TIMEOUT_MS || 30000));

// ── Types ────────────────────────────────────────────────────────────────────

export type DraftStatus = 'READY' | 'NEEDS_REVIEW';

export type PairedProduct = {
  productId: string;
  brand: string;
  product: string;
  variant?: string | null;
  size?: string | null;
  categoryPath?: string;
  heroDisplayUrl: string;
  backDisplayUrl: string | null;
  extras?: string[];
  evidence?: string[];
  extractedText?: string;
  netWeight?: { value: number; unit: string } | null;
};

export type CategoryHint = {
  id: string;
  title: string;
  aspects?: Record<string, unknown>;
};

export type Draft = {
  productId: string;
  brand: string;
  product: string;
  title: string;
  description: string;
  bullets: string[];
  aspects: Record<string, string[]>;
  category: CategoryHint;
  images: string[];
  price: number;
  shippingPrice?: number;
  condition?: string;
  /** Publish-gate status.  Undefined on legacy pricing path. */
  status?: DraftStatus;
  pricingEvidence?: {
    mode: string;
    targetDeliveredCents: number;
    finalItemCents: number;
    finalShipCents: number;
    ebayCompsCount: number;
    fallbackUsed: boolean;
    warnings: string[];
    manualReviewRequired?: boolean;
    fallbackSuggestion?: { itemCents: number; source: 'legacy-retail' };
  };
};

// ── Internal helpers ──────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withTimeout<T>(p: Promise<T>, ms = GPT_TIMEOUT_MS): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms),
    ),
  ]);
}

async function getRelevantCategories(product: PairedProduct): Promise<string> {
  try {
    const allCategories = await listCategories();
    const searchTerms = [product.product, product.brand, product.variant, product.categoryPath]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    const relevant = allCategories
      .filter(cat => {
        const catText = `${cat.title} ${cat.slug}`.toLowerCase();
        return searchTerms.split(/\s+/).some(term => term.length > 3 && catText.includes(term));
      })
      .slice(0, 20)
      .map(cat => `${cat.id}: ${cat.title}`)
      .join('\n');

    if (relevant) return relevant;

    const COMMON_IDS = ['261186', '31411', '11450', '293', '88433', '99'];
    return allCategories
      .filter(cat => COMMON_IDS.includes(cat.id))
      .map(cat => `${cat.id}: ${cat.title}`)
      .join('\n');
  } catch (err) {
    console.error('[getRelevantCategories] Error:', err);
    return '';
  }
}

function buildPrompt(
  product: PairedProduct,
  categoryHint: CategoryHint | null,
  categories: string,
): string {
  const lines: string[] = [`Product: ${product.product}`];

  if (product.brand && product.brand !== 'Unknown') lines.push(`Brand: ${product.brand}`);
  if (product.variant) lines.push(`Variant: ${product.variant}`);
  if (product.size) lines.push(`Size: ${product.size}`);
  if (product.categoryPath) lines.push(`Category hint: ${product.categoryPath}`);

  if (product.extractedText) {
    lines.push('', '=== TEXT EXTRACTED FROM PRODUCT PHOTOS ===', product.extractedText, '=== END EXTRACTED TEXT ===', '');
    lines.push('IMPORTANT: Use the extracted text above to create an SEO-rich title and determine formulation.');
    lines.push('');
  }

  if (categoryHint) {
    lines.push(`eBay category: ${categoryHint.title} (ID: ${categoryHint.id})`);
    if (categoryHint.aspects && Object.keys(categoryHint.aspects).length > 0) {
      const hints = Object.entries(categoryHint.aspects)
        .slice(0, 5)
        .map(([key, val]: [string, unknown]) => {
          const v = val as { values?: unknown[] };
          const vals = Array.isArray(v?.values)
            ? (v.values as unknown[]).slice(0, 3).map(String).join(', ')
            : '';
          return vals ? `${key}: ${vals}` : key;
        });
      if (hints.length > 0) lines.push(`Suggested aspects: ${hints.join('; ')}`);
    }
  }

  if (product.evidence?.length) lines.push(`Matching evidence: ${product.evidence.join('; ')}`);

  // Detect topical skincare products and suppress supplement/food attributes
  const skincareKeywords = /\b(serum|cream|lotion|moisturizer|toner|cleanser|face wash|gel|mask|facial|eye cream|eye gel|body wash|body lotion|exfoliant|exfoliating|scrub|primer|essence|ampoule|mist|face oil|retinol|vitamin c|niacinamide|hyaluronic|peptide serum|booster)\b/i;
  const productText = [product.product, product.brand, product.variant, product.extractedText].filter(Boolean).join(' ');
  const isTopicalSkincare = skincareKeywords.test(productText);

  if (isTopicalSkincare) {
    lines.push(
      'IMPORTANT: This is a TOPICAL SKINCARE product (applied to skin, NOT consumed).',
      'DO NOT include any food/supplement attributes in the title or aspects:',
      '  - Prohibited: Unflavored, Flavored, Flavor, Vanilla, Chocolate, Serving Size, Servings, Count (as in supplement dose count)',
      '  - Include ONLY skincare-relevant attributes: skin type, key ingredients, size/volume (oz/ml), form (serum/cream/gel), concern (anti-aging/hydrating/firming)',
      '',
    );
  }

  lines.push('');

  if (categories) {
    lines.push('Choose the most appropriate eBay category ID from this list:', categories, '');
  }

  lines.push(
    'Create a professional eBay listing with accurate details.',
    'IMPORTANT: Search Amazon.com and Walmart.com for CURRENT regular selling price (NOT sale/clearance/collectible prices).',
    'Assess condition based on whether it appears to be new/sealed or used.',
    '',
    'Response format (JSON):',
    '{',
    ...(categories ? ['  "categoryId": "12345", // Choose the most appropriate eBay category ID from the list above'] : []),
    '  "title": "...", // 80 chars max',
    '  "description": "...",',
    '  "bullets": ["...", "...", "..."], // 3-5 bullet points',
    '  "aspects": { "Brand": ["..."], "Type": ["..."], ... }, // Item specifics',
    '  "price": 29.99, // Current retail price from Amazon/Walmart',
    '  "condition": "NEW" // or "USED"',
    '}',
  );

  return lines.join('\n');
}

async function pickCategory(product: PairedProduct): Promise<CategoryHint | null> {
  try {
    const category = await pickCategoryForGroup({
      brand: product.brand || undefined,
      product: product.product,
      variant: product.variant || undefined,
      size: product.size || undefined,
      claims: [],
      keywords: [],
    });
    if (!category) return null;
    return { id: category.id, title: category.title, aspects: {} };
  } catch (err) {
    console.error('[pickCategory] Error:', err);
    return null;
  }
}

async function callOpenAI(prompt: string): Promise<string> {
  if (!process.env.OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY');

  let lastError: unknown;
  for (let attempt = 1; attempt <= GPT_RETRY_ATTEMPTS; attempt++) {
    try {
      const completion = await withTimeout(
        openai.chat.completions.create({
          model: MODEL,
          temperature: 0.7,
          max_tokens: Math.max(100, Math.min(4000, MAX_TOKENS)),
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content:
                'You are an expert eBay listing writer with real-time web access.\n' +
                'Return ONLY strict JSON with keys: title, description, bullets, aspects, price, condition.\n' +
                '- title: <=80 chars, SEO-RICH product name with specific details.\n' +
                '- description: 2-4 sentences with SPECIFIC details from the label.\n' +
                '- bullets: array of 3-5 specific feature/benefit points.\n' +
                '- aspects: object with Brand, Type, Features, Size, etc.\n' +
                '- price: CURRENT Amazon/Walmart price (NOT sale prices). Return ONLY the number (e.g. 24.99).\n' +
                "- condition: one of 'NEW', 'LIKE_NEW', 'USED_EXCELLENT', 'USED_GOOD', 'USED_ACCEPTABLE'.\n" +
                '- NEVER include food/supplement words (Unflavored, Flavored, Flavor, Servings, Serving Size) in titles or aspects for topical skincare products (serums, creams, lotions, gels, masks, etc.).\n',
            },
            { role: 'user', content: prompt },
          ],
        }),
        GPT_TIMEOUT_MS,
      );
      return completion.choices?.[0]?.message?.content || '{}';
    } catch (err) {
      lastError = err;
      if (attempt >= GPT_RETRY_ATTEMPTS) break;
      await sleep(GPT_RETRY_DELAY_MS * attempt);
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError || 'OpenAI error');
  throw new Error(message);
}

function parseGptResponse(responseText: string, product: PairedProduct): {
  categoryId?: string;
  title: string;
  description: string;
  bullets: string[];
  aspects: Record<string, unknown>;
  price?: number;
  condition: string;
} {
  try {
    let clean = responseText.trim();
    if (clean.startsWith('```')) clean = clean.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    const parsed = JSON.parse(clean);
    return {
      categoryId: typeof parsed.categoryId === 'string' ? parsed.categoryId.trim() : undefined,
      title: typeof parsed.title === 'string' ? parsed.title.slice(0, 80) : `${product.brand} ${product.product}`.slice(0, 80),
      description: typeof parsed.description === 'string' ? parsed.description.slice(0, 1200) : `${product.brand} ${product.product}`,
      bullets: Array.isArray(parsed.bullets) ? parsed.bullets.slice(0, 5).map((b: unknown) => String(b).slice(0, 200)) : [],
      aspects: typeof parsed.aspects === 'object' && parsed.aspects !== null ? parsed.aspects as Record<string, unknown> : {},
      price: typeof parsed.price === 'number' && parsed.price > 0 ? parsed.price : undefined,
      condition: typeof parsed.condition === 'string' ? parsed.condition : 'NEW',
    };
  } catch {
    return {
      categoryId: undefined,
      title: `${product.brand} ${product.product}`.slice(0, 80),
      description: `${product.brand} ${product.product}`,
      bullets: [],
      aspects: {},
      price: undefined,
      condition: 'NEW',
    };
  }
}

function normalizeAspects(aspects: Record<string, unknown>, product: PairedProduct): Record<string, string[]> {
  const normalized: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(aspects)) {
    if (Array.isArray(value)) {
      const vals = value.map(v => String(v).trim()).filter(Boolean);
      if (vals.length) normalized[key] = vals.slice(0, 10);
    } else if (value !== null && value !== undefined) {
      const s = String(value).trim();
      if (s) normalized[key] = [s];
    }
  }
  if (product.brand && product.brand !== 'Unknown' && !normalized.Brand) normalized.Brand = [product.brand];
  if (product.size && !normalized.Size) normalized.Size = [product.size];
  return normalized;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Create a single eBay listing draft for a paired product.
 *
 * Calls GPT-4o to generate listing copy, then calls `getPricingDecision`
 * from `@core/pricing` to compute the final price.  The `status` field on
 * the returned `Draft` indicates whether the pricing is READY or NEEDS_REVIEW.
 */
export async function createDraftForProduct(product: PairedProduct): Promise<Draft> {
  const startTime = Date.now();
  console.log(`[createDraftForProduct] Starting: ${product.productId}`);

  const [relevantCategories, categoryHint] = await Promise.all([
    getRelevantCategories(product),
    pickCategory(product),
  ]);

  const prompt = buildPrompt(product, categoryHint, relevantCategories);
  const responseText = await callOpenAI(prompt);
  const parsed = parseGptResponse(responseText, product);

  // Resolve category from GPT's selection or fallback
  let finalCategory: CategoryHint | null = categoryHint;
  if (parsed.categoryId) {
    try {
      const { getCategoryById } = await import('../lib/taxonomy-store.js');
      const gptCategory = await getCategoryById(parsed.categoryId);
      if (gptCategory) {
        finalCategory = { id: gptCategory.id, title: gptCategory.title || gptCategory.slug || '', aspects: {} };
      }
    } catch {
      // keep fallback
    }
  }

  const aspects = normalizeAspects(parsed.aspects, product);
  const images = [product.heroDisplayUrl, product.backDisplayUrl, ...(product.extras ?? [])]
    .filter((url): url is string => Boolean(url));

  // ── Pricing ───────────────────────────────────────────────────────────────
  const categoryPath = finalCategory?.title ?? product.categoryPath ?? '';
  const retailPrice = typeof parsed.price === 'number' && parsed.price > 0 ? parsed.price : 0;

  // Include net weight (e.g. "15.22 fl oz") as size context so the pricing
  // search targets the correct variant and doesn't pull in cheap smaller sizes.
  const sizeContext = product.netWeight?.value && product.netWeight?.unit
    ? `${product.netWeight.value} ${product.netWeight.unit}`
    : undefined;

  // Cross-validate the classification brand against the GPT-generated eBay title.
  // When the scan misidentifies a product (e.g. classifies "Root ReLive Greens" as
  // "beam Kids"), the classification brand will NOT appear in the eBay title that
  // GPT wrote from the actual images.  In that case derive brand/product from the
  // GPT title instead — it is far more reliable for the Amazon price lookup.
  let pricingBrand = product.brand;
  let pricingProduct = product.product;
  const gptTitle = parsed.title || '';
  if (pricingBrand && gptTitle && !gptTitle.toLowerCase().includes(pricingBrand.toLowerCase())) {
    const titleWords = gptTitle.trim().split(/\s+/);
    const derivedBrand = titleWords[0] ?? pricingBrand;
    const derivedProduct = titleWords.slice(1).join(' ')
      .split(/\s*[|,]\s*|\s+by\s+/i)[0].trim()
      .split(/\s+/).slice(0, 5).join(' ');
    console.warn(
      `[createDraftForProduct] Classification brand "${pricingBrand}" not in GPT title` +
      ` "${gptTitle.slice(0, 60)}" — overriding pricing: brand="${derivedBrand}" product="${derivedProduct}"`,
    );
    pricingBrand = derivedBrand;
    pricingProduct = derivedProduct;
  }

  // Extract additional distinguishing terms from the GPT title that are not part
  // of brand/productName (e.g. flavor "Mint Chocolate", sub-type "After Shave Serum").
  // Passing these as additionalContext narrows the Amazon search to the correct variant
  // and prevents matching a different size/flavour at a wildly different price.
  const NOISE_WORDS = /^(supplement|powder|vitamin|natural|organic|vegan|gluten|capsule|capsules|tablet|tablets|serum|lotion|cream|spray|formula|complex)$/i;
  const basePricingTermsLc = `${pricingBrand} ${pricingProduct}`.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  const extraTitleTerms = gptTitle.split(/\s+/)
    .filter(w => w.length > 3 && !NOISE_WORDS.test(w))
    .filter(w => !basePricingTermsLc.some(b => b.includes(w.toLowerCase()) || w.toLowerCase().includes(b)));
  const titleContext = extraTitleTerms.slice(0, 4).join(' ');
  const combinedContext = [sizeContext, titleContext].filter(Boolean).join(' ') || undefined;

  const pricingResult = await getPricingDecision({
    brand: pricingBrand,
    productName: pricingProduct,
    settings: { mode: 'market-match' },
    retailPriceDollars: retailPrice,
    categoryPath,
    additionalContext: combinedContext,
  }).catch(err => {
    console.error(`[createDraftForProduct] Pricing failed, falling back to zero:`, err);
    return null;
  });

  let ebayPrice: number;
  let shippingPrice: number | undefined;
  let pricingEvidence: Draft['pricingEvidence'];
  let draftStatus: DraftStatus | undefined;

  if (pricingResult !== null && pricingResult.pricingEvidence.source === 'delivered-v2') {
    const { status, finalItemCents, finalShipCents, pricingEvidence: evidence, warnings } = pricingResult;

    draftStatus = status;
    ebayPrice = finalItemCents / 100;

    if (status === 'NEEDS_REVIEW') {
      console.warn(
        `[createDraftForProduct] NEEDS_REVIEW for ${product.productId}` +
        ` | warnings=[${warnings.join(', ')}]`,
      );
      shippingPrice = undefined;
    } else {
      shippingPrice = finalShipCents > 0 ? finalShipCents / 100 : undefined;
    }

    pricingEvidence = evidence;
  } else {
    ebayPrice = pricingResult !== null ? pricingResult.finalItemCents / 100 : 0;
    shippingPrice = undefined;
    pricingEvidence = undefined;
    draftStatus = undefined;
  }

  console.log(`[createDraftForProduct] Done in ${Date.now() - startTime}ms: ${product.productId} @ $${ebayPrice}`);

  return {
    productId: product.productId,
    brand: product.brand,
    product: product.product,
    title: parsed.title,
    description: parsed.description,
    bullets: parsed.bullets,
    aspects,
    category: finalCategory ?? { id: '', title: product.categoryPath ?? 'Uncategorized' },
    images,
    price: ebayPrice,
    shippingPrice,
    condition: parsed.condition,
    status: draftStatus,
    pricingEvidence,
  };
}
