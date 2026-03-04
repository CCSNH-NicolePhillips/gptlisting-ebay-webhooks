/**
 * listing-plan.service.ts — Platform-agnostic service for generating a listing plan
 * from a Dropbox folder.
 *
 * Mirrors the business logic previously inlined in:
 *   netlify/functions/listing-plan.ts
 *
 * Reads a SKU's images from Dropbox (using a globally-stored OAuth refresh token),
 * computes eBay pricing, and returns a structured plan object.
 *
 * No HTTP framework dependencies.
 */

import { tokensStore } from '../lib/redis-store.js';
import { getFinalEbayPrice } from '../lib/pricing/legacy-compute.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ListingPlan {
  sku: string;
  folder: string;
  images: string[];
  priceImage?: string;
  pricing: {
    basePrice: number;
    ebayPrice: number;
    floorPrice: number;
    markdown: { everyDays: number; amount: number; stopAt: number };
    promotePercent: number;
  };
  draftPayloadTemplate: {
    sku: string;
    images: string[];
    price: number;
    qty: number;
    marketplaceId: string;
  };
}

// ---------------------------------------------------------------------------
// Dropbox helpers
// ---------------------------------------------------------------------------

async function dropboxAccessToken(refreshToken: string): Promise<string> {
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: process.env.DROPBOX_CLIENT_ID || '',
    client_secret: process.env.DROPBOX_CLIENT_SECRET || '',
  });

  const r = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });

  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok || !j.access_token) {
    throw new Error(`Dropbox token refresh failed: ${r.status} ${JSON.stringify(j)}`);
  }

  return j.access_token as string;
}

async function listDropboxFiles(
  accessToken: string,
  path: string,
): Promise<Array<{ name: string; path_lower: string }>> {
  const r = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, recursive: false }),
  });
  const j = (await r.json().catch(() => ({}))) as { entries?: unknown[] };
  if (!r.ok) throw new Error(`Dropbox list failed: ${r.status} ${JSON.stringify(j)}`);
  return (j.entries ?? []) as Array<{ name: string; path_lower: string }>;
}

async function ensureDropboxSharedLink(
  accessToken: string,
  filePath: string,
): Promise<string> {
  function normalizeUrl(u: string): string {
    try {
      const url = new URL(u);
      if (/\.dropbox\.com$/i.test(url.hostname)) url.hostname = 'dl.dropboxusercontent.com';
      url.searchParams.delete('dl');
      url.searchParams.set('raw', '1');
      return url.toString();
    } catch {
      return u
        .replace('www.dropbox.com', 'dl.dropboxusercontent.com')
        .replace('?dl=0', '?raw=1')
        .replace('&dl=0', '&raw=1');
    }
  }

  const createRes = await fetch(
    'https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath }),
    },
  );
  const created = (await createRes.json().catch(() => ({}))) as Record<string, unknown>;
  if (createRes.ok && created?.url) return normalizeUrl(created.url as string);

  const summary = String(created?.error_summary ?? '');
  if (summary.includes('shared_link_already_exists')) {
    const listRes = await fetch(
      'https://api.dropboxapi.com/2/sharing/list_shared_links',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, direct_only: true }),
      },
    );
    const listed = (await listRes.json().catch(() => ({}))) as { links?: Array<{ url: string }> };
    if (!listRes.ok || !listed.links?.length) {
      throw new Error(`Dropbox list_shared_links failed: ${listRes.status} ${JSON.stringify(listed)}`);
    }
    return normalizeUrl(listed.links[0].url);
  }

  throw new Error(`Dropbox create_shared_link failed: ${createRes.status} ${JSON.stringify(created)}`);
}

function proxyImageUrl(rawUrl: string, baseUrl?: string | null): string {
  const b = (process.env.APP_BASE_URL || baseUrl || '').toString();
  if (!b) return `/api/images/proxy?url=${encodeURIComponent(rawUrl)}`;
  return `${b}/api/images/proxy?url=${encodeURIComponent(rawUrl)}`;
}

// ---------------------------------------------------------------------------
// getListingPlan
// ---------------------------------------------------------------------------

export class DropboxNotConnectedError extends Error {
  readonly statusCode = 400;
  constructor() {
    super('Connect Dropbox first');
    this.name = 'DropboxNotConnectedError';
  }
}

export class SkuNotFoundError extends Error {
  readonly statusCode = 404;
  constructor(sku: string) {
    super(`No files found for SKU: ${sku}`);
    this.name = 'SkuNotFoundError';
  }
}

/**
 * Build a full listing plan for a SKU from Dropbox-hosted images.
 *
 * @param sku      SKU prefix to match files in the folder.
 * @param folder   Dropbox folder path (default '/EBAY').
 * @param baseUrl  Optional base URL for generating image-proxy URLs.
 * @throws {DropboxNotConnectedError} if no Dropbox token is stored.
 * @throws {SkuNotFoundError} if no files match the SKU in the folder.
 */
export async function getListingPlan(
  sku: string,
  folder: string = '/EBAY',
  baseUrl?: string | null,
): Promise<ListingPlan> {
  const store = tokensStore();
  const saved = (await store.get('dropbox.json', { type: 'json' })) as Record<string, unknown> | null;
  const refreshToken = saved?.refresh_token as string | undefined;
  if (!refreshToken) throw new DropboxNotConnectedError();

  const accessToken = await dropboxAccessToken(refreshToken);
  const entries = await listDropboxFiles(accessToken, folder);

  const files = entries.filter(e => typeof e.name === 'string' && e.name.startsWith(`${sku}_`));
  if (!files.length) throw new SkuNotFoundError(sku);

  const mainFile =
    files.find(f => f.name.toLowerCase().includes('_01')) ??
    files.find(f => /\.(jpe?g|png|webp)$/i.test(f.name));
  const galleryFiles = files
    .filter(f => f !== mainFile && /\.(jpe?g|png|webp|gif|bmp|tiff)$/i.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const priceFile = files.find(f => f.name.toLowerCase().includes('_price'));

  const toProxied = async (f: { name: string; path_lower: string }): Promise<string> => {
    const raw = await ensureDropboxSharedLink(accessToken, f.path_lower);
    return proxyImageUrl(raw, baseUrl);
  };

  const images = mainFile
    ? [await toProxied(mainFile), ...(await Promise.all(galleryFiles.map(toProxied)))]
    : [];

  const priceUrl = priceFile
    ? proxyImageUrl(await ensureDropboxSharedLink(accessToken, priceFile.path_lower), baseUrl)
    : undefined;

  // Extract base price from _price filename (e.g. "SKU_price_24.99.jpg" → 24.99)
  let basePrice = 0;
  if (priceFile) {
    const m = priceFile.name.match(/([0-9]+(?:\.[0-9]{1,2})?)/);
    if (m) basePrice = Number(m[1]);
  }

  const ebayPrice = getFinalEbayPrice(basePrice);
  const floorPrice = Math.round(ebayPrice * 0.8 * 100) / 100;

  return {
    sku,
    folder,
    images,
    priceImage: priceUrl,
    pricing: {
      basePrice,
      ebayPrice,
      floorPrice,
      markdown: { everyDays: 3, amount: 1, stopAt: floorPrice },
      promotePercent: 2,
    },
    draftPayloadTemplate: {
      sku,
      images,
      price: ebayPrice,
      qty: 1,
      marketplaceId: process.env.EBAY_MARKETPLACE_ID || 'EBAY_US',
    },
  };
}
