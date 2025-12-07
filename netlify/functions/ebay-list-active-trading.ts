import type { Handler } from '@netlify/functions';
import { accessTokenFromRefresh, tokenHosts } from '../../src/lib/_common.js';
import { tokensStore } from '../../src/lib/_blobs.js';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified, userScopedKey } from '../../src/lib/_auth.js';

interface ActiveOffer {
  offerId: string;
  sku: string;
  title?: string;
  price?: { value: string; currency: string };
  availableQuantity?: number;
  listingId?: string;
  listingStatus?: string;
  marketplaceId?: string;
  condition?: number;
  lastModifiedDate?: string;
  autoPromote?: boolean;
  autoPromoteAdRate?: number;
  imageUrl?: string;
  startTime?: string;
  quantitySold?: number;
  watchCount?: number;
  hitCount?: number;
}

export const handler: Handler = async (event) => {
  console.log('[ebay-list-active-trading] Function invoked - using Trading API');
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

    console.log('[ebay-list-active-trading] User ID:', sub, 'Dev bypass:', wantBypass);

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
      console.log('[ebay-list-active-trading] No eBay refresh token found');
      return { statusCode: 400, body: JSON.stringify({ error: 'Connect eBay first' }) };
    }

    console.log('[ebay-list-active-trading] Getting access token...');
    const { access_token } = await accessTokenFromRefresh(refresh);
    const { apiHost } = tokenHosts(process.env.EBAY_ENV);

    // Use GetMyeBaySelling Trading API - gets ALL active listings regardless of creation method
    async function listActiveOffers(): Promise<ActiveOffer[]> {
      console.log('[ebay-list-active-trading] Using GetMyeBaySelling Trading API');
      
      const results: ActiveOffer[] = [];
      let pageNumber = 1;
      const entriesPerPage = 200;
      
      while (true) {
        // Build Trading API XML request for GetMyeBaySelling
        const xmlRequest = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${access_token}</eBayAuthToken>
  </RequesterCredentials>
  <ActiveList>
    <Include>true</Include>
    <Pagination>
      <EntriesPerPage>${entriesPerPage}</EntriesPerPage>
      <PageNumber>${pageNumber}</PageNumber>
    </Pagination>
  </ActiveList>
  <DetailLevel>ReturnAll</DetailLevel>
</GetMyeBaySellingRequest>`;

        const callUrl = 'https://api.ebay.com/ws/api.dll';
        
        console.log(`[ebay-list-active-trading] Fetching page ${pageNumber}`);
        
        const res = await fetch(callUrl, {
          method: 'POST',
          headers: {
            'X-EBAY-API-COMPATIBILITY-LEVEL': '1193',
            'X-EBAY-API-CALL-NAME': 'GetMyeBaySelling',
            'X-EBAY-API-SITEID': '0', // US site
            'Content-Type': 'text/xml; charset=utf-8',
          },
          body: xmlRequest,
        });

        if (!res.ok) {
          const text = await res.text();
          console.error(`[ebay-list-active-trading] Trading API error:`, res.status, text);
          throw new Error(`Trading API failed: ${res.status}`);
        }

        const xmlText = await res.text();
        console.log(`[ebay-list-active-trading] Got XML response, length: ${xmlText.length}`);
        
        // Log first 2000 chars of first page to see structure
        if (pageNumber === 1) {
          console.log('[ebay-list-active-trading] Sample XML:', xmlText.substring(0, 2000));
        }
        
        // Check for API errors in response
        if (xmlText.includes('<Ack>Failure</Ack>') || xmlText.includes('<Ack>PartialFailure</Ack>')) {
          console.error('[ebay-list-active-trading] API returned error:', xmlText.substring(0, 500));
          throw new Error('eBay API returned error');
        }
        
        // Parse items from XML (basic regex parsing)
        const hasMoreItems = xmlText.includes('<HasMoreItems>true</HasMoreItems>');
        
        // Extract ItemArray items
        const itemMatches = xmlText.matchAll(/<Item>(.*?)<\/Item>/gs);
        
        let itemCount = 0;
        for (const match of itemMatches) {
          const itemXml = match[1];
          
          // Extract fields using regex
          const itemIdMatch = itemXml.match(/<ItemID>([^<]+)<\/ItemID>/);
          const skuMatch = itemXml.match(/<SKU>([^<]+)<\/SKU>/);
          const titleMatch = itemXml.match(/<Title>([^<]+)<\/Title>/);
          const priceMatch = itemXml.match(/<CurrentPrice[^>]*>([^<]+)<\/CurrentPrice>/);
          const currencyMatch = itemXml.match(/<CurrentPrice currencyID="([^"]+)"/);
          const quantityMatch = itemXml.match(/<Quantity>([^<]+)<\/Quantity>/);
          const quantityAvailMatch = itemXml.match(/<QuantityAvailable>([^<]+)<\/QuantityAvailable>/);
          const quantitySoldMatch = itemXml.match(/<QuantitySold>([^<]+)<\/QuantitySold>/);
          
          // Try multiple patterns for picture URL
          let pictureUrl = null;
          const galleryMatch = itemXml.match(/<GalleryURL>([^<]+)<\/GalleryURL>/);
          const pictureMatch = itemXml.match(/<PictureURL>([^<]+)<\/PictureURL>/);
          const pictureDetailsMatch = itemXml.match(/<PictureDetails>.*?<GalleryURL>([^<]+)<\/GalleryURL>/s);
          
          pictureUrl = galleryMatch?.[1] || pictureMatch?.[1] || pictureDetailsMatch?.[1];
          
          const startTimeMatch = itemXml.match(/<StartTime>([^<]+)<\/StartTime>/);
          const watchCountMatch = itemXml.match(/<WatchCount>([^<]+)<\/WatchCount>/);
          const hitCountMatch = itemXml.match(/<HitCount>([^<]+)<\/HitCount>/);
          
          // Check listing status - skip if ended, deleted, or not active
          const listingStatusMatch = itemXml.match(/<ListingStatus>([^<]+)<\/ListingStatus>/);
          const listingStatus = listingStatusMatch ? listingStatusMatch[1] : '';
          
          // Skip if not active or quantity available is 0
          if (listingStatus && listingStatus !== 'Active') {
            console.log(`[ebay-list-active-trading] Skipping item ${itemIdMatch?.[1]} with status: ${listingStatus}`);
            continue;
          }
          
          const quantityAvailable = quantityAvailMatch ? parseInt(quantityAvailMatch[1]) : (quantityMatch ? parseInt(quantityMatch[1]) : 0);
          if (quantityAvailable <= 0) {
            console.log(`[ebay-list-active-trading] Skipping item ${itemIdMatch?.[1]} with 0 quantity available`);
            continue;
          }
          
          if (itemIdMatch) {
            const itemId = itemIdMatch[1];
            const listing = {
              offerId: itemId,
              listingId: itemId,
              sku: skuMatch ? skuMatch[1] : itemId, // Use itemId as fallback SKU
              title: titleMatch ? titleMatch[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : '',
              price: priceMatch ? {
                value: priceMatch[1],
                currency: currencyMatch ? currencyMatch[1] : 'USD'
              } : undefined,
              availableQuantity: quantityAvailable,
              quantitySold: quantitySoldMatch ? parseInt(quantitySoldMatch[1]) : 0,
              listingStatus: 'ACTIVE',
              marketplaceId: 'EBAY_US',
              imageUrl: pictureUrl || undefined,
              startTime: startTimeMatch ? startTimeMatch[1] : undefined,
              watchCount: watchCountMatch ? parseInt(watchCountMatch[1]) : 0,
              hitCount: hitCountMatch ? parseInt(hitCountMatch[1]) : 0,
            };
            
            results.push(listing);
            
            // Log first item to see what we got
            if (pageNumber === 1 && itemCount === 0) {
              console.log('[ebay-list-active-trading] First item sample:', JSON.stringify(listing));
            }
            
            itemCount++;
          }
        }
        
        console.log(`[ebay-list-active-trading] Page ${pageNumber}: Found ${itemCount} items, Total so far: ${results.length}`);
        
        if (!hasMoreItems || itemCount === 0) break;
        if (results.length >= 1000) {
          console.log('[ebay-list-active-trading] Reached 1000 item limit, stopping');
          break; // Safety limit
        }
        pageNumber++;
      }
      
      return results;
    }

    const activeOffers = await listActiveOffers();
    console.log('[ebay-list-active-trading] SUCCESS - Found', activeOffers.length, 'total active listings');
    if (activeOffers.length > 0) {
      console.log('[ebay-list-active-trading] Sample:', JSON.stringify(activeOffers[0]).substring(0, 300));
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, count: activeOffers.length, offers: activeOffers }),
    };
  } catch (e: any) {
    console.error('[ebay-list-active-trading] Error:', e?.message || e);
    console.error('[ebay-list-active-trading] Stack:', e?.stack);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to list active offers', detail: e?.message || String(e) }),
    };
  }
};
