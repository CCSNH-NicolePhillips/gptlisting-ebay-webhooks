import type { Handler } from '@netlify/functions';
import { accessTokenFromRefresh, tokenHosts } from '../../src/lib/_common.js';
import { tokensStore } from '../../src/lib/redis-store.js';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified, userScopedKey } from '../../src/lib/_auth.js';

/**
 * End (delete) an active eBay listing.
 * 
 * For Inventory API listings: Deletes the offer and optionally the inventory item
 * For Trading API listings: Calls EndFixedPriceItem
 * 
 * POST body:
 * - itemId: The eBay ItemID (required)
 * - sku: The SKU (required for Inventory API listings)
 * - offerId: The offer ID (required for Inventory API listings) 
 * - isInventoryListing: true if created via Inventory API
 * - deleteInventoryItem: true to also delete the inventory item (default: true)
 * - reason: Ending reason (optional, default: "NotAvailable")
 *           Valid values: NotAvailable, Incorrect, LostOrBroken, OtherListingError, SellToHighBidder
 */
export const handler: Handler = async (event) => {
  console.log('[ebay-end-listing] Function invoked');
  
  if (event.httpMethod !== 'POST') {
    return { 
      statusCode: 405, 
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }, 
      body: JSON.stringify({ error: 'Method not allowed' }) 
    };
  }

  try {
    const bearer = getBearerToken(event);
    let sub = (await requireAuthVerified(event))?.sub || null;
    if (!sub) sub = getJwtSubUnverified(event);
    if (!bearer || !sub) {
      return { 
        statusCode: 401, 
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }, 
        body: JSON.stringify({ error: 'Unauthorized' }) 
      };
    }

    const body = event.body ? JSON.parse(event.body) : {};
    const { itemId, sku, offerId, isInventoryListing, deleteInventoryItem = true, reason = 'NotAvailable' } = body;

    if (!itemId) {
      return { 
        statusCode: 400, 
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }, 
        body: JSON.stringify({ error: 'Missing itemId' }) 
      };
    }

    console.log('[ebay-end-listing] Ending item:', itemId, 'Inventory listing:', isInventoryListing);

    // Load refresh token
    const store = tokensStore();
    const saved = (await store.get(userScopedKey(sub, 'ebay.json'), { type: 'json' })) as any;
    const refresh = saved?.refresh_token as string | undefined;
    if (!refresh) {
      return { 
        statusCode: 400, 
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }, 
        body: JSON.stringify({ error: 'Connect eBay first' }) 
      };
    }

    const { access_token } = await accessTokenFromRefresh(refresh);
    const { apiHost } = tokenHosts(process.env.EBAY_ENV);

    // Use Inventory API for inventory listings, Trading API for traditional listings
    if (isInventoryListing && offerId) {
      console.log('[ebay-end-listing] Using Inventory API to delete offer:', offerId);
      
      // Step 1: Delete the offer (unpublishes the listing)
      const deleteOfferUrl = `${apiHost}/sell/inventory/v1/offer/${offerId}`;
      const deleteOfferRes = await fetch(deleteOfferUrl, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${access_token}`,
          'Content-Language': 'en-US',
        },
      });

      if (!deleteOfferRes.ok && deleteOfferRes.status !== 404) {
        const errorText = await deleteOfferRes.text();
        console.error('[ebay-end-listing] Failed to delete offer:', errorText);
        return { 
          statusCode: deleteOfferRes.status, 
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }, 
          body: JSON.stringify({ error: 'Failed to delete offer', detail: errorText }) 
        };
      }

      console.log('[ebay-end-listing] Offer deleted successfully');

      // Step 2: Optionally delete the inventory item
      if (deleteInventoryItem && sku) {
        console.log('[ebay-end-listing] Also deleting inventory item:', sku);
        
        const deleteItemUrl = `${apiHost}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`;
        const deleteItemRes = await fetch(deleteItemUrl, {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${access_token}`,
            'Content-Language': 'en-US',
          },
        });

        if (!deleteItemRes.ok && deleteItemRes.status !== 404) {
          const errorText = await deleteItemRes.text();
          console.error('[ebay-end-listing] Failed to delete inventory item:', errorText);
          // Don't fail the whole operation, offer is already deleted
          console.warn('[ebay-end-listing] Offer deleted but inventory item deletion failed');
        } else {
          console.log('[ebay-end-listing] Inventory item deleted successfully');
        }
      }

      return {
        statusCode: 200,
        headers: { 
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store, must-revalidate'
        },
        body: JSON.stringify({ ok: true, itemId, method: 'inventory-api' }),
      };

    } else {
      // Use Trading API EndFixedPriceItem
      console.log('[ebay-end-listing] Using Trading API EndFixedPriceItem');

      // Validate reason
      const validReasons = ['NotAvailable', 'Incorrect', 'LostOrBroken', 'OtherListingError', 'SellToHighBidder'];
      const endingReason = validReasons.includes(reason) ? reason : 'NotAvailable';

      const xmlRequest = `<?xml version="1.0" encoding="utf-8"?>
<EndFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${access_token}</eBayAuthToken>
  </RequesterCredentials>
  <ItemID>${itemId}</ItemID>
  <EndingReason>${endingReason}</EndingReason>
</EndFixedPriceItemRequest>`;

      const callUrl = 'https://api.ebay.com/ws/api.dll';
      
      const res = await fetch(callUrl, {
        method: 'POST',
        headers: {
          'X-EBAY-API-COMPATIBILITY-LEVEL': '1193',
          'X-EBAY-API-CALL-NAME': 'EndFixedPriceItem',
          'X-EBAY-API-SITEID': '0',
          'Content-Type': 'text/xml; charset=utf-8',
        },
        body: xmlRequest,
      });

      const xmlText = await res.text();
      
      // Check for errors
      if (!res.ok || xmlText.includes('<Ack>Failure</Ack>')) {
        console.error('[ebay-end-listing] API error:', xmlText.substring(0, 500));
        
        // Extract error message
        const errorMatch = xmlText.match(/<LongMessage>([^<]+)<\/LongMessage>/);
        const shortErrorMatch = xmlText.match(/<ShortMessage>([^<]+)<\/ShortMessage>/);
        const errorMsg = errorMatch?.[1] || shortErrorMatch?.[1] || 'Failed to end listing';
        
        // Check for specific error codes
        const errorCodeMatch = xmlText.match(/<ErrorCode>([^<]+)<\/ErrorCode>/);
        const errorCode = errorCodeMatch?.[1];
        
        // 1047 = Item is not active (already ended)
        if (errorCode === '1047') {
          console.log('[ebay-end-listing] Item already ended, treating as success');
          return {
            statusCode: 200,
            headers: { 
              'Content-Type': 'application/json',
              'Cache-Control': 'no-cache, no-store, must-revalidate'
            },
            body: JSON.stringify({ ok: true, itemId, method: 'trading-api', note: 'Item was already ended' }),
          };
        }
        
        return {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
          body: JSON.stringify({ error: errorMsg, errorCode, detail: xmlText.substring(0, 500) }),
        };
      }

      // Check for warnings (PartialFailure with warnings)
      if (xmlText.includes('<Ack>Warning</Ack>') || xmlText.includes('<Ack>PartialFailure</Ack>')) {
        console.warn('[ebay-end-listing] Ended with warnings:', xmlText.substring(0, 300));
      }

      console.log('[ebay-end-listing] Item ended successfully via Trading API');

      return {
        statusCode: 200,
        headers: { 
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store, must-revalidate'
        },
        body: JSON.stringify({ ok: true, itemId, method: 'trading-api' }),
      };
    }
  } catch (e: any) {
    console.error('[ebay-end-listing] Error:', e?.message || e);
    console.error('[ebay-end-listing] Stack:', e?.stack);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
      body: JSON.stringify({ error: 'Failed to end listing', detail: e?.message || String(e) }),
    };
  }
};
