// Given features Map<string, FeatureRow>, return candidate lists per front.
// Export: buildCandidates(features, K = 4): Record<frontUrl, string[]> (list of backUrls)
//
// Heuristic score (fast, deterministic):
//  +3 brand match (exact brandNorm non-empty)
//  +2 product token Jaccard ≥ 0.5 (else +1 if ≥ 0.3)
//  +1 variant token Jaccard ≥ 0.5
//  +1 sizeCanonical equality (non-null and equal)
//  +1 packagingHint equal (not 'other')
//  +1 categoryTail share at least one tail token (case-insens)
//  -2 if roles not front vs back
//  -2 if category top-level words conflict strongly: /(Hair|Cosmetic)/ vs /(Supplement|Food|Beverage)/
// Tie-breakers: higher product token Jaccard, then brand match, then packaging match.
//
// Only keep backs with score ≥ 2. Sort descending and truncate to K.
// Return only fronts with non-empty candidate lists.

import { FeatureRow } from './featurePrep.js';
import { cfg } from './config.js';

export interface CandidateScore {
  backUrl: string;
  preScore: number;          // heuristic score
  prodJac: number;           // 0..1
  varJac: number;            // 0..1
  sizeEq: boolean;
  packaging: string;         // 'pouch'|'dropper-bottle'|...
  packagingBoost: number;    // e.g., +2.0 for dropper-bottle matches
  catTailOverlap: boolean;
  cosmeticBackCue: boolean;
  brandFlag: 'equal'|'mismatch'|'unknownRescue'|'distributorRescue'|'unknown';
  proximityBoost: number;    // +0.5 if same folder or similar filename
  barcodeBoost: number;      // +0.5 if back has barcode and front is unique
  // Legacy fields for backward compat
  score: number;
  brandMatch: boolean;
  prodJaccard: number;
  pkgMatch: boolean;
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = [...setA].filter(x => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

function hasCategoryConflict(catA: string | null, catB: string | null): boolean {
  if (!catA || !catB) return false;
  const hairCosmetic = /(hair|cosmetic|beauty)/i;
  const supplement = /(supplement|food|beverage|vitamin|nutrition)/i;
  
  const aIsHair = hairCosmetic.test(catA);
  const bIsHair = hairCosmetic.test(catB);
  const aIsSupplement = supplement.test(catA);
  const bIsSupplement = supplement.test(catB);
  
  return (aIsHair && bIsSupplement) || (aIsSupplement && bIsHair);
}

function categoryTailOverlap(tailA: string, tailB: string): boolean {
  if (!tailA || !tailB) return false;
  const tokensA = tailA.toLowerCase().split(/\s+/);
  const tokensB = tailB.toLowerCase().split(/\s+/);
  return tokensA.some(t => tokensB.includes(t));
}

// Levenshtein distance (edit distance) between two strings
function levenshtein(a: string, b: string): number {
  const matrix: number[][] = [];
  
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,  // substitution
          matrix[i][j - 1] + 1,      // insertion
          matrix[i - 1][j] + 1       // deletion
        );
      }
    }
  }
  
  return matrix[b.length][a.length];
}

// Check if front and back have proximate filenames or same folder
// Check if two colors are similar (same base color, ignoring shades)
function colorsMatch(colorA: string, colorB: string): boolean {
  if (!colorA || !colorB) return false;
  if (colorA === colorB) return true;
  
  // Normalize by removing shade modifiers (light-, dark-, deep-, bright-, etc.)
  const normalizeColor = (c: string) => c.replace(/^(light-|dark-|deep-|bright-|pale-|dim-)/i, '');
  const normA = normalizeColor(colorA);
  const normB = normalizeColor(colorB);
  
  return normA === normB;
}

function computeProximity(frontUrl: string, backUrl: string): number {
  // Extract folder and filename stem (without extension)
  const getPathParts = (url: string) => {
    const parts = url.split('/');
    const filename = parts[parts.length - 1];
    const folder = parts.slice(0, -1).join('/');
    const stem = filename.replace(/\.(jpe?g|png|webp|gif)$/i, '');
    return { folder, stem };
  };
  
  const front = getPathParts(frontUrl);
  const back = getPathParts(backUrl);
  
  // Same folder bonus
  if (front.folder === back.folder && front.folder !== '') {
    return 0.5;
  }
  
  // Similar filename stems (edit distance ≤ 2)
  const distance = levenshtein(front.stem.toLowerCase(), back.stem.toLowerCase());
  if (distance <= 2 && front.stem.length > 2 && back.stem.length > 2) {
    return 0.5;
  }
  
  return 0;
}

// Check if back has barcode indicator
function hasBarcode(back: FeatureRow): boolean {
  return /barcode|upc|ean|gtin|product code/i.test(back.textExtracted);
}

// Compute signature for front (brand + product tokens)
function getFrontSignature(front: FeatureRow): string {
  return `${front.brandNorm}|${front.productTokens.sort().join(' ')}`;
}

