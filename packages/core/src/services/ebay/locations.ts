/**
 * packages/core/src/services/ebay/locations.ts
 *
 * eBay inventory location operations.
 *   listLocations   — fetch all merchant locations via Inventory API
 *   getUserLocation — read user's saved default location from Redis
 *   setUserLocation — persist user's default location to Redis
 */

import { getEbayClient, EbayNotConnectedError } from '../../../../../src/lib/ebay-client.js';
import { tokensStore, preferencesStore } from '../../../../../src/lib/redis-store.js';
import { userScopedKey } from '../../../../../src/lib/_auth.js';

export { EbayNotConnectedError };

export type LocationInfo = {
  key: string;
  merchantLocationKey: string;
  isDefault: boolean;
  name?: string;
  location?: { address?: Record<string, string> };
  locationTypes?: string[];
  merchantLocationStatus?: string;
};

export class EbayApiError extends Error {
  readonly statusCode: number;
  readonly body: string;
  constructor(message: string, statusCode: number, body: string) {
    super(message);
    this.name = 'EbayApiError';
    this.statusCode = statusCode;
    this.body = body;
  }
}

/**
 * Fetch all inventory locations for the authenticated user via eBay Inventory API.
 */
export async function listLocations(userId: string): Promise<LocationInfo[]> {
  const client = await getEbayClient(userId);
  const MARKETPLACE_ID =
    process.env.DEFAULT_MARKETPLACE_ID || process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';

  const url = `${client.apiHost}/sell/inventory/v1/location?limit=200`;
  const r = await fetch(url, {
    headers: {
      ...client.headers,
      'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID,
    },
  });

  const text = await r.text();
  if (!r.ok) throw new EbayApiError(`list-locations ${r.status}`, r.status, text);

  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new EbayApiError('list-locations: invalid JSON response', 502, text);
  }

  const list: any[] =
    Array.isArray(data?.locations)
      ? data.locations
      : Array.isArray(data?.locationResponses)
        ? data.locationResponses
        : [];

  return list
    .map((loc) => {
      const key = typeof loc?.merchantLocationKey === 'string' ? loc.merchantLocationKey : '';
      return {
        key,
        merchantLocationKey: key,
        isDefault:
          Array.isArray(loc?.locationTypes) &&
          (loc.locationTypes.includes('WAREHOUSE') || loc.locationTypes.includes('DEFAULT')),
        name: typeof loc?.name === 'string' ? loc.name : undefined,
        location: loc?.location && typeof loc.location === 'object' ? loc.location : undefined,
        locationTypes: Array.isArray(loc?.locationTypes) ? loc.locationTypes : undefined,
        merchantLocationStatus:
          typeof loc?.merchantLocationStatus === 'string' ? loc.merchantLocationStatus : undefined,
      };
    })
    .filter((l) => l.key.length > 0);
}

/**
 * Read the user's saved default inventory location key from Redis.
 * Returns an empty string if not set. Falls back to the legacy
 * expiring token store for values saved before this preference moved
 * to a non-expiring store.
 */
export async function getUserLocation(userId: string): Promise<string> {
  const key = userScopedKey(userId, 'ebay-location.json');
  const saved = (await preferencesStore().get(key, { type: 'json' })) as any
    ?? (await tokensStore().get(key, { type: 'json' })) as any;
  return typeof saved?.merchantLocationKey === 'string' ? saved.merchantLocationKey.trim() : '';
}

/**
 * Persist the user's default inventory location key. Stored without expiry —
 * unlike OAuth tokens, this is a user setting with no security reason to lapse.
 */
export async function setUserLocation(userId: string, merchantLocationKey: string): Promise<void> {
  if (!merchantLocationKey.trim()) {
    throw Object.assign(new Error('merchantLocationKey is required'), { statusCode: 400 });
  }
  await preferencesStore().setJSON(userScopedKey(userId, 'ebay-location.json'), {
    merchantLocationKey: merchantLocationKey.trim(),
    updatedAt: Date.now(),
  });
}
