/**
 * Sanitize insight URL from vision model response.
 * Models sometimes return placeholder values like "<imgUrl>" instead of real URLs.
 * This function detects those placeholders and falls back to the original request URL.
 * 
 * @param u - The URL from the model response
 * @param fallback - The original image URL that was sent to the model
 * @returns Clean URL or fallback
 */
export function sanitizeInsightUrl(u?: string | null, fallback?: string): string {
  const v = (u || '').trim();
  // any of these means "the model didn't return a real URL"
  if (!v || v === '<imgUrl>' || v === '<imgurl>' || /^<.*>$/.test(v)) {
    return fallback || '';
  }
  return v;
}