function computeScore(front: FeatureRow, back: FeatureRow, isFrontUnique: boolean = false): CandidateScore {
  let score = 0;
  
  // Brand match
  const brandMatch = front.brandNorm !== '' && back.brandNorm !== '' && front.brandNorm === back.brandNorm;
  console.log(`[Z2-BRAND] ${front.url.split('/').pop()} (brandNorm="${front.brandNorm}") ↔ ${back.url.split('/').pop()} (brandNorm="${back.brandNorm}"): match=${brandMatch}`);
  if (brandMatch) score += 3;
  
  // Product token Jaccard
  const prodJaccard = jaccard(front.productTokens, back.productTokens);
  if (prodJaccard >= 0.5) score += 2;
  else if (prodJaccard >= 0.3) score += 1;
  
  // Variant token Jaccard
  const varJaccard = jaccard(front.variantTokens, back.variantTokens);
  if (varJaccard >= 0.5) score += 1;
  
  // Size canonical equality
  const sizeEq = front.sizeCanonical !== null && back.sizeCanonical !== null && front.sizeCanonical === back.sizeCanonical;
  if (sizeEq) score += 1;
  
  // Packaging hint equal (not 'other') - boosted for distinctive types
  const pkgMatch = front.packagingHint !== 'other' && front.packagingHint === back.packagingHint;
  let packagingBoost = 0;
  if (pkgMatch) {
    packagingBoost = front.packagingHint === 'dropper-bottle' ? cfg.pkgBoost.dropper : 
                     front.packagingHint === 'pouch' ? cfg.pkgBoost.pouch : 
                     cfg.pkgBoost.bottle;
    score += packagingBoost;
  }
  
  // Category tail overlap
  const catTailOverlap = categoryTailOverlap(front.categoryTail, back.categoryTail);
  if (catTailOverlap) score += 1;
  
  // Brand unknown rescue: if one side has unknown brand but packaging + category agree
  // (or if category is Unknown, just require packaging match)
  const brandUnknownOneSide = (!front.brandNorm || !back.brandNorm);
  let brandFlag: CandidateScore['brandFlag'] = brandMatch ? 'equal' : 'mismatch';
  let unknownRescueApplied = false;
  if (brandUnknownOneSide && pkgMatch) {
    const categoryUnknownOrMatch = !front.categoryPath || !back.categoryPath || 
                                  front.categoryPath === 'Unknown' || back.categoryPath === 'Unknown' ||
                                  catTailOverlap;
    if (categoryUnknownOrMatch) {
      score += 1.0;
      unknownRescueApplied = true;
      brandFlag = 'unknownRescue';
    }
  }
  
  // Distributor mismatch rescue: if brands don't match but other evidence is strong
  // (handles contract manufacturing where back says "Vitaminne" but front says "RKMD")
  // Give partial credit if: product match + packaging + (size OR category)
  if (!brandMatch && !unknownRescueApplied && front.brandNorm && back.brandNorm) {
    const hasStrongProductMatch = prodJaccard >= 0.5;
    const hasSupportingEvidence = (sizeEq || catTailOverlap) && pkgMatch;
    if (hasStrongProductMatch && hasSupportingEvidence) {
      score += 1.5; // Less than brand match (3) but enough to compensate
      brandFlag = 'distributorRescue';
      console.log(`[Z2-DISTRIBUTOR-RESCUE] ${front.url.split('/').pop()} (brand="${front.brandNorm}") ↔ ${back.url.split('/').pop()} (brand="${back.brandNorm}"): prodJac=${prodJaccard.toFixed(2)} pkg=${pkgMatch} size=${sizeEq} cat=${catTailOverlap}`);
    }
  }
  if (!brandMatch && !unknownRescueApplied && (!front.brandNorm || !back.brandNorm)) {
    brandFlag = 'unknown';
  }
  
  // Cosmetic/hair back cue rescue: if back has INCI-style ingredients or cosmetic directions
  const cosmeticBackCue = /ingredients:|avoid contact|12m|24m|distributed by|apply.*hair/i.test(back.textExtracted);
  if (cosmeticBackCue && back.role === 'back') {
    score += 0.5;
  }
  
  // Visual similarity: color matching (simple but effective)
  // If front and back have same dominant color, strong signal they're the same product
  const colorMatch = colorsMatch(front.colorKey, back.colorKey);
  if (colorMatch) {
    score += 1.5; // Significant boost - visual confirmation
    console.log(`[Z2-COLOR-MATCH] ${front.url.split('/').pop()} (color="${front.colorKey}") ↔ ${back.url.split('/').pop()} (color="${back.colorKey}"): MATCH`);
  }
  
  // Filename/folder proximity boost
  const proximityBoost = computeProximity(front.url, back.url);
  score += proximityBoost;
  
  // Barcode certainty nudge: if back has barcode and front has unique signature
  const barcodeBoost = (isFrontUnique && hasBarcode(back)) ? 0.5 : 0;
  score += barcodeBoost;
  
  // Role penalty (relaxed for strong matches)
  // If roles are wrong BUT we have strong visual+text evidence, reduce penalty
  const hasStrongEvidence = colorMatch && (prodJaccard >= 0.4 || sizeEq) && pkgMatch;
  if (front.role !== 'front' || back.role !== 'back') {
    if (hasStrongEvidence) {
      score -= 0.5; // Reduced penalty when visual+text evidence is strong
      console.log(`[Z2-ROLE-OVERRIDE] ${front.url.split('/').pop()} (role="${front.role}") ↔ ${back.url.split('/').pop()} (role="${back.role}"): STRONG EVIDENCE overrides role mismatch`);
    } else {
      score -= 2; // Full penalty when evidence is weak
    }
  }
  
  // Category conflict penalty
  if (hasCategoryConflict(front.categoryPath, back.categoryPath)) {
    score -= 2;
  }
  
  return {
    backUrl: back.url,
    preScore: score,
    prodJac: prodJaccard,
    varJac: varJaccard,
    sizeEq,
    packaging: front.packagingHint,
    packagingBoost,
    catTailOverlap,
    cosmeticBackCue,
    brandFlag,
    proximityBoost,
    barcodeBoost,
    // Legacy fields for backward compat
    score,
    brandMatch,
    prodJaccard,
    pkgMatch,
  };
}

