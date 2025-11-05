import { toDirectDropbox } from "../lib/merge.js";

/**
 * Build a real display URL for rendering thumbnails.
 * Ensures every insight has a valid https:// URL for the UI.
 * 
 * Priority:
 * 1. If originalUrl is already a full Dropbox URL, normalize it to direct
 * 2. If it's a plain path/basename, we can't reconstruct without more context
 *    (in practice, the scan should always provide full Dropbox URLs)
 * 
 * @param originalUrl - The URL that was sent to vision API (from files[i].url)
 * @param basename - The cleaned basename (from urlKey)
 * @returns A display-ready URL
 */
export function makeDisplayUrl(originalUrl: string, basename: string): string {
  if (!originalUrl) return basename;
  
  const normalized = toDirectDropbox(originalUrl);
  
  // If we got a real URL back, use it
  if (/^https?:\/\//i.test(normalized)) {
    return normalized;
  }
  
  // Otherwise return the originalUrl as-is (may be a path)
  return originalUrl;
}
