import type { Handler } from '@netlify/functions';
import sharp from 'sharp';

export const handler: Handler = async (event) => {
  try {
    const src = event.queryStringParameters?.url;
    if (!src) return { statusCode: 400, body: 'Missing ?url' };

    const u = new URL(src);
    if (u.protocol !== 'https:') return { statusCode: 400, body: 'Only https URLs are allowed' };

    // Normalize Dropbox viewer links to direct content host
    const normalizeDropbox = (input: string) => {
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
    };

    const tryFetch = async (url: string) => {
      const resp = await fetch(url, { redirect: 'follow' });
      const type = (resp.headers.get('content-type') || '').toLowerCase();
      return { resp, type };
    };

    let target = src;
    // First attempt
    let { resp, type } = await tryFetch(target);
    // If Dropbox returns HTML viewer, try normalized direct link
    if (resp.ok && !type.startsWith('image/') && /dropbox\.com/i.test(target)) {
      target = normalizeDropbox(target);
      ({ resp, type } = await tryFetch(target));
    }
    if (!resp.ok) return { statusCode: resp.status, body: `Upstream fetch failed: ${resp.status}` };
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!type.startsWith('image/')) {
      return { statusCode: 415, body: `Not an image (type=${type})` };
    }
    // Auto-orient images based on EXIF to avoid sideways photos on eBay
    let outBuf: Buffer = buf as Buffer;
    try {
      const s = sharp(buf, { failOnError: false });
    // Rotate according to EXIF orientation and output JPEG which strips EXIF by default
    const rotated = await s.rotate().jpeg({ quality: 92, mozjpeg: true }).toBuffer();
    if (rotated && rotated.length) outBuf = Buffer.from(rotated);
    } catch {
      // If sharp fails, fallback to original buffer
    }

    // Always emit JPEG so downstream (eBay) gets normalized pixels without EXIF orientation
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=31536000, immutable',
        // Allow eBay crawler
        'Access-Control-Allow-Origin': '*',
      },
      body: outBuf.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (e: any) {
    return { statusCode: 502, body: `image-proxy error: ${e?.message || String(e)}` };
  }
};
