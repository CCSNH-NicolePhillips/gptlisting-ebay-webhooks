/**
 * Phase 5.4: Orphan Reassignment
 * Attempts to match orphaned images to existing product groups
 * using similarity heuristics
 */

export interface OrphanMatch {
  orphanKey: string;
  matchedGroupId: string;
  confidence: number;
  reason: string;
}

/**
 * Simple text similarity using Jaccard index on words
 */
function textSimilarity(text1: string, text2: string): number {
  const words1 = new Set(text1.toLowerCase().split(/\W+/).filter(w => w.length > 2));
  const words2 = new Set(text2.toLowerCase().split(/\W+/).filter(w => w.length > 2));
  
  if (words1.size === 0 || words2.size === 0) return 0;
  
  const intersection = new Set([...words1].filter(w => words2.has(w)));
  const union = new Set([...words1, ...words2]);
  
  return intersection.size / union.size;
}

/**
 * Check if two colors are similar (basic string matching)
 */
function colorSimilarity(color1: string, color2: string): number {
  if (!color1 || !color2) return 0;
  return color1.toLowerCase() === color2.toLowerCase() ? 1.0 : 0.0;
}

/**
 * Attempt to match an orphan to an existing group
 * Returns confidence score [0, 1]
 */
export function matchOrphanToGroup(
  orphan: {
    url?: string;
    key?: string;
    textExtracted?: string;
    visualDescription?: string;
    dominantColor?: string;
  },
  group: {
    groupId?: string;
    name?: string;
    images?: any[];
  },
  allInsights: Map<string, any>
): { confidence: number; reasons: string[] } {
  let confidence = 0;
  const reasons: string[] = [];
  
  const orphanText = orphan.textExtracted || '';
  const orphanVisual = orphan.visualDescription || '';
  const orphanColor = orphan.dominantColor || '';
  
  // Get insights for images in the group
  const groupImages = group.images || [];
  if (groupImages.length === 0) {
    return { confidence: 0, reasons: ['Empty group'] };
  }
  
  let maxTextSim = 0;
  let maxVisualSim = 0;
  let colorMatches = 0;
  
  for (const img of groupImages) {
    const imgKey = typeof img === 'string' ? img : img.url || '';
    const insight = allInsights.get(imgKey);
    
    if (!insight) continue;
    
    // Text similarity (OCR)
    const groupText = insight.textExtracted || '';
    if (orphanText && groupText) {
      const sim = textSimilarity(orphanText, groupText);
      maxTextSim = Math.max(maxTextSim, sim);
    }
    
    // Visual description similarity
    const groupVisual = insight.visualDescription || '';
    if (orphanVisual && groupVisual) {
      const sim = textSimilarity(orphanVisual, groupVisual);
      maxVisualSim = Math.max(maxVisualSim, sim);
    }
    
    // Color matching
    const groupColor = insight.dominantColor || '';
    if (orphanColor && colorSimilarity(orphanColor, groupColor) > 0.5) {
      colorMatches++;
    }
  }
  
  // Scoring
  if (maxTextSim > 0.3) {
    confidence += maxTextSim * 0.5;  // Text is a strong signal
    reasons.push(`Text similarity: ${(maxTextSim * 100).toFixed(0)}%`);
  }
  
  if (maxVisualSim > 0.2) {
    confidence += maxVisualSim * 0.3;  // Visual description helps
    reasons.push(`Visual similarity: ${(maxVisualSim * 100).toFixed(0)}%`);
  }
  
  if (colorMatches > 0) {
    const colorConfidence = Math.min(colorMatches / groupImages.length, 0.2);
    confidence += colorConfidence;
    reasons.push(`Color matches: ${colorMatches}/${groupImages.length}`);
  }
  
  // Normalize confidence to [0, 1]
  confidence = Math.min(confidence, 1.0);
  
  if (confidence < 0.3) {
    reasons.push('Confidence too low for reassignment');
  }
  
  return { confidence, reasons };
}

/**
 * Attempt to reassign orphans to existing groups
 * Returns list of successful matches
 */
export function reassignOrphans(
  orphans: any[],
  groups: any[],
  allInsights: Map<string, any>,
  confidenceThreshold = 0.5
): OrphanMatch[] {
  const matches: OrphanMatch[] = [];
  
  for (const orphan of orphans) {
    const orphanKey = orphan.key || orphan.url || '';
    if (!orphanKey) continue;
    
    let bestMatch: { groupId: string; confidence: number; reason: string } | null = null;
    
    for (const group of groups) {
      const result = matchOrphanToGroup(orphan, group, allInsights);
      
      if (result.confidence >= confidenceThreshold) {
        if (!bestMatch || result.confidence > bestMatch.confidence) {
          bestMatch = {
            groupId: group.groupId || group.name || 'unknown',
            confidence: result.confidence,
            reason: result.reasons.join('; ')
          };
        }
      }
    }
    
    if (bestMatch) {
      matches.push({
        orphanKey,
        matchedGroupId: bestMatch.groupId,
        confidence: bestMatch.confidence,
        reason: bestMatch.reason
      });
    }
  }
  
  return matches;
}
