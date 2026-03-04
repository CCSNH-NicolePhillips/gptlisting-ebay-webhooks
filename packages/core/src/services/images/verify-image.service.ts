/**
 * packages/core/src/services/images/verify-image.service.ts
 *
 * Check whether a URL resolves to a valid image.
 * Returns metadata about the image (status, content-type, size).
 *
 * Mirrors: netlify/functions/verify-image.ts
 * Route:   GET /api/images/verify?url=<encoded-url>
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VerifyImageResult {
  ok: boolean;
  status: number;
  contentType: string;
  contentLength: string;
  sizeBytes: number;
  finalUrl: string;
}

// ─── Error classes ────────────────────────────────────────────────────────────

export class VerifyImageError extends Error {
  readonly statusCode = 502;
  constructor(message: string) {
    super(message);
    this.name = 'VerifyImageError';
  }
}

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * Fetch the given URL and return image metadata.
 *
 * Returns { ok: false, ... } for non-image responses (status 422 on the route).
 *
 * @throws {VerifyImageError} on network / DNS errors.
 */
export async function verifyImage(url: string): Promise<VerifyImageResult> {
  try {
    const r = await fetch(url, { method: 'GET', redirect: 'follow' });
    const contentType = r.headers.get('content-type') || '';
    const contentLength = r.headers.get('content-length') || '';
    const buf = await r.arrayBuffer();
    const ok = r.ok && contentType.startsWith('image/');

    return {
      ok,
      status: r.status,
      contentType,
      contentLength,
      sizeBytes: buf.byteLength,
      finalUrl: r.url,
    };
  } catch (err: any) {
    throw new VerifyImageError(err?.message || String(err));
  }
}
