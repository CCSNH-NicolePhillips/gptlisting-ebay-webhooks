/**
 * Image utility functions for eBay listings
 */

/**
 * Normalize Dropbox shared links to return image bytes instead of HTML.
 * Dropbox share links return HTML unless raw=1 is set.
 * - Replaces dl=0 with raw=1
 * - Removes dl=1 and adds raw=1
 * - Appends raw=1 if no dl/raw param exists
 * Non-Dropbox URLs are returned unchanged.
 */
export function normalizeDropboxUrl(url: string): string {
  try {
    const u = new URL(url);
    // Only modify dropbox.com URLs
    if (!/(^|\.)dropbox\.com$/i.test(u.hostname)) {
      return url;
    }
    // Remove dl param (dl=0 or dl=1 both don't reliably return bytes)
    u.searchParams.delete("dl");
    // Ensure raw=1 is set for direct image bytes
    u.searchParams.set("raw", "1");
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * @deprecated Use normalizeDropboxUrl instead - this function doesn't reliably return bytes
 */
function toDirectDropbox(url: string): string {
  return normalizeDropboxUrl(url);
}

/**
 * Proxy images through our image-proxy function to handle EXIF rotation
 * and normalize image formats. This prevents rotated images on eBay.
 */
export function proxyImageUrls(urls: string[], appBase?: string): string[] {
  // Derive base URL from runtime environment - NO hardcoded fallback!
  // Priority: explicit param > browser origin > Netlify env vars
  let base: string | undefined;
  
  if (appBase) {
    base = appBase;
  } else if (typeof window !== 'undefined' && window.location?.origin) {
    // Running in browser - use current origin
    base = window.location.origin;
  } else {
    // Running in Node.js (Netlify Functions) - use env vars
    base = process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.APP_URL;
  }
  
  if (!base) {
    throw new Error("proxyImageUrl: missing base URL - set APP_URL, URL, or DEPLOY_PRIME_URL env var");
  }
  
  base = base.replace(/\/$/, "");
  console.log("[image] proxy base:", base);
  
  const isProxy = (u: string) => /\/\.netlify\/functions\/image-proxy/i.test(u);
  
  const absolutizeProxy = (u: string) => {
    if (u.startsWith("/") && base) return `${base}${u}`;
    return u;
  };
  
  const addBust = (u: string) => {
    try {
      const url = new URL(u, base || undefined);
      url.searchParams.set("v", Date.now().toString(36));
      return url.toString();
    } catch {
      return `${u}${u.includes("?") ? "&" : "?"}v=${Date.now().toString(36)}`;
    }
  };
  
  const maybeProxy = (source: string) => {
    // Already proxied
    if (isProxy(source)) return addBust(absolutizeProxy(source));
    
    // Convert Dropbox share to direct
    const direct = toDirectDropbox(source);
    if (isProxy(direct)) return addBust(absolutizeProxy(direct));
    
    // Check if this is an S3 signed URL - need to convert to short redirect URL
    // eBay requires picture URLs ≤500 chars, but S3 presigned URLs are ~550+ chars
    try {
      const url = new URL(direct);
      const isS3 = url.hostname.includes('.s3.') || url.hostname.includes('.amazonaws.com');
      if (isS3) {
        // Extract the S3 object key from the URL path
        // URL format: https://bucket.s3.region.amazonaws.com/staging/user/job/hash-file.jpg?X-Amz-...
        const key = decodeURIComponent(url.pathname.replace(/^\//, ''));
        if (key && key.startsWith('staging/')) {
          // Use short redirect URL: /.netlify/functions/img?k=staging/user/job/hash-file.jpg
          // This is ~100-150 chars vs 550+ chars for presigned URL
          const shortUrl = `${base}/.netlify/functions/img?k=${encodeURIComponent(key)}`;
          console.log('[proxyImageUrls] S3 URL → short redirect:', shortUrl.length, 'chars');
          return shortUrl;
        }
        // If not a staging URL, return as-is (shouldn't happen in normal flow)
        console.log('[proxyImageUrls] S3 URL (non-staging), using as-is:', direct.substring(0, 80));
        return direct;
      }
    } catch {
      // Not a valid URL, continue with proxy logic
    }
    
    // Proxy all other images to handle EXIF rotation
    try {
      const url = new URL(direct);
      const prox = base
        ? `${base}/.netlify/functions/image-proxy?url=${encodeURIComponent(direct)}`
        : `/.netlify/functions/image-proxy?url=${encodeURIComponent(direct)}`;
      return addBust(absolutizeProxy(prox));
    } catch {
      // If URL parsing fails, still try to proxy it
      const prox = `/.netlify/functions/image-proxy?url=${encodeURIComponent(direct)}`;
      return addBust(prox);
    }
  };

  return urls.map((src) => maybeProxy(String(src)));
}
