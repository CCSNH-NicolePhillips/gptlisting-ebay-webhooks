import type { Handler } from '@netlify/functions';
import { accessTokenFromRefresh } from '../../src/lib/_common.js';
import { tokensStore } from '../../src/lib/_blobs.js';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified, userScopedKey } from '../../src/lib/_auth.js';

export const handler: Handler = async (event) => {
  console.log('[ebay-update-active-item] Function invoked');
  
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    let bearer = getBearerToken(event);
    let sub = (await requireAuthVerified(event))?.sub || null;
    if (!sub) sub = getJwtSubUnverified(event);
    if (!bearer || !sub) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    const body = event.body ? JSON.parse(event.body) : {};
    const { itemId, sku, isInventoryListing, title, description, price, quantity, condition, aspects, images } = body;

    if (!itemId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing itemId' }) };
    }

    console.log('[ebay-update-active-item] Updating item:', itemId, 'Inventory listing:', isInventoryListing);

    // Load refresh token
    const store = tokensStore();
    const saved = (await store.get(userScopedKey(sub, 'ebay.json'), { type: 'json' })) as any;
    const refresh = saved?.refresh_token as string | undefined;
    if (!refresh) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Connect eBay first' }) };
    }

    const { access_token } = await accessTokenFromRefresh(refresh);

    // Use Inventory API for inventory listings, Trading API for traditional listings
    if (isInventoryListing) {
      // Use Inventory API - update inventory item AND offer
      console.log('[ebay-update-active-item] Using Inventory API for inventory listing');
      
      if (!sku) {
        return { statusCode: 400, body: JSON.stringify({ error: 'SKU required for inventory listings' }) };
      }

      const { apiHost } = require('../../src/lib/_common.js').tokenHosts(process.env.EBAY_ENV);
      const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';
      
      // STEP 1: Update Inventory Item (title, description, images, aspects)
      if (title || description || images || aspects) {
        console.log('[ebay-update-active-item] Updating inventory item:', sku);
        
        // First, get current inventory item to preserve fields we're not updating
        const getItemUrl = `${apiHost}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`;
        const getItemRes = await fetch(getItemUrl, {
          headers: {
            'Authorization': `Bearer ${access_token}`,
          },
        });

        if (!getItemRes.ok) {
          const errorText = await getItemRes.text();
          console.error('[ebay-update-active-item] Failed to get inventory item:', errorText);
          return { statusCode: getItemRes.status, body: JSON.stringify({ error: 'Failed to get inventory item', detail: errorText }) };
        }

        const currentItem = await getItemRes.json();
        
        // Build inventory item update payload - preserve all existing data
        const inventoryItemPayload: any = {
          ...currentItem, // Keep existing fields
          product: {
            ...(currentItem.product || {}), // Keep existing product data
          },
        };
        
        // Update product data - only override fields we're changing
        if (title) {
          inventoryItemPayload.product.title = title;
        }
        if (description) {
          inventoryItemPayload.product.description = description;
        }
        
        // Update images
        if (images && images.length > 0) {
          inventoryItemPayload.product.imageUrls = images;
        }
        
        // Update aspects - merge with existing aspects
        if (aspects && typeof aspects === 'object') {
          inventoryItemPayload.product.aspects = {
            ...(inventoryItemPayload.product.aspects || {}), // Keep existing aspects
            ...aspects, // Override with new aspects
          };
        }
        
        // Update condition (if provided)
        if (condition) {
          const conditionMap: Record<string, string> = {
            '1000': 'NEW',
            '1500': 'NEW_OTHER',
            '1750': 'NEW_WITH_DEFECTS',
            '2000': 'MANUFACTURER_REFURBISHED',
            '2500': 'SELLER_REFURBISHED',
            '3000': 'USED_EXCELLENT',
            '4000': 'USED_VERY_GOOD',
            '5000': 'USED_GOOD',
            '6000': 'USED_ACCEPTABLE',
            '7000': 'FOR_PARTS_OR_NOT_WORKING'
          };
          if (conditionMap[condition]) {
            inventoryItemPayload.condition = conditionMap[condition];
            inventoryItemPayload.conditionDescription = ''; // Optional
          }
        }
        
        // PUT update to inventory item
        const updateItemUrl = `${apiHost}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`;
        const updateItemRes = await fetch(updateItemUrl, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(inventoryItemPayload),
        });

        if (!updateItemRes.ok) {
          const errorText = await updateItemRes.text();
          console.error('[ebay-update-active-item] Failed to update inventory item:', errorText);
          return { statusCode: updateItemRes.status, body: JSON.stringify({ error: 'Failed to update inventory item', detail: errorText }) };
        }
        
        console.log('[ebay-update-active-item] Inventory item updated successfully');
      }

      // STEP 2: Update Offer (price, quantity, policies)
      if (price !== undefined || quantity !== undefined) {
        console.log('[ebay-update-active-item] Updating offer with price/quantity changes');
        
        // Get the current offer to get offerId
        // API doc: GET /sell/inventory/v1/offer?sku={sku}&marketplace_id={marketplace_id}
        const getOfferUrl = `${apiHost}/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${MARKETPLACE_ID}`;
        console.log('[ebay-update-active-item] Fetching offers from:', getOfferUrl);
        const getRes = await fetch(getOfferUrl, {
          headers: {
            'Authorization': `Bearer ${access_token}`,
          },
        });

        if (!getRes.ok) {
          const errorText = await getRes.text();
          console.error('[ebay-update-active-item] Failed to get offers:', errorText);
          return {
            statusCode: getRes.status,
            body: JSON.stringify({ error: 'Failed to get offer details', detail: errorText }),
          };
        }

        const offersData = await getRes.json();
        const offer = offersData.offers?.[0];
        
        if (!offer || !offer.offerId) {
          return { statusCode: 404, body: JSON.stringify({ error: 'No offer found for this SKU' }) };
        }

        // Build offer update payload - keep all existing offer fields
        const offerUpdatePayload: any = {
          ...offer,
        };
        
        // Update price
        if (price !== undefined) {
          offerUpdatePayload.pricingSummary = offerUpdatePayload.pricingSummary || {};
          offerUpdatePayload.pricingSummary.price = {
            value: String(price),
            currency: 'USD'
          };
        }
        
        // Update quantity
        if (quantity !== undefined) {
          offerUpdatePayload.availableQuantity = quantity;
        }

        // Update the offer
        const updateUrl = `${apiHost}/sell/inventory/v1/offer/${offer.offerId}`;
        console.log('[ebay-update-active-item] Updating offer:', offer.offerId);
        const updateRes = await fetch(updateUrl, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${access_token}`,
            'Content-Type': 'application/json',
            'Content-Language': 'en-US',
          },
          body: JSON.stringify(offerUpdatePayload),
        });

        if (!updateRes.ok) {
          const errorText = await updateRes.text();
          console.error('[ebay-update-active-item] Inventory API error:', errorText);
          return {
            statusCode: updateRes.status,
            body: JSON.stringify({ error: 'Failed to update offer', detail: errorText }),
          };
        }
        
        console.log('[ebay-update-active-item] Offer updated successfully');
      }
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true, itemId, method: 'inventory' }),
      };
    }

    // Use Trading API for traditional listings
    console.log('[ebay-update-active-item] Using Trading API for traditional listing');

    // Build ItemSpecifics XML
    let itemSpecificsXml = '';
    if (aspects && typeof aspects === 'object') {
      const nameValueLists = Object.entries(aspects)
        .filter(([_, values]) => values && (Array.isArray(values) ? values.length > 0 : values))
        .map(([name, values]) => {
          const valueArray = Array.isArray(values) ? values : [values];
          const valuesXml = valueArray.map(v => `<Value>${escapeXml(String(v))}</Value>`).join('');
          return `<NameValueList><Name>${escapeXml(name)}</Name>${valuesXml}</NameValueList>`;
        })
        .join('');
      
      if (nameValueLists) {
        itemSpecificsXml = `<ItemSpecifics>${nameValueLists}</ItemSpecifics>`;
      }
    }

    // Build PictureDetails XML
    let pictureDetailsXml = '';
    if (images && Array.isArray(images) && images.length > 0) {
      const pictureUrls = images.map(url => `<PictureURL>${escapeXml(url)}</PictureURL>`).join('');
      pictureDetailsXml = `<PictureDetails>${pictureUrls}</PictureDetails>`;
    }

    // Build ReviseItem XML
    const xmlRequest = `<?xml version="1.0" encoding="utf-8"?>
<ReviseItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${access_token}</eBayAuthToken>
  </RequesterCredentials>
  <Item>
    <ItemID>${itemId}</ItemID>
    ${title ? `<Title>${escapeXml(title)}</Title>` : ''}
    ${description ? `<Description><![CDATA[${description}]]></Description>` : ''}
    ${price ? `<StartPrice>${price}</StartPrice>` : ''}
    ${quantity !== undefined ? `<Quantity>${quantity}</Quantity>` : ''}
    ${condition ? `<ConditionID>${condition}</ConditionID>` : ''}
    ${itemSpecificsXml}
    ${pictureDetailsXml}
  </Item>
</ReviseItemRequest>`;

    console.log('[ebay-update-active-item] Sending ReviseItem request');

    const callUrl = 'https://api.ebay.com/ws/api.dll';
    
    const res = await fetch(callUrl, {
      method: 'POST',
      headers: {
        'X-EBAY-API-COMPATIBILITY-LEVEL': '1193',
        'X-EBAY-API-CALL-NAME': 'ReviseItem',
        'X-EBAY-API-SITEID': '0',
        'Content-Type': 'text/xml; charset=utf-8',
      },
      body: xmlRequest,
    });

    const xmlText = await res.text();
    
    // Check for errors
    if (!res.ok || xmlText.includes('<Ack>Failure</Ack>') || xmlText.includes('<Ack>PartialFailure</Ack>')) {
      console.error('[ebay-update-active-item] API error:', xmlText.substring(0, 500));
      
      // Extract error message
      const errorMatch = xmlText.match(/<LongMessage>([^<]+)<\/LongMessage>/);
      const errorMsg = errorMatch ? errorMatch[1] : 'Update failed';
      
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: errorMsg, detail: xmlText.substring(0, 500) }),
      };
    }

    console.log('[ebay-update-active-item] Item updated successfully');

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, itemId }),
    };
  } catch (e: any) {
    console.error('[ebay-update-active-item] Error:', e?.message || e);
    console.error('[ebay-update-active-item] Stack:', e?.stack);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to update item', detail: e?.message || String(e) }),
    };
  }
};

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
