import type { Handler } from '@netlify/functions';
import { requireAuth, json } from '../../src/lib/_auth.js';
import { putInventoryItem } from '../../src/lib/ebay-sell.js';
import { accessTokenFromRefresh, tokenHosts } from '../../src/lib/_common.js';
import { tokensStore } from '../../src/lib/_blobs.js';

export const handler: Handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return json({ ok: true }, 200);
  }
  
  if (event.httpMethod !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const user = await requireAuth(event);
  if (!user) {
    return json({ error: 'Unauthorized' }, 401);
  }

  let body: any = {};
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const offerId = typeof body.offerId === 'string' ? body.offerId.trim() : '';
  if (!offerId) {
    return json({ error: 'offerId required' }, 400);
  }

  try {
    // Get eBay access token
    const store = tokensStore();
    const saved = (await store.get('ebay.json', { type: 'json' })) as any;
    const refresh = saved?.refresh_token as string | undefined;
    if (!refresh) {
      return json({ error: 'No eBay credentials' }, 500);
    }

    const { access_token } = await accessTokenFromRefresh(refresh);
    const ENV = process.env.EBAY_ENV || 'PROD';
    const { apiHost } = tokenHosts(ENV);

    // Fetch the current offer
    const offerUrl = `${apiHost}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`;
    const offerRes = await fetch(offerUrl, {
      headers: {
        'Authorization': `Bearer ${access_token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!offerRes.ok) {
      const detail = await offerRes.text().catch(() => '');
      return json({ error: 'Failed to fetch offer', detail }, 400);
    }

    const offer = await offerRes.json();
    const sku = offer.sku;
    if (!sku) {
      return json({ error: 'Offer has no SKU' }, 400);
    }

    // Fetch current inventory item
    const inventoryUrl = `${apiHost}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`;
    const inventoryRes = await fetch(inventoryUrl, {
      headers: {
        'Authorization': `Bearer ${access_token}`,
      },
    });

    if (!inventoryRes.ok) {
      const detail = await inventoryRes.text().catch(() => '');
      return json({ error: 'Failed to fetch inventory', detail }, 400);
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
      return json({ ok: true, message: 'No aspects needed to be added', added: [] }, 200);
    }

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

    return json({
      ok: true,
      message: `Added ${added.length} missing aspects`,
      added,
      sku,
      offerId,
    }, 200);

  } catch (e: any) {
    console.error('Fix aspects error:', e);
    return json({
      error: 'Failed to fix aspects',
      detail: e?.message || String(e),
    }, 500);
  }
};
