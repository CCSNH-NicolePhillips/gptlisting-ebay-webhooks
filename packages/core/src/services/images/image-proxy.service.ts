/**
 * packages/core/src/services/images/image-proxy.service.ts
 *
 * Fetch, auto-orient, resize, and compress an external image URL.
 * Returns a JPEG buffer suitable for serving directly to eBay or a browser.
 *
 * Mirrors: /.netlify/functions/image-proxy
 */

import sharp from 'sharp';

// Keep well under any 6 MB response limit
const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024; // 4.5 MB
const MAX_DIMENSION = 4000;

export class ImageProxyError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 502) {
    super(message);
    this.name = 'ImageProxyError';
    this.statusCode = statusCode;
  }
}

export type ProxyResult = {
  buffer: Buffer;
  contentType: 'image/jpeg';
};

// Normalize Dropbox viewer links to direct-download host
function normalizeDropbox(input: string): string {
  try {
    const url = new URL(input);
    if (/\.dropbox\.com$/i.test(url.hostname)) {
      url.hostname = 'dl.dropboxusercontent.com';
      url.searchParams.delete('dl');
      url.searchParams.set('raw', '1');
    }
    return url.toString();
  } catch {
    return input
      .replace('www.dropbox.com', 'dl.dropboxusercontent.com')
      .replace('?dl=0', '?raw=1')
      .replace('&dl=0', '&raw=1');
  }
}

async function tryFetch(url: string): Promise<{ buf: Buffer; type: string }> {
  const resp = await fetch(url, { redirect: 'follow' });
  const type = (resp.headers.get('content-type') || '').toLowerCase();
  if (!resp.ok) {
    throw new ImageProxyError(`Upstream fetch failed: ${resp.status}`, resp.status);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  return { buf, type };
}

/**
 * Proxy and normalise an external image URL.
 *
 * @param srcUrl  - https:// URL of the source image
 * @returns       - { buffer, contentType } JPEG output
 * @throws        - ImageProxyError for validation or upstream failures
 */
export async function proxyImage(srcUrl: string): Promise<ProxyResult> {
  if (!srcUrl) {
    throw new ImageProxyError('Missing ?url parameter', 400);
  }

  let u: URL;
  try {
    u = new URL(srcUrl);
  } catch {
    throw new ImageProxyError('Invalid URL', 400);
  }
  if (u.protocol !== 'https:') {
    throw new ImageProxyError('Only https URLs are allowed', 400);
  }

  // First fetch attempt
  let target = srcUrl;
  let { buf, type } = await tryFetch(target);

  // Dropbox HTML viewer fallback → direct content URL
  if (!type.startsWith('image/') && /dropbox\.com/i.test(target)) {
    target = normalizeDropbox(target);
    ({ buf, type } = await tryFetch(target));
  }

  if (!type.startsWith('image/')) {
    throw new ImageProxyError(`Not an image (type=${type})`, 415);
  }

  // Process with sharp: auto-orient, downscale, compress
  let outBuf: Buffer = buf;
  try {
    const s = sharp(buf, { failOnError: false });
    const metadata = await s.metadata();

    const needsRotation = metadata.orientation && metadata.orientation !== 1;
    const needsResize =
      (metadata.width && metadata.width > MAX_DIMENSION) ||
      (metadata.height && metadata.height > MAX_DIMENSION);
    const isTooLarge = buf.length > MAX_IMAGE_BYTES;

    if (needsRotation || needsResize || isTooLarge) {
      let pipeline = sharp(buf, { failOnError: false });
      if (needsRotation) pipeline = pipeline.rotate();
      if (needsResize) {
        pipeline = pipeline.resize(MAX_DIMENSION, MAX_DIMENSION, {
          fit: 'inside',
          withoutEnlargement: true,
        });
      }

      let quality = 95;
      if (buf.length > 12 * 1024 * 1024) quality = 85;
      else if (buf.length > 10 * 1024 * 1024) quality = 88;
      else if (buf.length > 8 * 1024 * 1024) quality = 90;

      outBuf = await pipeline.jpeg({ quality, mozjpeg: false }).toBuffer();

      // Progressive fall-backs if still too large
      if (outBuf.length > MAX_IMAGE_BYTES) {
        outBuf = await sharp(buf, { failOnError: false })
          .rotate()
          .resize(3000, 3000, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 88, mozjpeg: false })
          .toBuffer();
      }
      if (outBuf.length > MAX_IMAGE_BYTES) {
        outBuf = await sharp(buf, { failOnError: false })
          .rotate()
          .resize(2400, 2400, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 85, mozjpeg: true })
          .toBuffer();
      }
    }
  } catch {
    // sharp failure — return original buffer as-is below
  }

  if (outBuf.length > MAX_IMAGE_BYTES) {
    throw new ImageProxyError(
      `Image too large after compression (${Math.round(outBuf.length / 1024 / 1024)}MB)`,
      413,
    );
  }

  return { buffer: outBuf, contentType: 'image/jpeg' };
}
