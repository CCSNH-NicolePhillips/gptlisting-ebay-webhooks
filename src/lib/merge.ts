/**
 * Convert a Dropbox "share" URL into a direct-download URL
 * Example:
 *  www.dropbox.com/scl/fo/...?...dl=0  →  dl.dropboxusercontent.com/scl/fo/...
 */
export function toDirectDropbox(url: string): string {
  try {
    if (!url) return url;
    let clean = url.trim();

    clean = clean
      .replace("www.dropbox.com", "dl.dropboxusercontent.com")
      .replace("dropbox.com", "dl.dropboxusercontent.com");

    clean = clean.replace(/\?dl=\d/, "");

    return clean;
  } catch {
    return url;
  }
}

/**
 * Basic URL sanitizer: trims, removes duplicates, and filters out falsy entries.
 */
export function sanitizeUrls(urls: string[] = []): string[] {
  const set = new Set<string>();
  for (const raw of urls) {
    const val = (raw || "").trim();
    if (!val) continue;
    set.add(val);
  }
  return Array.from(set);
}
