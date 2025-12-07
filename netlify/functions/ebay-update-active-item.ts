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
    const { itemId, title, description, price, quantity, condition, aspects, images } = body;

    if (!itemId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing itemId' }) };
    }

    console.log('[ebay-update-active-item] Updating item:', itemId);

    // Load refresh token
    const store = tokensStore();
    const saved = (await store.get(userScopedKey(sub, 'ebay.json'), { type: 'json' })) as any;
    const refresh = saved?.refresh_token as string | undefined;
    if (!refresh) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Connect eBay first' }) };
    }

    const { access_token } = await accessTokenFromRefresh(refresh);

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
