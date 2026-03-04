/**
 * packages/core/src/services/ebay/offer-thumb.service.ts
 *
 * Fetch a thumbnail image for an eBay offer.
 * Mirrors the logic in netlify/functions/ebay-offer-thumb.ts but without
 * any HTTP-framework dependencies; returns plain TypeScript values.
 *
 * Usage:
 *   GET /api/ebay/offers/:id/thumb
 */

import { tokensStore } from '../../../../../src/lib/redis-store.js';
import { accessTokenFromRefresh, tokenHosts } from '../../../../../src/lib/_common.js';
import { userScopedKey } from '../../../../../src/lib/_auth.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Binary image ready to stream directly to the client. */
export type ThumbnailBinaryResult = {
  type: 'binary';
  buffer: Buffer;
  contentType: string;
  /** Cache-Control value to set on the response. */
  cacheControl: string;
};

/** The image is too large to inline; redirect client to the real URL. */
export type ThumbnailRedirectResult = {
  type: 'redirect';
  url: string;
};

/** No image was found for the offer; respond with 204. */
export type ThumbnailEmptyResult = {
  type: 'empty';
};

export type ThumbnailResult =
  | ThumbnailBinaryResult
  | ThumbnailRedirectResult
  | ThumbnailEmptyResult;

// ─── Error classes ────────────────────────────────────────────────────────────

export class OfferThumbAuthError extends Error {
  readonly statusCode = 401;
  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'OfferThumbAuthError';
  }
}

export class OfferThumbUpstreamError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'OfferThumbUpstreamError';
    this.statusCode = statusCode;
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Images larger than this will be returned as a redirect, not inline bytes. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4 MB

const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err: any) {
    clearTimeout(timer);
    if (err?.name === 'AbortError') throw new Error('Request timeout');
    throw err;
  }
}

function toDirectDropbox(u: string): string {
  try {
    const url = new URL(u);
    if (
      url.hostname === 'www.dropbox.com' ||
      url.hostname === 'dropbox.com'
    ) {
      url.hostname = 'dl.dropboxusercontent.com';
      const qp = new URLSearchParams(url.search);
      qp.delete('dl');
      const qs = qp.toString();
      url.search = qs ? `?${qs}` : '';
      return url.toString();
    }
    return u;
  } catch {
    return u;
  }
}

async function tryFetchImage(
  u: string,
): Promise<{ ok: boolean; resp: Response; type: string; buf?: Buffer }> {
  const resp = await fetchWithTimeout(u, { redirect: 'follow' }, 7000);
  const type = (resp.headers.get('content-type') || '').toLowerCase();
  const ok = resp.ok && type.startsWith('image/');
  const buf = ok ? Buffer.from(await resp.arrayBuffer()) : undefined;
  return { ok, resp, type, buf };
}

async function checkImageSize(u: string): Promise<number | null> {
  try {
    const headResp = await fetchWithTimeout(
      u,
      { method: 'HEAD', redirect: 'follow' },
      3000,
    );
    if (!headResp.ok) return null;
    const cl = headResp.headers.get('content-length');
    return cl ? parseInt(cl, 10) : null;
  } catch {
    return null;
  }
}

// ─── Main service ─────────────────────────────────────────────────────────────

/**
 * Resolve the thumbnail for a given eBay offer ID belonging to userId.
 *
 * @throws {OfferThumbAuthError}     — no eBay tokens in Redis
 * @throws {OfferThumbUpstreamError} — eBay API returned a non-200 status
 */
export async function getOfferThumbnail(
  userId: string,
  offerId: string,
): Promise<ThumbnailResult> {
  // 1. Resolve eBay access token from Redis
  const store = tokensStore();
  const saved = (await store.get(userScopedKey(userId, 'ebay.json'), {
    type: 'json',
  })) as any;
  const refresh = saved?.refresh_token as string | undefined;
  if (!refresh) {
    throw new OfferThumbAuthError('Connect eBay first');
  }
  const { access_token } = await accessTokenFromRefresh(refresh);

  const { apiHost } = tokenHosts(process.env.EBAY_ENV);
  const authHeaders = {
    Authorization: `Bearer ${access_token}`,
    Accept: 'application/json',
    'Accept-Language': 'en-US',
    'Content-Language': 'en-US',
    'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID,
  } as Record<string, string>;

  // 2. Fetch offer — prefer listing photos (already validated by eBay)
  const offerUrl = `${apiHost}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`;
  const offerRes = await fetchWithTimeout(offerUrl, { headers: authHeaders }, 5000);
  if (!offerRes.ok) {
    throw new OfferThumbUpstreamError(
      `offer fetch failed: ${offerRes.status}`,
      offerRes.status,
    );
  }
  const offer = await offerRes.json();

  const listingPhotos =
    offer?.listing?.photoUrls || offer?.listing?.imageUrls || [];
  const photoArr = Array.isArray(listingPhotos)
    ? listingPhotos
    : listingPhotos
    ? [listingPhotos]
    : [];

  let imageUrl: string | undefined = photoArr[0];

  // 3. Fallback: look in inventory item
  if (!imageUrl) {
    const skuRaw: string | undefined = offer?.sku;
    if (!skuRaw) return { type: 'empty' };

    const trySkus = [skuRaw];
    const san = skuRaw.replace(/[^A-Za-z0-9]/g, '').slice(0, 50);
    if (san && san !== skuRaw) trySkus.push(san);

    for (const s of trySkus) {
      try {
        const invUrl = `${apiHost}/sell/inventory/v1/inventory_item/${encodeURIComponent(s)}`;
        const ir = await fetchWithTimeout(invUrl, { headers: authHeaders }, 4000);
        if (!ir.ok) continue;
        const item = await ir.json();
        const imgs =
          item?.product?.imageUrls ||
          item?.product?.images ||
          item?.product?.image ||
          [];
        const arr = Array.isArray(imgs) ? imgs : imgs ? [imgs] : [];
        if (arr.length) {
          imageUrl = arr[0];
          break;
        }
      } catch {
        continue;
      }
    }
  }

  if (!imageUrl) return { type: 'empty' };

  // 4. Normalize Dropbox share links
  const direct = toDirectDropbox(imageUrl);

  // 5. Check size before downloading (honour HEAD Content-Length)
  const estimatedSize = await checkImageSize(direct);
  if (estimatedSize && estimatedSize > MAX_IMAGE_BYTES) {
    return { type: 'redirect', url: direct };
  }

  // 6. Download the image
  let upstream = await tryFetchImage(direct);
  if (!upstream.ok && direct !== imageUrl) {
    // Retry with original URL (normalized Dropbox may have failed)
    try {
      upstream = await tryFetchImage(imageUrl);
    } catch {
      return { type: 'empty' };
    }
  }
  if (!upstream.ok) return { type: 'empty' };

  const finalBuf = upstream.buf!;

  // 7. Guard the in-memory payload size too
  if (finalBuf.length > MAX_IMAGE_BYTES) {
    return { type: 'redirect', url: direct };
  }

  return {
    type: 'binary',
    buffer: finalBuf,
    contentType: upstream.type,
    cacheControl: 'public, max-age=300',
  };
}
