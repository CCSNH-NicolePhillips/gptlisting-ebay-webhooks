// Phase 5b.4: Resolve singletons by promoting to solo products or attaching as extras

import type { FeatureRow } from './featurePrep.js';
import type { ProductGroup } from './schema.js';

export interface ResolveResult {
  products: ProductGroup[];
  remainingSingletons: FeatureRow[];
}

export function resolveSingletons(
  singletons: FeatureRow[],
  products: ProductGroup[]
): ResolveResult {
  const remaining: FeatureRow[] = [];

  for (const s of singletons) {
    const brandNorm = s.brandNorm || '';
    const originalRole = s.originalRole ?? s.role;

    // 1. If brand is unique across all products → promote to solo product
    const productBrands = new Set(
      products.map(p => p.evidence?.brand?.toLowerCase() || '').filter(Boolean)
    );
    const sBrandLower = brandNorm.toLowerCase();

    const isUniqueBrand =
      sBrandLower.length > 0 && !productBrands.has(sBrandLower);

    if (originalRole === 'front' && isUniqueBrand) {
      console.log('[resolveSingletons] SOLO-PRODUCT', {
        imageKey: s.url,
        brandNorm,
      });
      products.push({
        productId: `solo:${s.url}`,
        frontUrl: s.url,
        backUrl: '', // Empty string for solo products without back
        extras: [],
        evidence: {
          brand: brandNorm,
          product: s.productTokens?.join(' ') || '',
          variant: s.variantTokens?.join(' ') || null,
          matchScore: 0,
          confidence: 0.5,
          triggers: ['solo-product-unique-brand']
        }
      });
      continue;
    }

    // 2. If brand matches an existing product → attach as extra
    const candidates = products
      .map(p => {
        const pBrandLower = (p.evidence?.brand || '').toLowerCase();
        const brandScore = pBrandLower && sBrandLower === pBrandLower ? 1 : 0;

        // Filename / timestamp proximity heuristic:
        const base = s.url || '';
        const hasSimilarBase =
          typeof base === 'string' &&
          typeof p.frontUrl === 'string' &&
          p.frontUrl.includes(base.slice(0, 9)); // e.g. 20251115_

        const score =
          brandScore * 2 +
          (hasSimilarBase ? 1 : 0);

        return { p, score };
      })
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score);

    if (candidates.length > 0 && candidates[0].score >= 2) {
      const target = candidates[0].p;
      console.log('[resolveSingletons] EXTRA', {
        singleton: s.url,
        productId: target.productId,
        brandNorm,
      });
      if (!Array.isArray(target.extras)) target.extras = [];
      target.extras.push(s.url);
      continue;
    }

    // 3. If neither rule applied, keep it as a real singleton
    remaining.push(s);
  }

  return { products, remainingSingletons: remaining };
}
