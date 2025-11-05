/**
 * Canonical URL key for de-duplication and consistent lookups.
 * Returns the basename (filename) only, lowercased, with no query params.
 * 
 * This ensures:
 * - "asd32q.jpg" → "asd32q.jpg"
 * - "EBAY/awef.jpg" → "awef.jpg"
 * - "EBAY-awefawed.jpg" → "ebay-awefawed.jpg"
 * - "https://dl.dropbox.../awef.jpg?rlkey=..." → "awef.jpg"
 * 
 * All map the same basename consistently.
 */
export function urlKey(u: string): string {
  const t = (u || '').trim().toLowerCase().replace(/\s*\|\s*/g, '/');
  const noQuery = t.split('?')[0];
  const parts = noQuery.split('/');
  return parts[parts.length - 1] || noQuery; // basename only
}
