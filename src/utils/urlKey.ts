/**
 * Canonical URL key for de-duplication and consistent lookups.
 * Returns the basename (filename) only, lowercased, with no query params.
 * Also strips common uploader prefixes like "EBAY_" or "EBAY-".
 * 
 * This ensures:
 * - "asd32q.jpg" → "asd32q.jpg"
 * - "EBAY/awef.jpg" → "awef.jpg"
 * - "EBAY_frog_01.jpg" → "frog_01.jpg"
 * - "EBAY-awefawed.jpg" → "awefawed.jpg"
 * - "https://dl.dropbox.../awef.jpg?rlkey=..." → "awef.jpg"
 * 
 * All map the same basename consistently.
 */
export function urlKey(u: string): string {
  const t = (u || '').trim().toLowerCase()
    .replace(/\s*\|\s*/g, '/');          // "EBAY | x.jpg" -> "EBAY/x.jpg"
  const noQuery = t.split('?')[0];
  const parts = noQuery.split('/');
  const base = parts[parts.length - 1] || noQuery;
  // strip common uploader prefixes
  return base.replace(/^(ebay[_-]|ebay_)/i, '');
}
