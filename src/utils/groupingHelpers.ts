/**
 * Grouping helpers for SmartDrafts analysis phase.
 * Prevents cross-category merges and weak matches.
 */

/**
 * Normalize brand name for comparison.
 * Removes dots, punctuation, corporate suffixes, and normalizes whitespace.
 */
export function normBrand(s?: string | null): string {
  return (s || '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\b(inc|llc|co|corp|ltd|company)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
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
