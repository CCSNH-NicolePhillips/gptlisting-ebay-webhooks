/**
 * Final display URL hydrator - ensures every image has a loadable thumbnail URL.
 * Runs once after all harvesting is complete.
 */

export interface FinalizeDisplayOptions {
  httpsByKey: Map<string, string>;      // Harvested https URLs by key
  originalByKey: Map<string, string>;   // Original file URLs by key
  folderParam: string;                   // User-provided folder path
  publicFilesBase?: string;              // Optional proxy base (e.g., "/files")
}

export function finalizeDisplayUrls(
  analysis: any,
  options: FinalizeDisplayOptions
): void {
  const { httpsByKey, originalByKey, folderParam, publicFilesBase } = options;

  function toHttps(u: string): string {
    return /^https?:\/\//i.test(u || '') ? u : '';
  }

  function compute(key: string): string {
    // 1) Prefer known https link we already saw
    const fromSeen = toHttps(httpsByKey.get(key) || '');
    if (fromSeen) return fromSeen;

    // 2) If original was https, use that
    const orig = toHttps(originalByKey.get(key) || '');
    if (orig) return orig;

    // 3) If folder is a Dropbox share, at least return the folder (better than empty);
    //    your UI will still render (and we'll replace later with a proxy if needed).
    if (/^https?:\/\//i.test(folderParam)) return folderParam;

    // 4) Local fallback (you can serve these via a proxy route):
    if (publicFilesBase) {
      return `${publicFilesBase}/${encodeURIComponent(key)}`;
    }

    // 5) Last resort: relative path (works if your static server serves /EBAY)
    const f = (folderParam || '').replace(/^\/*/, '').replace(/\/+$/, '');
    return f ? `/${f}/${encodeURIComponent(key)}` : `/${encodeURIComponent(key)}`;
  }

  // Hydrate every insight
  const imageInsights = analysis.imageInsights || {};
  const insightList = Array.isArray(imageInsights)
    ? imageInsights
    : Object.values(imageInsights);

  for (const ins of insightList) {
    if (!ins) continue;
    
    const key = ins.key || ins._key || ins.urlKey || ins.url;
    if (!key) continue;

    // Only compute if missing or not https
    if (!ins.displayUrl || !/^https?:\/\//i.test(ins.displayUrl)) {
      ins.displayUrl = compute(key);
    }
  }

  // Debug once: report any remaining failures
  const missing = insightList
    .filter(x => x && (!/^https?:\/\//i.test(x.displayUrl || '')))
    .map(x => x.key || x.url);
  
  if (missing.length) {
    console.warn('[finalizeDisplay] still missing https URLs for:', missing);
  } else {
    console.log('[finalizeDisplay] ✓ All insights have valid display URLs');
  }
}
