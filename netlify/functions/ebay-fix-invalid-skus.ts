import type { Handler } from '@netlify/functions';
import { accessTokenFromRefresh, tokenHosts } from '../../src/lib/_common.js';
import { tokensStore } from '../../src/lib/_blobs.js';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified, userScopedKey } from '../../src/lib/_auth.js';

export const handler: Handler = async (event) => {
  console.log('[ebay-fix-invalid-skus] Function invoked');
  
  try {
    const devBypassEnabled = process.env.DEV_BYPASS_AUTH_FOR_FIX_SKUS === 'true';
    const wantBypass =
      devBypassEnabled &&
      ((event.queryStringParameters?.dev || '').toString() === '1' ||
        (event.headers['x-dev-bypass'] || event.headers['X-Dev-Bypass'] || '').toString() === '1');

    let bearer = getBearerToken(event);
    let sub = (await requireAuthVerified(event))?.sub || null;
    if (!sub) sub = getJwtSubUnverified(event);

    if (wantBypass) {
      sub = event.queryStringParameters?.userId || process.env.DEV_USER_ID || 'dev-user';
      bearer = bearer || 'dev-bypass';
    }

    console.log('[ebay-fix-invalid-skus] User ID:', sub, 'Dev bypass:', wantBypass);

    if (!bearer || !sub) {
      return {
        statusCode: 401,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Unauthorized' }),
      };
    }

    // Load refresh token
    const store = tokensStore();
    const saved = (await store.get(userScopedKey(sub, 'ebay.json'), { type: 'json' })) as any;
    const refresh = saved?.refresh_token as string | undefined;
    if (!refresh) {
      console.log('[ebay-fix-invalid-skus] No eBay refresh token found');
      return { statusCode: 400, body: JSON.stringify({ error: 'Connect eBay first' }) };
    }

    console.log('[ebay-fix-invalid-skus] Getting access token...');
    const { access_token } = await accessTokenFromRefresh(refresh);
    const { apiHost } = tokenHosts(process.env.EBAY_ENV);
    const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';

    // Validate SKU format
    function isValidSKU(sku: string): boolean {
      if (!sku || typeof sku !== 'string') return false;
      if (sku.length > 50) return false;
      return /^[a-zA-Z0-9]+$/.test(sku);
    }

    // Generate a valid SKU from an invalid one
    function fixSKU(invalidSku: string): string {
      // Remove all non-alphanumeric characters
      let fixed = invalidSku.replace(/[^a-zA-Z0-9]/g, '');
      // If empty after cleanup, generate a random one
      if (!fixed) {
        fixed = 'FIXED' + Date.now() + Math.random().toString(36).substring(2, 8);
      }
      // Truncate to 50 chars
      if (fixed.length > 50) {
        fixed = fixed.substring(0, 50);
      }
      return fixed;
    }

    // Fetch all inventory items
    async function fetchAllInventoryItems() {
      const items: any[] = [];
      let offset = 0;
      const limit = 100;

      console.log('[ebay-fix-invalid-skus] Fetching inventory items...');

      while (true) {
        const params = new URLSearchParams({ 
          limit: String(limit), 
          offset: String(offset)
        });
        const url = `${apiHost}/sell/inventory/v1/inventory_item?${params.toString()}`;
        
        const res = await fetch(url, {
          headers: {
            Authorization: `Bearer ${access_token}`,
            'Content-Type': 'application/json',
            'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID,
          },
        });

        if (!res.ok) {
          const text = await res.text();
          console.error(`[ebay-fix-invalid-skus] API error at offset ${offset}:`, res.status, text);
          break;
        }

        const data = await res.json();
        const inventoryItems = Array.isArray(data.inventoryItems) ? data.inventoryItems : [];
        
        console.log(`[ebay-fix-invalid-skus] Offset ${offset}: Found ${inventoryItems.length} items`);
        items.push(...inventoryItems);

        if (!data.next || inventoryItems.length < limit) break;
        offset += limit;
      }

      return items;
    }

    // Get offer for a SKU
    async function getOfferForSKU(sku: string) {
      const params = new URLSearchParams({ sku, limit: '1' });
      const url = `${apiHost}/sell/inventory/v1/offer?${params.toString()}`;
      
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${access_token}`,
          'Content-Type': 'application/json',
          'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID,
        },
      });

      if (!res.ok) return null;
      const data = await res.json();
      return data.offers?.[0] || null;
    }

    // Create new inventory item with valid SKU
    async function createInventoryItem(newSku: string, itemData: any) {
      const url = `${apiHost}/sell/inventory/v1/inventory_item/${encodeURIComponent(newSku)}`;
      
      const res = await fetch(url, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${access_token}`,
          'Content-Type': 'application/json',
          'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID,
        },
        body: JSON.stringify(itemData),
      });

      return res.status === 200 || res.status === 201 || res.status === 204;
    }

    // Update offer to use new SKU
    async function updateOfferSKU(offerId: string, newSku: string, offerData: any) {
      const url = `${apiHost}/sell/inventory/v1/offer/${offerId}`;
      
      // Update the offer data with new SKU
      const updatedOffer = { ...offerData, sku: newSku };
      delete updatedOffer.offerId;
      delete updatedOffer.status;
      delete updatedOffer.listing;
      
      const res = await fetch(url, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${access_token}`,
          'Content-Type': 'application/json',
          'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID,
        },
        body: JSON.stringify(updatedOffer),
      });

      return res.status === 200 || res.status === 204;
    }

    // Delete old inventory item
    async function deleteInventoryItem(sku: string) {
      const url = `${apiHost}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`;
      
      const res = await fetch(url, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${access_token}`,
          'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID,
        },
      });

      return res.status === 204 || res.status === 200;
    }

    // Main logic
    const allItems = await fetchAllInventoryItems();
    console.log(`[ebay-fix-invalid-skus] Total inventory items: ${allItems.length}`);

    const invalidItems = allItems.filter(item => !isValidSKU(item.sku));
    console.log(`[ebay-fix-invalid-skus] Found ${invalidItems.length} items with invalid SKUs`);

    if (invalidItems.length === 0) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true, message: 'No invalid SKUs found', fixed: 0 }),
      };
    }

    const results = [];
    let fixed = 0;
    let failed = 0;

    for (const item of invalidItems) {
      const oldSku = item.sku;
      const newSku = fixSKU(oldSku);
      
      console.log(`[ebay-fix-invalid-skus] Fixing "${oldSku}" -> "${newSku}"`);

      try {
        // Get the offer for this SKU
        const offer = await getOfferForSKU(oldSku);
        
        // Create new inventory item with valid SKU
        const itemPayload = { ...item };
        delete itemPayload.sku;
        
        const created = await createInventoryItem(newSku, itemPayload);
        if (!created) {
          console.error(`[ebay-fix-invalid-skus] Failed to create inventory for ${newSku}`);
          failed++;
          results.push({ oldSku, newSku, success: false, reason: 'Failed to create inventory' });
          continue;
        }

        // If there's an offer, update it to use the new SKU
        if (offer) {
          const updated = await updateOfferSKU(offer.offerId, newSku, offer);
          if (!updated) {
            console.error(`[ebay-fix-invalid-skus] Failed to update offer for ${newSku}`);
            failed++;
            results.push({ oldSku, newSku, success: false, reason: 'Failed to update offer' });
            continue;
          }
        }

        // Delete old inventory item
        await deleteInventoryItem(oldSku);

        fixed++;
        results.push({ oldSku, newSku, success: true, hadOffer: !!offer });
        console.log(`[ebay-fix-invalid-skus] ✓ Fixed ${oldSku} (${fixed}/${invalidItems.length})`);

      } catch (err: any) {
        console.error(`[ebay-fix-invalid-skus] Error fixing ${oldSku}:`, err.message);
        failed++;
        results.push({ oldSku, newSku, success: false, reason: err.message });
      }
    }

    console.log(`[ebay-fix-invalid-skus] Complete! Fixed: ${fixed}, Failed: ${failed}`);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: true,
        totalInvalid: invalidItems.length,
        fixed,
        failed,
        results,
      }),
    };

  } catch (e: any) {
    console.error('[ebay-fix-invalid-skus] Error:', e?.message || e);
    console.error('[ebay-fix-invalid-skus] Stack:', e?.stack);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to fix invalid SKUs', detail: e?.message || String(e) }),
    };
  }
};
