export function urlKey(u='') {
  const t = String(u).trim().toLowerCase().replace(/\s*\|\s*/g, '/');
  const noQuery = t.split('?')[0];
  const parts = noQuery.split('/');
  return parts[parts.length - 1] || noQuery;
}
