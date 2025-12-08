import type { Handler } from '@netlify/functions';
import { accessTokenFromRefresh, tokenHosts } from '../../src/lib/_common.js';
import { tokensStore } from '../../src/lib/_blobs.js';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified, userScopedKey } from '../../src/lib/_auth.js';

export const handler: Handler = async (event) => {
  console.log('[ebay-get-active-item] Function invoked - VERSION: 2024-12-07-v2');
  try {
    const devBypassEnabled = process.env.DEV_BYPASS_AUTH_FOR_LIST_ACTIVE === 'true';
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

    const itemId = event.queryStringParameters?.itemId;
    if (!itemId) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Missing itemId parameter' }),
      };
    }

    console.log('[ebay-get-active-item] Item ID:', itemId, 'User:', sub);

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
      console.log('[ebay-get-active-item] No eBay refresh token found');
      return { statusCode: 400, body: JSON.stringify({ error: 'Connect eBay first' }) };
    }

    console.log('[ebay-get-active-item] Getting access token...');
    const { access_token } = await accessTokenFromRefresh(refresh);

    // Use Trading API GetItem to get full item details
    const xmlRequest = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${access_token}</eBayAuthToken>
  </RequesterCredentials>
  <ItemID>${itemId}</ItemID>
  <DetailLevel>ReturnAll</DetailLevel>
  <IncludeItemSpecifics>true</IncludeItemSpecifics>
</GetItemRequest>`;

    const callUrl = 'https://api.ebay.com/ws/api.dll';
    
    console.log(`[ebay-get-active-item] Fetching item ${itemId}`);
    
    const res = await fetch(callUrl, {
      method: 'POST',
      headers: {
        'X-EBAY-API-COMPATIBILITY-LEVEL': '1193',
        'X-EBAY-API-CALL-NAME': 'GetItem',
        'X-EBAY-API-SITEID': '0',
        'Content-Type': 'text/xml; charset=utf-8',
      },
      body: xmlRequest,
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[ebay-get-active-item] Trading API error:`, res.status, text);
      throw new Error(`Trading API failed: ${res.status}`);
    }

    const xmlText = await res.text();
    console.log(`[ebay-get-active-item] Got XML response, length: ${xmlText.length}`);
    
    // Check for API errors
    if (xmlText.includes('<Ack>Failure</Ack>') || xmlText.includes('<Ack>PartialFailure</Ack>')) {
      console.error('[ebay-get-active-item] API returned error:', xmlText.substring(0, 500));
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'eBay API error', detail: xmlText.substring(0, 500) }),
      };
    }

    // Parse item details from XML
    const titleMatch = xmlText.match(/<Title>([^<]+)<\/Title>/);
    // Try CDATA first, then regular content
    let descMatch = xmlText.match(/<Description><!\[CDATA\[(.*?)\]\]><\/Description>/s);
    if (!descMatch) {
      descMatch = xmlText.match(/<Description>(.*?)<\/Description>/s);
    }
    const skuMatch = xmlText.match(/<SKU>([^<]+)<\/SKU>/);
    
    // Check if this is an Inventory API listing
    const sellerInventoryIdMatch = xmlText.match(/<SellerInventoryID>([^<]+)<\/SellerInventoryID>/);
    const isInventoryListing = !!sellerInventoryIdMatch;
    
    console.log('[ebay-get-active-item] SKU found:', skuMatch?.[1] || 'NONE');
    console.log('[ebay-get-active-item] SellerInventoryID found:', sellerInventoryIdMatch?.[1] || 'NONE');
    console.log('[ebay-get-active-item] isInventoryListing:', isInventoryListing);
    
    // If we have a SKU but no SellerInventoryID, try to detect inventory listing by attempting Inventory API lookup
    let finalIsInventoryListing = isInventoryListing;
    if (!isInventoryListing && skuMatch?.[1]) {
      try {
        console.log('[ebay-get-active-item] No SellerInventoryID, attempting Inventory API lookup with SKU:', skuMatch[1]);
        const invApiUrl = `https://api.ebay.com/sell/inventory/v1/inventory_item/${encodeURIComponent(skuMatch[1])}`;
        const invRes = await fetch(invApiUrl, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${access_token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
        });
        
        if (invRes.ok) {
          console.log('[ebay-get-active-item] Inventory API lookup succeeded - this IS an inventory listing');
          finalIsInventoryListing = true;
        } else {
          console.log('[ebay-get-active-item] Inventory API lookup failed with status:', invRes.status, '- likely NOT an inventory listing');
        }
      } catch (invErr) {
        console.log('[ebay-get-active-item] Inventory API lookup error:', invErr);
      }
    }
    
    console.log('[ebay-get-active-item] Final isInventoryListing:', finalIsInventoryListing);
    
    const priceMatch = xmlText.match(/<CurrentPrice[^>]*>([^<]+)<\/CurrentPrice>/);
    const currencyMatch = xmlText.match(/<CurrentPrice currencyID="([^"]+)"/);
    const quantityMatch = xmlText.match(/<Quantity>([^<]+)<\/Quantity>/);
    const conditionIdMatch = xmlText.match(/<ConditionID>([^<]+)<\/ConditionID>/);
    const conditionNameMatch = xmlText.match(/<ConditionDisplayName>([^<]+)<\/ConditionDisplayName>/);
    
    // Extract images
    const images: string[] = [];
    const pictureMatches = xmlText.matchAll(/<PictureURL>([^<]+)<\/PictureURL>/g);
    for (const match of pictureMatches) {
      images.push(match[1]);
    }

    // Extract item specifics (aspects)
    const aspects: Record<string, string[]> = {};
    const nameValMatches = xmlText.matchAll(/<NameValueList>(.*?)<\/NameValueList>/gs);
    for (const match of nameValMatches) {
      const nameMatch = match[1].match(/<Name>([^<]+)<\/Name>/);
      const valueMatches = match[1].matchAll(/<Value>([^<]+)<\/Value>/g);
      
      if (nameMatch) {
        const name = nameMatch[1];
        const values: string[] = [];
        for (const valMatch of valueMatches) {
          values.push(valMatch[1]);
        }
        if (values.length > 0) {
          aspects[name] = values;
        }
      }
    }

    const item = {
      itemId,
      sku: skuMatch ? skuMatch[1] : '',
      isInventoryListing: finalIsInventoryListing,
      title: titleMatch ? titleMatch[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : '',
      description: descMatch ? descMatch[1] : '',
      price: priceMatch ? priceMatch[1] : '',
      currency: currencyMatch ? currencyMatch[1] : 'USD',
      quantity: quantityMatch ? parseInt(quantityMatch[1]) : 0,
      condition: conditionIdMatch ? conditionIdMatch[1] : '1000',
      conditionName: conditionNameMatch ? conditionNameMatch[1] : 'New',
      images,
      aspects,
    };

    console.log('[ebay-get-active-item] Successfully parsed item');

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, item }),
    };
  } catch (e: any) {
    console.error('[ebay-get-active-item] Error:', e?.message || e);
    console.error('[ebay-get-active-item] Stack:', e?.stack);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to get item', detail: e?.message || String(e) }),
    };
  }
};
