import type { Handler } from '@netlify/functions';
import { putInventoryItem } from '../../src/lib/ebay-sell.js';
import { accessTokenFromRefresh, tokenHosts } from '../../src/lib/_common.js';
import { tokensStore } from '../../src/lib/_blobs.js';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified, userScopedKey } from '../../src/lib/_auth.js';
import { getOrigin, isAuthorized, isOriginAllowed, jsonResponse } from '../../src/lib/http.js';
import { maybeRequireUserAuth } from '../../src/lib/auth-user.js';
import type { UserAuth } from '../../src/lib/auth-user.js';

const METHODS = 'POST, OPTIONS';

export const handler: Handler = async (event) => {
  const headers = event.headers as Record<string, string | undefined>;
  const originHdr = getOrigin(headers);
  
  if (event.httpMethod === 'OPTIONS') {
    return jsonResponse(200, { ok: true }, originHdr, METHODS);
  }
  
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' }, originHdr, METHODS);
  }

  // Check authorization
  const fetchSite = (headers['sec-fetch-site'] || headers['Sec-Fetch-Site'] || '')
    .toString()
    .toLowerCase();
  const originAllowed = isOriginAllowed(originHdr);
  if (!originAllowed && fetchSite !== 'same-origin') {
    return jsonResponse(403, { error: 'Forbidden' }, originHdr, METHODS);
  }

  let userAuth: UserAuth | null = null;
  if (!isAuthorized(headers)) {
    try {
      userAuth = await maybeRequireUserAuth(headers.authorization || headers.Authorization);
    } catch (err) {
      console.warn('[ebay-fix-draft-aspects] user auth failed', err);
      return jsonResponse(401, { error: 'Unauthorized' }, originHdr, METHODS);
    }
    if (!userAuth) {
      return jsonResponse(401, { error: 'Unauthorized' }, originHdr, METHODS);
    }
  }

  let body: any = {};
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON' }, originHdr, METHODS);
  }

  const offerId = typeof body.offerId === 'string' ? body.offerId.trim() : '';
  if (!offerId) {
    return jsonResponse(400, { error: 'offerId required' }, originHdr, METHODS);
  }

  console.log('[ebay-fix-draft-aspects] Processing offerId:', offerId, 'userId:', userAuth?.userId || 'global');

  try {
    // Get eBay refresh token using user-scoped storage
    const bearer = getBearerToken(event);
    let sub = (await requireAuthVerified(event))?.sub || null;
    if (!sub) sub = getJwtSubUnverified(event);
    
    let refreshToken = (process.env.EBAY_REFRESH_TOKEN || '').trim();
    let refreshSource: 'env' | 'user' | null = refreshToken ? 'env' : null;

    if (!refreshToken && sub) {
      try {
        const store = tokensStore();
        const saved = (await store.get(userScopedKey(sub, 'ebay.json'), { type: 'json' })) as any;
        const candidate = typeof saved?.refresh_token === 'string' ? saved.refresh_token.trim() : '';
        if (candidate) {
          refreshToken = candidate;
          refreshSource = 'user';
        }
      } catch (err) {
        console.warn('[ebay-fix-draft-aspects] failed to load user-scoped refresh token', err);
      }
    }

    if (!refreshToken) {
      return jsonResponse(500, { error: 'No eBay credentials - connect eBay first' }, originHdr, METHODS);
    }

    console.log('[ebay-fix-draft-aspects] Using refresh token from:', refreshSource);

    const { access_token } = await accessTokenFromRefresh(refreshToken);
    const ENV = process.env.EBAY_ENV || 'PROD';
    const { apiHost } = tokenHosts(ENV);

    // Fetch the current offer
    console.log('[ebay-fix-draft-aspects] Fetching offer:', offerId);
    const offerUrl = `${apiHost}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`;
    const offerRes = await fetch(offerUrl, {
      headers: {
        'Authorization': `Bearer ${access_token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!offerRes.ok) {
      const detail = await offerRes.text().catch(() => '');
      console.error('[ebay-fix-draft-aspects] Failed to fetch offer:', offerRes.status, detail);
      return jsonResponse(400, { error: 'Failed to fetch offer', status: offerRes.status, detail }, originHdr, METHODS);
    }

    const offer = await offerRes.json();
    const sku = offer.sku;
    if (!sku) {
      console.error('[ebay-fix-draft-aspects] Offer has no SKU:', offer);
      return jsonResponse(400, { error: 'Offer has no SKU', offer }, originHdr, METHODS);
    }

    console.log('[ebay-fix-draft-aspects] Fetching inventory for SKU:', sku);
    // Fetch current inventory item
    const inventoryUrl = `${apiHost}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`;
    const inventoryRes = await fetch(inventoryUrl, {
      headers: {
        'Authorization': `Bearer ${access_token}`,
      },
    });

    if (!inventoryRes.ok) {
      const detail = await inventoryRes.text().catch(() => '');
      console.error('[ebay-fix-draft-aspects] Failed to fetch inventory:', inventoryRes.status, detail);
      return jsonResponse(400, { error: 'Failed to fetch inventory', status: inventoryRes.status, detail }, originHdr, METHODS);
    }

    const inventory = await inventoryRes.json();
    const aspects = inventory.product?.aspects || {};
    const added: string[] = [];

    // Add missing common required aspects
    const defaults: Record<string, string> = {
      'Brand': 'Unbranded',
      'Type': 'Other',
      'Model': 'Does Not Apply',
      'MPN': 'Does Not Apply',
      'UPC': 'Does Not Apply',
    };

    for (const [name, defaultValue] of Object.entries(defaults)) {
      if (!aspects[name] || aspects[name].length === 0 || !aspects[name][0]?.trim()) {
        aspects[name] = [defaultValue];
        added.push(name);
      }
    }

    if (added.length === 0) {
      console.log('[ebay-fix-draft-aspects] No aspects needed for SKU:', sku);
      return jsonResponse(200, { ok: true, message: 'No aspects needed to be added', added: [] }, originHdr, METHODS);
    }

    console.log('[ebay-fix-draft-aspects] Adding aspects:', added, 'to SKU:', sku);
    // Update inventory with fixed aspects
    await putInventoryItem(
      access_token,
      apiHost,
      sku,
      {
        condition: inventory.condition,
        product: {
          title: inventory.product.title,
          description: inventory.product.description,
          imageUrls: inventory.product.imageUrls || [],
          aspects,
        },
      },
      inventory.availability?.shipToLocationAvailability?.quantity || 1,
      offer.marketplaceId
    );

    console.log('[ebay-fix-draft-aspects] Successfully added aspects:', added);
    return jsonResponse(200, {
      ok: true,
      message: `Added ${added.length} missing aspects`,
      added,
      sku,
      offerId,
    }, originHdr, METHODS);

  } catch (e: any) {
    console.error('[ebay-fix-draft-aspects] Error:', e);
    return jsonResponse(500, {
      error: 'Failed to fix aspects',
      detail: e?.message || String(e),
    }, originHdr, METHODS);
  }
};
