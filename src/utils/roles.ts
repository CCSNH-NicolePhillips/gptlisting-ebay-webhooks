/**
 * Build a role lookup map from imageInsights.
 * Maps key -> { role, score } for deterministic hero/back selection.
 */
export function buildRoleMap(imageInsights: any[]): Map<string, { role: string; score: number }> {
  const map = new Map<string, { role: string; score: number }>();
  
  for (const ins of imageInsights || []) {
    const key = ins.key || ins._key || ins.urlKey || ins.url;
    if (!key) continue;
    
    const score = typeof ins.roleScore === 'number' ? ins.roleScore : 0;
    
    // Keep the entry with larger |roleScore| when duplicates slip in
    const prev = map.get(key);
    if (!prev || Math.abs(score) > Math.abs(prev.score)) {
      map.set(key, { role: (ins.role || 'unknown'), score });
    }
  }
  
  return map;
}
