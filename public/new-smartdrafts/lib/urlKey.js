export function urlKey(u='') {
  const t = String(u).trim().toLowerCase().replace(/\s*\|\s*/g, '/');
  const noQuery = t.split('?')[0];
  const parts = noQuery.split('/');
  return parts[parts.length - 1] || noQuery;
}

// Return a canonical folder string the backend can accept.
// - Accepts: dropbox shared link, dl link, or raw folder path (EBAY/...).
export function normalizeFolderInput(input='') {
  let s = String(input).trim();
  if (!s) return '';

  // Convert "EBAY | filename.jpg" → "EBAY/filename.jpg" (seen in your logs)
  s = s.replace(/\s*\|\s*/g, '/');

  // If it's a Dropbox share link, keep as-is; server can expand it.
  // If it's a dl.dropboxusercontent link, keep as-is.
  // If it's a bare path, keep as-is.
  // No heavy parsing needed; just ensure no accidental spaces.
  return s;
}
