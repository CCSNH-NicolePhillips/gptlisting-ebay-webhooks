/**
 * Image utility functions for eBay listings
 */

/**
 * Convert Dropbox share URLs to direct download URLs
 */
function toDirectDropbox(url: string): string {
  try {
    const u = new URL(url);
    if (/(^|\.)dropbox\.com$/i.test(u.hostname)) {
      if (u.searchParams.has("dl")) {
        u.searchParams.set("dl", "1");
      } else if (/\/s\//.test(u.pathname)) {
        u.searchParams.set("raw", "1");
      }
    }
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Proxy images through our image-proxy function to handle EXIF rotation
 * and normalize image formats. This prevents rotated images on eBay.
 */
export function proxyImageUrls(urls: string[], appBase?: string): string[] {
  const base = appBase ? appBase.replace(/\/$/, "") : "";
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
    
    // Check if this is an S3 signed URL - these are already publicly accessible
    // and don't need proxying. Send them directly to eBay.
    try {
      const url = new URL(direct);
      const isS3 = url.hostname.includes('.s3.') || url.hostname.includes('.amazonaws.com');
      if (isS3) {
        console.log('[proxyImageUrls] S3 URL detected, skipping proxy:', direct.substring(0, 80));
        return direct; // Return S3 URL directly without proxy
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
