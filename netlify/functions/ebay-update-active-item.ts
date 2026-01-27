import type { Handler } from '@netlify/functions';
import { accessTokenFromRefresh, tokenHosts } from '../../src/lib/_common.js';
import { tokensStore } from '../../src/lib/_blobs.js';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified, userScopedKey } from '../../src/lib/_auth.js';

export const handler: Handler = async (event) => {
  console.log('[ebay-update-active-item] Function invoked');
  
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    let bearer = getBearerToken(event);
    let sub = (await requireAuthVerified(event))?.sub || null;
    if (!sub) sub = getJwtSubUnverified(event);
    if (!bearer || !sub) {
      return { statusCode: 401, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    const body = event.body ? JSON.parse(event.body) : {};
    const { itemId, sku, isInventoryListing, title, description, price, quantity, condition, aspects, images, bestOffer } = body;

    if (!itemId) {
      return { statusCode: 400, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }, body: JSON.stringify({ error: 'Missing itemId' }) };
    }

    console.log('[ebay-update-active-item] Updating item:', itemId, 'Inventory listing:', isInventoryListing);
    console.log('[ebay-update-active-item] Received data - title:', title ? 'YES' : 'NO', 'description:', description ? 'YES' : 'NO', 'price:', price, 'quantity:', quantity);

    // If SKU is placeholder/invalid, treat as Trading API listing regardless of isInventoryListing flag
    let actuallyInventoryListing = isInventoryListing;
    if (isInventoryListing && sku && (sku.includes('SKU123456789') || sku === '' || /^sku\d+$/i.test(sku))) {
      console.warn('[ebay-update-active-item] Placeholder SKU detected, forcing Trading API path:', sku);
      actuallyInventoryListing = false;
    }

    // Load refresh token
    const store = tokensStore();
    const saved = (await store.get(userScopedKey(sub, 'ebay.json'), { type: 'json' })) as any;
    const refresh = saved?.refresh_token as string | undefined;
    if (!refresh) {
      return { statusCode: 400, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }, body: JSON.stringify({ error: 'Connect eBay first' }) };
    }

    const { access_token } = await accessTokenFromRefresh(refresh);
    
    // TEMPORARY DEBUG: Log token for local testing
    console.log('[DEBUG] eBay access token for testing:', access_token);
    console.log('[DEBUG] Token preview:', access_token.substring(0, 50) + '...');

    // Use Inventory API for inventory listings, Trading API for traditional listings
    if (actuallyInventoryListing) {
      // Use Inventory API - update inventory item AND offer
      console.log('[ebay-update-active-item] Using Inventory API for inventory listing');
      
      if (!sku) {
        console.error('[ebay-update-active-item] CRITICAL: SKU missing for inventory listing. ItemId:', itemId);
        return { statusCode: 400, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }, body: JSON.stringify({ error: 'SKU required for inventory listings. This listing may have been created without a SKU or the SKU was not retrieved from eBay. ItemId: ' + itemId }) };
      }
      
      if (sku.includes('SKU123456789') || sku === '') {
        console.error('[ebay-update-active-item] CRITICAL: Invalid/placeholder SKU detected:', sku, 'for itemId:', itemId);
        return { statusCode: 400, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }, body: JSON.stringify({ error: 'Invalid SKU detected. This listing cannot be updated through the Inventory API.' }) };
      }

      const { apiHost } = tokenHosts(process.env.EBAY_ENV);
      const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';
      
      // STEP 1: Update Inventory Item (title, description, images, aspects)
      if (title || description || images || aspects || condition) {
        console.log('[ebay-update-active-item] Updating inventory item:', sku);
        
        // First, GET the existing inventory item to preserve all fields
        const getItemUrl = `${apiHost}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`;
        const getItemRes = await fetch(getItemUrl, {
          headers: {
            'Authorization': `Bearer ${access_token}`,
            'Accept-Language': 'en-US',
            'Content-Language': 'en-US',
          },
        });

        if (!getItemRes.ok) {
          const errorText = await getItemRes.text();
          console.error('[ebay-update-active-item] Failed to get inventory item:', errorText);
          return { statusCode: getItemRes.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }, body: JSON.stringify({ error: 'Failed to get inventory item', detail: errorText }) };
        }

        const existingItem = await getItemRes.json();
        console.log('[ebay-update-active-item] Retrieved existing inventory item');
        console.log('[ebay-update-active-item] Package weight data:', JSON.stringify(existingItem.packageWeightAndSize));
        
        // Merge our updates into the existing item
        const inventoryItemPayload: any = {
          ...existingItem,
        };
        
        // Fix missing or invalid package weight
        if (!inventoryItemPayload.packageWeightAndSize) {
          inventoryItemPayload.packageWeightAndSize = {};
        }
        if (!inventoryItemPayload.packageWeightAndSize.weight) {
          inventoryItemPayload.packageWeightAndSize.weight = {
            value: 1,
            unit: 'POUND'
          };
          console.log('[ebay-update-active-item] Added default package weight (1 POUND)');
        } else if (!inventoryItemPayload.packageWeightAndSize.weight.value || inventoryItemPayload.packageWeightAndSize.weight.value <= 0) {
          inventoryItemPayload.packageWeightAndSize.weight.value = 1;
          console.log('[ebay-update-active-item] Fixed invalid package weight value');
        }
        
        console.log('[ebay-update-active-item] Final package weight:', JSON.stringify(inventoryItemPayload.packageWeightAndSize.weight));
        
        // Update product data - merge with existing
        if (!inventoryItemPayload.product) {
          inventoryItemPayload.product = {};
        }
        
        if (title) {
          console.log('[ebay-update-active-item] Setting title to:', title.substring(0, 50) + '...');
          inventoryItemPayload.product.title = title;
        }
        if (description) {
          console.log('[ebay-update-active-item] Setting description to:', description.substring(0, 100) + '...');
          inventoryItemPayload.product.description = description;
        } else {
          console.log('[ebay-update-active-item] WARNING: No description provided in update request');
        }
        if (images && images.length > 0) {
          console.log('[ebay-update-active-item] Setting', images.length, 'images');
          inventoryItemPayload.product.imageUrls = images;
        }
        if (aspects && typeof aspects === 'object') {
          console.log('[ebay-update-active-item] Setting aspects:', Object.keys(aspects).length, 'keys');
          inventoryItemPayload.product.aspects = aspects;
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
        
        // PUT update to inventory item with full merged data
        console.log('[ebay-update-active-item] About to PUT inventory item. Payload keys:', Object.keys(inventoryItemPayload));
        console.log('[ebay-update-active-item] Product keys:', Object.keys(inventoryItemPayload.product || {}));
        console.log('[ebay-update-active-item] Description length:', inventoryItemPayload.product?.description?.length || 0);
        console.log('[ebay-update-active-item] FULL PAYLOAD:', JSON.stringify(inventoryItemPayload, null, 2).substring(0, 1000));
        
        const updateItemUrl = `${apiHost}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`;
        const updateItemRes = await fetch(updateItemUrl, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${access_token}`,
            'Content-Type': 'application/json',
            'Accept-Language': 'en-US',
            'Content-Language': 'en-US',
          },
          body: JSON.stringify(inventoryItemPayload),
        });

        const responseText = await updateItemRes.text();
        console.log('[ebay-update-active-item] eBay response status:', updateItemRes.status);
        console.log('[ebay-update-active-item] eBay response body:', responseText.substring(0, 500));

        if (!updateItemRes.ok) {
          console.error('[ebay-update-active-item] Failed to update inventory item:', responseText);
          return { statusCode: updateItemRes.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }, body: JSON.stringify({ error: 'Failed to update inventory item', detail: responseText }) };
        }
        
        console.log('[ebay-update-active-item] Inventory item updated successfully');
      }

      // STEP 2: Republish the offer to push inventory_item changes to the live listing
      // Even if we only updated title/description/images, we need to republish the offer
      console.log('[ebay-update-active-item] Getting offer to republish changes...');
      
      const getOfferUrl = `${apiHost}/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${MARKETPLACE_ID}`;
      const getOfferRes = await fetch(getOfferUrl, {
        headers: {
          'Authorization': `Bearer ${access_token}`,
          'Accept-Language': 'en-US',
          'Content-Language': 'en-US',
        },
      });

      if (!getOfferRes.ok) {
        const errorText = await getOfferRes.text();
        console.error('[ebay-update-active-item] Failed to get offers:', errorText);
        return {
          statusCode: getOfferRes.status,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
          body: JSON.stringify({ error: 'Failed to get offer details', detail: errorText }),
        };
      }

      const offersData = await getOfferRes.json();
      const offer = offersData.offers?.[0];
      
      if (!offer || !offer.offerId) {
        console.log('[ebay-update-active-item] No offer found - changes saved to inventory but not published');
        return { 
          statusCode: 200, 
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
          body: JSON.stringify({ ok: true, itemId, method: 'inventory', warning: 'Updated inventory item but no offer found to republish' })
        };
      }

      console.log('[ebay-update-active-item] Found offer:', offer.offerId);

      // STEP 3: ALWAYS update the offer to sync changes to live listing
      // Per eBay docs: "For a published offer, a successful updateOffer call will not only update 
      // the offer object, but will update the associated active eBay listing in real time."
      console.log('[ebay-update-active-item] Updating offer to sync inventory_item changes to live listing...');
      
      // Build offer update payload - keep all existing offer fields
      // Remove read-only fields that shouldn't be in PUT request
      const { listing, offerId: _, ...offerData } = offer;
      const offerUpdatePayload: any = {
        ...offerData,
      };
      
      // CRITICAL: Update listingDescription in the offer if description changed
      // The listingDescription field is what actually appears on the eBay listing!
      // (product.description in inventory_item is just the product catalog description)
      if (description) {
        console.log('[ebay-update-active-item] Updating listingDescription in offer to:', description.substring(0, 100) + '...');
        offerUpdatePayload.listingDescription = description;
      }
      
      // Update price if provided
      if (price !== undefined) {
        console.log('[ebay-update-active-item] Updating price to:', price);
        offerUpdatePayload.pricingSummary = offerUpdatePayload.pricingSummary || {};
        offerUpdatePayload.pricingSummary.price = {
          value: String(price),
          currency: 'USD'
        };
      }
      
      // Update quantity if provided
      if (quantity !== undefined) {
        console.log('[ebay-update-active-item] Updating quantity to:', quantity);
        offerUpdatePayload.availableQuantity = quantity;
      }

      // Update Best Offer settings if provided
      if (bestOffer !== undefined) {
        const existingPolicies = offerUpdatePayload.listingPolicies || {};
        if (bestOffer?.enabled) {
          const offerPrice = price !== undefined ? parseFloat(price) : parseFloat(offerUpdatePayload.pricingSummary?.price?.value || '0');
          const bestOfferTerms: Record<string, unknown> = {
            bestOfferEnabled: true,
          };
          
          // Calculate auto-decline price
          if (bestOffer.autoDeclinePercent) {
            const autoDeclinePrice = (offerPrice * bestOffer.autoDeclinePercent / 100);
            bestOfferTerms.autoDeclinePrice = {
              currency: 'USD',
              value: autoDeclinePrice.toFixed(2),
            };
          }
          
          // Calculate auto-accept price
          if (bestOffer.autoAcceptPercent) {
            const autoAcceptPrice = (offerPrice * bestOffer.autoAcceptPercent / 100);
            bestOfferTerms.autoAcceptPrice = {
              currency: 'USD',
              value: autoAcceptPrice.toFixed(2),
            };
          }
          
          offerUpdatePayload.listingPolicies = {
            ...existingPolicies,
            bestOfferTerms,
          };
          console.log('[ebay-update-active-item] Best Offer enabled:', bestOfferTerms);
        } else {
          // Explicitly disable Best Offer
          offerUpdatePayload.listingPolicies = {
            ...existingPolicies,
            bestOfferTerms: { bestOfferEnabled: false },
          };
          console.log('[ebay-update-active-item] Best Offer disabled');
        }
      }

      // Update the offer - this triggers the live listing update
      const updateUrl = `${apiHost}/sell/inventory/v1/offer/${offer.offerId}`;
      console.log('[ebay-update-active-item] PUT offer:', offer.offerId);
      console.log('[ebay-update-active-item] Offer payload keys:', Object.keys(offerUpdatePayload));
      console.log('[ebay-update-active-item] SKU in offer:', offerUpdatePayload.sku);
      
      const updateRes = await fetch(updateUrl, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${access_token}`,
          'Content-Type': 'application/json',
          'Accept-Language': 'en-US',
          'Content-Language': 'en-US',
        },
        body: JSON.stringify(offerUpdatePayload),
      });

      if (!updateRes.ok) {
        const errorText = await updateRes.text();
        console.error('[ebay-update-active-item] Failed to update offer:', errorText);
        return {
          statusCode: updateRes.status,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
          body: JSON.stringify({ error: 'Failed to update offer', detail: errorText }),
        };
      }
      
      console.log('[ebay-update-active-item] Offer updated successfully');
      
      // STEP 4: Explicitly publish the offer to sync all changes to the live eBay listing
      // Despite eBay docs saying updateOffer syncs to live listings, in practice it doesn't
      // We must explicitly call publishOffer to push inventory_item and offer changes live
      console.log('[ebay-update-active-item] Publishing offer to sync changes to live listing...');
      
      const publishUrl = `${apiHost}/sell/inventory/v1/offer/${offer.offerId}/publish`;
      const publishRes = await fetch(publishUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${access_token}`,
          'Content-Type': 'application/json',
          'Accept-Language': 'en-US',
          'Content-Language': 'en-US',
        },
        body: JSON.stringify({}),
      });

      if (!publishRes.ok) {
        const errorText = await publishRes.text();
        console.error('[ebay-update-active-item] Failed to publish offer:', errorText);
        return {
          statusCode: publishRes.status,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
          body: JSON.stringify({ error: 'Failed to publish changes to live listing', detail: errorText }),
        };
      }
      
      console.log('[ebay-update-active-item] Offer published successfully');
      console.log('[ebay-update-active-item] === UPDATE COMPLETE ===');
      console.log('[ebay-update-active-item] All changes synced to live eBay listing');
      
      return {
        statusCode: 200,
        headers: { 
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store, must-revalidate'
        },
        body: JSON.stringify({ ok: true, itemId, method: 'inventory', published: true }),
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
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
        body: JSON.stringify({ error: errorMsg, detail: xmlText.substring(0, 500) }),
      };
    }

    console.log('[ebay-update-active-item] Item updated successfully');

    console.log('[ebay-update-active-item] === UPDATE COMPLETE (Trading API) ===');
    return {
      statusCode: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      },
      body: JSON.stringify({ ok: true, itemId }),
    };
  } catch (e: any) {
    console.error('[ebay-update-active-item] Error:', e?.message || e);
    console.error('[ebay-update-active-item] Stack:', e?.stack);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
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
