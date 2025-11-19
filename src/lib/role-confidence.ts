/**
 * Phase 5: Role Confidence Layer
 * Computes enhanced confidence scores for image roles (front/back/side/label/detail)
 * to ensure 100% pairing accuracy
 */

export interface RoleConfidence {
  role: string;
  confidence: number;
  adjustedRole?: string;  // Role after confidence-based correction
  flags: string[];        // Issues detected (e.g., "low_confidence", "contradiction")
}

export interface ImageInsight {
  url?: string;
  key?: string;
  _key?: string;
  urlKey?: string;
  role?: string;
  roleScore?: number;
  hasVisibleText?: boolean;
  textExtracted?: string;
  visualDescription?: string;
  dominantColor?: string;
  evidenceTriggers?: string[];
}

/**
 * Compute role confidence score with heuristics:
 * - Vision's base roleScore (already present)
 * - Text density and distribution
 * - Branding clarity (large centered text vs small details)
 * - Background uniformity (plain white/black = front, complex = back/detail)
 * - Symmetry indicators (centered = front, off-center = angle)
 */
export function computeRoleConfidence(insight: ImageInsight): RoleConfidence {
  const role = insight.role || 'other';
  const baseScore = typeof insight.roleScore === 'number' ? insight.roleScore : 0;
  
  // Start with Vision's base score (already well-tuned)
  let confidence = Math.abs(baseScore);
  const flags: string[] = [];
  
  // Heuristic 1: Text density analysis
  const text = insight.textExtracted || '';
  const textLength = text.length;
  const hasSubstantialText = textLength > 50;
  
  if (role === 'front') {
    // Fronts typically have moderate text (brand, product name, claims)
    if (textLength > 20 && textLength < 200) {
      confidence += 0.1;
    }
    // Too much text might indicate back panel (directions, ingredients)
    if (textLength > 400) {
      confidence -= 0.15;
      flags.push('excessive_text_for_front');
    }
  } else if (role === 'back') {
    // Backs often have dense text (ingredients, directions, warnings)
    if (textLength > 200) {
      confidence += 0.15;
    }
    if (textLength < 30) {
      confidence -= 0.1;
      flags.push('low_text_for_back');
    }
  }
  
  // Heuristic 2: Branding clarity (from evidenceTriggers and visualDescription)
  const triggers = insight.evidenceTriggers || [];
  const visualDesc = insight.visualDescription || '';
  
  const hasBrandingIndicators = triggers.some(t => 
    t.toLowerCase().includes('brand logo') ||
    t.toLowerCase().includes('hero text') ||
    t.toLowerCase().includes('large centered')
  );
  
  const hasBackIndicators = triggers.some(t =>
    t.toLowerCase().includes('supplement facts') ||
    t.toLowerCase().includes('nutrition facts') ||
    t.toLowerCase().includes('barcode') ||
    t.toLowerCase().includes('directions') ||
    t.toLowerCase().includes('ingredients')
  );
  
  if (role === 'front' && hasBrandingIndicators) {
    confidence += 0.15;
  }
  
  if (role === 'back' && hasBackIndicators) {
    confidence += 0.2;  // Strong indicator
  }
  
  // Contradiction detection: front indicators on a "back" label
  if (role === 'back' && hasBrandingIndicators && !hasBackIndicators) {
    flags.push('front_indicators_on_back_label');
    confidence -= 0.3;
  }
  
  if (role === 'front' && hasBackIndicators && !hasBrandingIndicators) {
    flags.push('back_indicators_on_front_label');
    confidence -= 0.3;
  }
  
  // Heuristic 3: Background uniformity
  const dominantColor = insight.dominantColor || '';
  const isPlainBackground = dominantColor === 'white' || dominantColor === 'black';
  
  if (role === 'front' && isPlainBackground) {
    confidence += 0.05;  // Fronts often photographed on plain backgrounds
  }
  
  // Heuristic 4: Visual description analysis
  const descLower = visualDesc.toLowerCase();
  
  // Check for "full-wrap label" or "360-degree" indicators
  if (descLower.includes('full-wrap') || descLower.includes('360')) {
    if (role !== 'detail' && role !== 'label') {
      flags.push('full_wrap_label_detected');
    }
  }
  
  // Check for structural cues
  const hasSymmetry = descLower.includes('centered') || descLower.includes('symmetrical');
  const isRotated = descLower.includes('rotated') || descLower.includes('angled');
  
  if (role === 'front' && hasSymmetry) {
    confidence += 0.1;
  }
  
  if (role === 'front' && isRotated) {
    confidence -= 0.15;
    flags.push('rotated_image_marked_as_front');
  }
  
  // Clamp confidence to [0, 1]
  confidence = Math.max(0, Math.min(1, confidence));
  
  // Low confidence flag
  if (confidence < 0.4) {
    flags.push('low_confidence');
  }
  
  // Role correction based on flags
  let adjustedRole = role;
  
  if (flags.includes('back_indicators_on_front_label') && confidence < 0.5) {
    adjustedRole = 'back';
    flags.push('role_corrected_front_to_back');
  }
  
  if (flags.includes('front_indicators_on_back_label') && confidence < 0.5) {
    adjustedRole = 'front';
    flags.push('role_corrected_back_to_front');
  }
  
  return {
    role: adjustedRole,
    confidence,
    adjustedRole: adjustedRole !== role ? adjustedRole : undefined,
    flags
  };
}

