// Group SIDE/OTHER images with their paired products
// Deterministic matching based on brand, packaging, category, and proximity

import { FeatureRow } from './featurePrep.js';
import { Pair, ProductGroup } from './schema.js';

interface ExtraMatch {
  extraUrl: string;
  reason: string[];
  score: number;
}

// Check if two feature rows have matching characteristics
function shouldAttachExtra(
  product: { front: FeatureRow; back: FeatureRow },
  extra: FeatureRow
): ExtraMatch | null {
  if (extra.role !== 'side' && extra.role !== 'other') {
    return null;
  }

  const reasons: string[] = [];
  let score = 0;

  // Brand match (or unknownRescue)
  const brandMatch = 
    (product.front.brandNorm && extra.brandNorm && product.front.brandNorm === extra.brandNorm) ||
    (product.back.brandNorm && extra.brandNorm && product.back.brandNorm === extra.brandNorm);
  
  const brandUnknown = !product.front.brandNorm || !product.back.brandNorm || !extra.brandNorm;
  
  if (brandMatch) {
    reasons.push('brandMatch');
    score += 3;
  } else if (!brandUnknown) {
    // Brand mismatch with known brands - reject
    return null;
  }

  // Packaging match
  const pkgMatch = 
    (product.front.packagingHint !== 'other' && product.front.packagingHint === extra.packagingHint) ||
    (product.back.packagingHint !== 'other' && product.back.packagingHint === extra.packagingHint);
  
  if (pkgMatch) {
    reasons.push('packagingMatch');
    score += 2;
  }

  // Category tail overlap
  const categoryTailOverlap = (tailA: string, tailB: string): boolean => {
    if (!tailA || !tailB) return false;
    const tokensA = tailA.toLowerCase().split(/\s+/);
    const tokensB = tailB.toLowerCase().split(/\s+/);
    return tokensA.some(t => tokensB.includes(t));
  };

  const catMatch = 
    categoryTailOverlap(product.front.categoryTail, extra.categoryTail) ||
    categoryTailOverlap(product.back.categoryTail, extra.categoryTail);
  
  if (catMatch) {
    reasons.push('categoryMatch');
    score += 1;
  }

  // Filename proximity (same folder or similar stem)
  const getPathParts = (url: string) => {
    const parts = url.split('/');
    const filename = parts[parts.length - 1];
    const folder = parts.slice(0, -1).join('/');
    const stem = filename.replace(/\.(jpe?g|png|webp|gif)$/i, '');
    return { folder, stem };
  };

  const frontParts = getPathParts(product.front.url);
  const backParts = getPathParts(product.back.url);
  const extraParts = getPathParts(extra.url);

  const sameFolderAsFront = frontParts.folder === extraParts.folder && frontParts.folder !== '';
  const sameFolderAsBack = backParts.folder === extraParts.folder && backParts.folder !== '';

  if (sameFolderAsFront || sameFolderAsBack) {
    reasons.push('sameFolder');
    score += 1;
  }

  // Require at least 2 signals for attachment
  if (score < 2) {
    return null;
  }

  return {
    extraUrl: extra.url,
    reason: reasons,
    score
  };
}

export function groupExtrasWithProducts(
  pairs: Pair[],
  features: Map<string, FeatureRow>,
  maxExtrasPerProduct: number = 4
): ProductGroup[] {
  const products: ProductGroup[] = [];
  const usedExtras = new Set<string>();

  // Build case-insensitive URL lookup map
  const canon = (url: string) => url.trim().replace(/\\/g, '/').toLowerCase();
  const urlToFeature = new Map<string, FeatureRow>();
  for (const [url, feature] of features.entries()) {
    urlToFeature.set(canon(url), feature);
  }

  // Get all side/other images
  const extras = Array.from(features.values()).filter(
    f => f.role === 'side' || f.role === 'other'
  );

  for (const pair of pairs) {
    const front = urlToFeature.get(canon(pair.frontUrl));
    const back = urlToFeature.get(canon(pair.backUrl));
    
    if (!front || !back) {
      console.warn(`WARN groupExtras: Could not find features for pair front=${pair.frontUrl} back=${pair.backUrl}`);
      continue;
    }

    const productExtras: string[] = [];
    const matchedExtras: ExtraMatch[] = [];

    // Find matching extras
    for (const extra of extras) {
      if (usedExtras.has(extra.url)) continue;

      const match = shouldAttachExtra({ front, back }, extra);
      if (match) {
        matchedExtras.push(match);
      }
    }

    // Sort by score descending, take top N
    matchedExtras.sort((a, b) => b.score - a.score);
    const topExtras = matchedExtras.slice(0, maxExtrasPerProduct);

    for (const match of topExtras) {
      productExtras.push(match.extraUrl);
      usedExtras.add(match.extraUrl);
      console.log(`EXTRA front=${pair.frontUrl} + side=${match.extraUrl} reason=${match.reason.join('+')}`);
    }

    // Create ProductGroup
    const productId = `${pair.brand}_${pair.product}`.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
    products.push({
      productId,
      frontUrl: pair.frontUrl,
      backUrl: pair.backUrl,
      extras: productExtras,
      evidence: {
        brand: pair.brand,
        product: pair.product,
        variant: pair.variant,
        matchScore: pair.matchScore,
        confidence: pair.confidence,
        triggers: pair.evidence
      }
    });
  }

  console.log(`\nGROUPED: ${products.length} products with ${Array.from(usedExtras).length} total extras`);
  return products;
}
