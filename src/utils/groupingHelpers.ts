/**
 * Grouping helpers for SmartDrafts analysis phase.
 * Prevents cross-category merges and weak matches.
 */

/**
 * Normalize brand name for comparison.
 * Removes dots, punctuation, corporate suffixes, and normalizes whitespace.
 * Extracts core brand name to handle variations like "Jocko Fuel" vs "Jocko".
 */
export function normBrand(s?: string | null): string {
  if (!s || s === 'Unknown') return '';
  
  // Normalize to lowercase and remove corporate suffixes
  let normalized = (s || '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\b(inc|llc|co|corp|ltd|company|brands|supplements|nutrition|wellness|fuel)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  
  // Handle common brand variations - extract core brand name
  const tokens = normalized.split(/\s+/).filter(Boolean);
  
  // If brand has multiple words, keep first significant word
  if (tokens.length > 1) {
    const genericWords = ['by', 'from', 'the', 'a', 'an'];
    const significantTokens = tokens.filter(t => !genericWords.includes(t) && t.length > 0);
    
    // Return first significant token as the core brand
    if (significantTokens.length > 0) {
      return significantTokens[0];
    }
  }
  
  return normalized;
}

/**
 * Tokenize a string into normalized words.
 */
export function tokenize(s?: string | null): string[] {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Compute Jaccard similarity between two token arrays.
 */
export function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  const inter = [...A].filter(x => B.has(x)).length;
  const uni = new Set([...A, ...B]).size || 1;
  return inter / uni;
}

/**
 * Categorize a path into a simple bucket.
 */
function bucket(path?: string | null): string {
  const p = (path || '').toLowerCase();
  if (/supplement|vitamin|nutrition/.test(p)) return 'supp';
  if (/food|beverage|grocery/.test(p)) return 'food';
  if (/hair/.test(p)) return 'hair';
  if (/skin|cosmetic|make ?up|spf/.test(p)) return 'cosm';
  if (/accessor(y|ies)/.test(p)) return 'accessory';
  return 'other';
}

/**
 * Check category compatibility between two paths.
 * Returns:
 *  1.0 = same meaningful category
 *  0.2-0.6 = compatible or one is 'other'
 * -1.0 = incompatible (e.g., hair vs supplement)
 */
export function categoryCompat(pathA?: string | null, pathB?: string | null): number {
  const a = bucket(pathA);
  const b = bucket(pathB);
  
  if (a === b && a !== 'other') return 1.0;   // same meaningful lane
  if (a === 'other' || b === 'other') return 0.2;
  
  // Disallow classic mismatches
  if ((a === 'hair' && (b === 'supp' || b === 'food')) ||
      (b === 'hair' && (a === 'supp' || a === 'food'))) return -1.0;
  
  // Food and supplements are somewhat compatible
  if ((a === 'supp' && b === 'food') || (a === 'food' && b === 'supp')) return 0.4;
  
  return 0.0;
}