/**
 * Analyze all insights in a batch and return confidence-enhanced roles
 */
export function computeRoleConfidenceBatch(insights: ImageInsight[]): Map<string, RoleConfidence> {
  const results = new Map<string, RoleConfidence>();
  
  for (const insight of insights) {
    const key = insight.key || insight._key || insight.urlKey || insight.url || '';
    if (!key) continue;
    
    const roleConf = computeRoleConfidence(insight);
    results.set(key, roleConf);
  }
  
  return results;
}

/**
 * Cross-check roles within a group for consistency
 * Returns corrections if multiple conflicting fronts are detected
 */
export interface GroupRoleCorrection {
  groupId: string;
  corrections: Array<{
    imageKey: string;
    originalRole: string;
    correctedRole: string;
    reason: string;
  }>;
}

export function crossCheckGroupRoles(
  groupId: string,
  imageKeys: string[],
  confidenceMap: Map<string, RoleConfidence>
): GroupRoleCorrection {
  const corrections: GroupRoleCorrection['corrections'] = [];
  
  // Find all fronts in this group
  const fronts = imageKeys
    .map(key => ({ key, conf: confidenceMap.get(key) }))
    .filter(item => item.conf?.role === 'front')
    .sort((a, b) => (b.conf?.confidence || 0) - (a.conf?.confidence || 0));
  
  // If multiple fronts, keep only the highest confidence one
  if (fronts.length > 1) {
    const bestFront = fronts[0];
    
    for (let i = 1; i < fronts.length; i++) {
      const weaker = fronts[i];
      corrections.push({
        imageKey: weaker.key,
        originalRole: 'front',
        correctedRole: 'side',  // Demote to side/angle
        reason: `Multiple fronts detected, keeping highest confidence (${bestFront.conf?.confidence.toFixed(2)} vs ${weaker.conf?.confidence.toFixed(2)})`
      });
    }
  }
  
  // If zero fronts, promote the best candidate
  const backs = imageKeys
    .map(key => ({ key, conf: confidenceMap.get(key) }))
    .filter(item => item.conf?.role === 'back')
    .sort((a, b) => (b.conf?.confidence || 0) - (a.conf?.confidence || 0));
  
  const sides = imageKeys
    .map(key => ({ key, conf: confidenceMap.get(key) }))
    .filter(item => item.conf?.role === 'side' || item.conf?.role === 'other')
    .sort((a, b) => (b.conf?.confidence || 0) - (a.conf?.confidence || 0));
  
  if (fronts.length === 0 && imageKeys.length > 0) {
    // Promote the best non-back image to front
    // CRITICAL: Do NOT promote backs to fronts - this destroys pairing!
    // Only promote sides/other images. If only backs exist, leave them alone.
    const candidate = sides[0];
    
    if (candidate) {
      corrections.push({
        imageKey: candidate.key,
        originalRole: candidate.conf?.role || 'other',
        correctedRole: 'front',
        reason: `No front detected in group, promoting best candidate (confidence: ${candidate.conf?.confidence.toFixed(2)})`
      });
    }
    // If no sides available and only backs exist, do nothing - let pairing handle it
  }
  
  return {
    groupId,
    corrections
  };
}
