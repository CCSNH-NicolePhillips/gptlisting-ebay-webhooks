import type { Handler } from '@netlify/functions';

export const handler: Handler = async (event) => {
  try {
    const src = event.queryStringParameters?.url;
    if (!src) return { statusCode: 400, body: 'Missing ?url' };

    const u = new URL(src);
    if (u.protocol !== 'https:') return { statusCode: 400, body: 'Only https URLs are allowed' };

    // Follow redirects; Dropbox often redirects
    const r = await fetch(src, { redirect: 'follow' });
    if (!r.ok) return { statusCode: r.status, body: `Upstream fetch failed: ${r.status}` };
    const type = (r.headers.get('content-type') || '').toLowerCase();
    const buf = Buffer.from(await r.arrayBuffer());
    // Validate image content type
    if (!type.startsWith('image/')) {
      return { statusCode: 415, body: `Not an image (type=${type})` };
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': type,
        'Cache-Control': 'public, max-age=31536000, immutable',
        // Allow eBay crawler
        'Access-Control-Allow-Origin': '*',
      },
      body: buf.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (e: any) {
    return { statusCode: 502, body: `image-proxy error: ${e?.message || String(e)}` };
  }
};