export function buildCandidates(
  features: Map<string, FeatureRow>,
  K: number = 4
): Record<string, CandidateScore[]> {
  const result: Record<string, CandidateScore[]> = {};
  
  // Get all fronts and backs
  const fronts = Array.from(features.values()).filter(f => f.role === 'front');
  const backs = Array.from(features.values()).filter(f => f.role === 'back');
  
  // Compute front signature counts to detect uniqueness
  const signatureCounts = new Map<string, number>();
  for (const front of fronts) {
    const sig = getFrontSignature(front);
    signatureCounts.set(sig, (signatureCounts.get(sig) || 0) + 1);
  }
  
  for (const front of fronts) {
    const candidates: CandidateScore[] = [];
    const frontSig = getFrontSignature(front);
    const isFrontUnique = signatureCounts.get(frontSig) === 1;
    
    for (const back of backs) {
      const candidate = computeScore(front, back, isFrontUnique);
      
      // Only keep candidates with score ≥ cfg.minPreScore (configurable threshold)
      if (candidate.score >= cfg.minPreScore) {
        candidates.push(candidate);
      }
    }
    
    // Sort by score (descending), then by prodJaccard, then brandMatch, then pkgMatch
    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.prodJaccard !== a.prodJaccard) return b.prodJaccard - a.prodJaccard;
      if (b.brandMatch !== a.brandMatch) return (b.brandMatch ? 1 : 0) - (a.brandMatch ? 1 : 0);
      if (b.pkgMatch !== a.pkgMatch) return (b.pkgMatch ? 1 : 0) - (a.pkgMatch ? 1 : 0);
      return 0;
    });
    
    // Truncate to K
    const topK = candidates.slice(0, K);
    
    // Only include fronts with non-empty candidate lists
    if (topK.length > 0) {
      result[front.url] = topK;
    }
  }
  
  return result;
}

// Export function to get all candidate scores for a specific front (not truncated, sorted by preScore desc)
export function getCandidateScoresForFront(features: Map<string, FeatureRow>, frontUrl: string): CandidateScore[] {
  const front = features.get(frontUrl);
  if (!front || front.role !== 'front') return [];
  
  // Compute front uniqueness
  const fronts = Array.from(features.values()).filter(f => f.role === 'front');
  const signatureCounts = new Map<string, number>();
  for (const f of fronts) {
    const sig = getFrontSignature(f);
    signatureCounts.set(sig, (signatureCounts.get(sig) || 0) + 1);
  }
  const frontSig = getFrontSignature(front);
  const isFrontUnique = signatureCounts.get(frontSig) === 1;
  
  const backs = Array.from(features.values()).filter(f => f.role === 'back');
  const scores = backs.map(back => computeScore(front, back, isFrontUnique));
  
  // Sort by preScore descending
  scores.sort((a, b) => b.preScore - a.preScore);
  
  return scores;
}

// Domain-specific fallback for hair/cosmetics
// Hair/cosmetics backs often have INCI ingredient lists with minimal brand/product text
// Accept based on packaging type + INCI cues + size/brand agreement
export function shouldAutoPairHairCosmetic(top: CandidateScore, second?: CandidateScore): boolean {
  const gap = top.preScore - (second?.preScore ?? -Infinity);
  const pkgStrong = top.packaging === 'dropper-bottle' || top.packaging === 'bottle';
  const backHasINCI = top.cosmeticBackCue; // INCI / "apply to hair" / "ingredients:" regex
  // For hair/cosmetics, size often omitted or hard to read on small bottles - don't require exact match
  const sizeOkay = top.sizeEq || pkgStrong; // distinctive packaging excuses size mismatch

  return (
    top.preScore >= cfg.autoPairHair.score &&   // lower threshold than general (configurable)
    gap >= cfg.autoPairHair.gap &&              // still require clear winner
    pkgStrong &&                                // distinctive packaging
    backHasINCI &&                              // back has cosmetic/hair cues
    sizeOkay &&                                 // size matches or packaging type excuses mismatch
    (top.brandFlag === 'equal' || top.brandFlag === 'unknownRescue') // brand agreement or rescue
  );
}
