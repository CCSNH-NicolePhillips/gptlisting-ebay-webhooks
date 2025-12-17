import type { Handler } from '@netlify/functions';
import { accessTokenFromRefresh, tokenHosts } from '../../src/lib/_common.js';
import { tokensStore } from '../../src/lib/_blobs.js';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified, userScopedKey } from '../../src/lib/_auth.js';

interface ActiveOffer {
  itemId?: string;
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
    // Request token with Marketing API scope for promotion data
    const tokenScopes = [
      'https://api.ebay.com/oauth/api_scope',
      'https://api.ebay.com/oauth/api_scope/sell.account',
      'https://api.ebay.com/oauth/api_scope/sell.inventory',
      'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
      'https://api.ebay.com/oauth/api_scope/sell.marketing',
    ];
    console.log('[ebay-list-active-trading] Requesting token with scopes:', tokenScopes.join(', '));
    const { access_token } = await accessTokenFromRefresh(refresh, tokenScopes);
    console.log('[ebay-list-active-trading] Got access token, length:', access_token?.length);
    
    // Decode token to see what scopes we actually got (JWT format: header.payload.signature)
    try {
      const tokenParts = access_token.split('.');
      if (tokenParts.length === 3) {
        const payload = JSON.parse(Buffer.from(tokenParts[1], 'base64').toString());
        console.log('[ebay-list-active-trading] Token scopes:', payload.scope || payload.scopes || 'No scope field found');
      }
    } catch (decodeErr) {
      console.log('[ebay-list-active-trading] Could not decode token (might not be JWT format)');
    }
    
    const { apiHost } = tokenHosts(process.env.EBAY_ENV);

    // First, get the list of unsold items to filter them out
    async function getUnsoldItemIds(): Promise<Set<string>> {
      console.log('[ebay-list-active-trading] Fetching unsold items list...');
      const unsoldIds = new Set<string>();
      let pageNumber = 1;
      const entriesPerPage = 200;
      
      while (true) {
        const xmlRequest = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${access_token}</eBayAuthToken>
  </RequesterCredentials>
  <UnsoldList>
    <Include>true</Include>
    <Pagination>
      <EntriesPerPage>${entriesPerPage}</EntriesPerPage>
      <PageNumber>${pageNumber}</PageNumber>
    </Pagination>
  </UnsoldList>
  <DetailLevel>ReturnAll</DetailLevel>
</GetMyeBaySellingRequest>`;

        const res = await fetch('https://api.ebay.com/ws/api.dll', {
          method: 'POST',
          headers: {
            'X-EBAY-API-COMPATIBILITY-LEVEL': '1193',
            'X-EBAY-API-CALL-NAME': 'GetMyeBaySelling',
            'X-EBAY-API-SITEID': '0',
            'Content-Type': 'text/xml; charset=utf-8',
          },
          body: xmlRequest,
        });

        const xmlText = await res.text();
        
        // Extract ItemIDs from unsold list
        const itemIdMatches = xmlText.matchAll(/<ItemID>([^<]+)<\/ItemID>/g);
        for (const match of itemIdMatches) {
          unsoldIds.add(match[1]);
        }
        
        // Check if there are more pages
        const hasMoreItems = xmlText.includes('<HasMoreItems>true</HasMoreItems>');
        if (!hasMoreItems) break;
        pageNumber++;
      }
      
      console.log(`[ebay-list-active-trading] Found ${unsoldIds.size} unsold items to exclude`);
      return unsoldIds;
    }

    // Use GetMyeBaySelling Trading API - gets ALL active listings regardless of creation method
    async function listActiveOffers(): Promise<ActiveOffer[]> {
      console.log('[ebay-list-active-trading] Using GetMyeBaySelling Trading API');
      
      // Get unsold items to filter out
      const unsoldItemIds = await getUnsoldItemIds();
      
      const results: ActiveOffer[] = [];
      let pageNumber = 1;
      const entriesPerPage = 200;
      
      while (true) {
        // Build Trading API XML request for GetMyeBaySelling
        // Request selling status details to check for admin ended items and end reasons
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
    <IncludeNotes>false</IncludeNotes>
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
          
          // Log first item's full XML to see structure
          if (pageNumber === 1 && itemCount === 0) {
            console.log('[ebay-list-active-trading] First item full XML (first 3000 chars):', itemXml.substring(0, 3000));
          }
          
          // Extract fields using regex
          const itemIdMatch = itemXml.match(/<ItemID>([^<]+)<\/ItemID>/);
          
          // Check if item has ended (has EndTime tag) or time left is zero
          const endTimeMatch = itemXml.match(/<EndTime>([^<]+)<\/EndTime>/);
          const timeLeftMatch = itemXml.match(/<TimeLeft>([^<]+)<\/TimeLeft>/);
          
          // Skip if item has ended
          if (endTimeMatch) {
            console.log(`[ebay-list-active-trading] Skipping item ${itemIdMatch?.[1]} - has EndTime (ended listing)`);
            continue;
          }
          
          // Skip if time left is zero
          if (timeLeftMatch && timeLeftMatch[1] === 'PT0S') {
            console.log(`[ebay-list-active-trading] Skipping item ${itemIdMatch?.[1]} - TimeLeft is PT0S (ended)`);
            continue;
          }
          
          // Skip if this item is in the unsold list
          if (itemIdMatch && unsoldItemIds.has(itemIdMatch[1])) {
            console.log(`[ebay-list-active-trading] Skipping item ${itemIdMatch[1]} - in unsold list`);
            continue;
          }
          
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
          
          // Check if this is an Inventory API listing (has SellerInventoryID)
          const sellerInventoryIdMatch = itemXml.match(/<SellerInventoryID>([^<]+)<\/SellerInventoryID>/);
          const isInventoryListing = !!sellerInventoryIdMatch;
          
          // Check listing status - skip if ended, deleted, or not active
          // Try multiple patterns since eBay XML structure can vary
          let listingStatus = '';
          
          // Pattern 1: Direct ListingStatus tag
          const directStatusMatch = itemXml.match(/<ListingStatus>([^<]+)<\/ListingStatus>/);
          if (directStatusMatch) {
            listingStatus = directStatusMatch[1];
          }
          
          // Pattern 2: ListingStatus inside SellingStatus
          const nestedStatusMatch = itemXml.match(/<SellingStatus>.*?<ListingStatus>([^<]+)<\/ListingStatus>.*?<\/SellingStatus>/s);
          if (nestedStatusMatch) {
            listingStatus = nestedStatusMatch[1];
          }
          
          const sellingStatus = listingStatus;
          
          // Check if administratively ended by eBay (policy violation, etc.)
          // AdminEnded is inside SellingStatus
          const adminEndedMatch = itemXml.match(/<SellingStatus>.*?<AdminEnded>([^<]+)<\/AdminEnded>.*?<\/SellingStatus>/s) ||
                                   itemXml.match(/<AdminEnded>([^<]+)<\/AdminEnded>/);
          const isAdminEnded = adminEndedMatch && adminEndedMatch[1].toLowerCase() === 'true';
          
          // Check for end reason (e.g., LostOrBroken, NotAvailable, Incorrect, Sold, etc.)
          // EndReason is inside ListingDetails
          const endReasonMatch = itemXml.match(/<ListingDetails>.*?<EndReason>([^<]+)<\/EndReason>.*?<\/ListingDetails>/s) ||
                                 itemXml.match(/<EndReason>([^<]+)<\/EndReason>/);
          const endReason = endReasonMatch ? endReasonMatch[1] : null;
          
          // Log status fields for first few items to see what we're getting
          if (pageNumber === 1 && itemCount < 3) {
            console.log(`[ebay-list-active-trading] Item ${itemIdMatch?.[1]} status fields:`, {
              listingStatus: sellingStatus || 'NOT FOUND',
              adminEnded: isAdminEnded ? 'true' : 'false',
              endReason: endReason || 'NOT FOUND'
            });
          }
          
          // Parse quantities
          const quantityAvailable = quantityAvailMatch ? parseInt(quantityAvailMatch[1]) : (quantityMatch ? parseInt(quantityMatch[1]) : 0);
          const quantitySold = quantitySoldMatch ? parseInt(quantitySoldMatch[1]) : 0;
          const totalQuantity = quantityMatch ? parseInt(quantityMatch[1]) : 0;
          
          // Skip if:
          // 1. Status is not "Active" (could be "Completed", "Ended", "Inactive", "CustomCode")
          // 2. Administratively ended by eBay
          // 3. Has an end reason (seller or eBay ended it)
          // 4. Quantity available is 0 or negative
          // 5. All items are sold (quantity sold >= total quantity for fixed price listings)
          
          // Check if administratively ended
          if (isAdminEnded) {
            console.log(`[ebay-list-active-trading] Skipping item ${itemIdMatch?.[1]} - administratively ended by eBay`);
            continue;
          }
          
          // Check if manually ended or has end reason
          if (endReason) {
            console.log(`[ebay-list-active-trading] Skipping item ${itemIdMatch?.[1]} - end reason: ${endReason}`);
            continue;
          }
          
          // eBay statuses: Active, Completed, Ended, CustomCode, ActiveWithWatchers
          // We only want Active or ActiveWithWatchers
          const validStatuses = ['Active', 'ActiveWithWatchers'];
          if (sellingStatus && !validStatuses.includes(sellingStatus)) {
            console.log(`[ebay-list-active-trading] Skipping item ${itemIdMatch?.[1]} - status: ${sellingStatus}`);
            continue;
          }
          
          if (quantityAvailable <= 0) {
            console.log(`[ebay-list-active-trading] Skipping item ${itemIdMatch?.[1]} - 0 quantity available`);
            continue;
          }
          
          // For fixed price listings, skip if completely sold out
          if (totalQuantity > 0 && quantitySold >= totalQuantity) {
            console.log(`[ebay-list-active-trading] Skipping item ${itemIdMatch?.[1]} - sold out (${quantitySold}/${totalQuantity})`);
            continue;
          }
          
          if (itemIdMatch) {
            const itemId = itemIdMatch[1];
            const listing = {
              itemId: itemId,
              offerId: itemId,
              listingId: itemId,
              sku: skuMatch ? skuMatch[1] : itemId, // Use itemId as fallback SKU
              isInventoryListing: isInventoryListing, // Flag to determine which API to use for updates
              title: titleMatch ? titleMatch[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : '',
              price: priceMatch ? {
                value: priceMatch[1],
                currency: currencyMatch ? currencyMatch[1] : 'USD'
              } : undefined,
              availableQuantity: quantityAvailable,
              quantitySold: quantitySold,
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
    
    // Fetch promotion status for all listings
    try {
      console.log('[ebay-list-active-trading] Fetching promotion data...');
      
      // Use Marketing API directly with the access token we already have
      // Use NODE_ENV like the ebay-promote library does (defaults to 'production' in Netlify)
      const env = process.env.NODE_ENV || 'production';
      const marketingApiHost = env === 'production'
        ? 'https://api.ebay.com'
        : 'https://api.sandbox.ebay.com';
      console.log('[ebay-list-active-trading] Using Marketing API host:', marketingApiHost, '(NODE_ENV:', env, ')');
      
      // Get all campaigns
      const campaignsUrl = `${marketingApiHost}/sell/marketing/v1/ad_campaign?campaign_status=RUNNING&limit=100`;
      const campaignsRes = await fetch(campaignsUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${access_token}`,
          'Content-Type': 'application/json',
        },
      });
      
      if (!campaignsRes.ok) {
        const errText = await campaignsRes.text();
        console.error('[ebay-list-active-trading] Failed to fetch campaigns:', campaignsRes.status, errText);
        throw new Error(`Failed to fetch campaigns: ${campaignsRes.status}`);
      }
      
      const campaignsData = await campaignsRes.json();
      const campaigns = campaignsData.campaigns || [];
      console.log('[ebay-list-active-trading] Found', campaigns.length, 'running campaigns');
      
      // Build a map of inventoryReferenceId -> promotion data
      const promotionMap = new Map<string, { rate: number; adId: string; campaignId: string }>();
      
      for (const campaign of campaigns) {
        if (campaign.campaignId) {
          try {
            // Get ads for this campaign
            const adsUrl = `${marketingApiHost}/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaign.campaignId)}/ad?limit=500`;
            const adsRes = await fetch(adsUrl, {
              method: 'GET',
              headers: {
                'Authorization': `Bearer ${access_token}`,
                'Content-Type': 'application/json',
              },
            });
            
            if (!adsRes.ok) {
              console.error(`[ebay-list-active-trading] Failed to fetch ads for campaign ${campaign.campaignId}:`, adsRes.status);
              continue;
            }
            
            const adsData = await adsRes.json();
            const ads = adsData.ads || [];
            console.log(`[ebay-list-active-trading] Campaign ${campaign.campaignId}: Found ${ads.length} ads`);
            
            // Log first ad structure to understand the data
            if (ads.length > 0 && promotionMap.size === 0) {
              console.log('[ebay-list-active-trading] Sample ad structure:', JSON.stringify(ads[0]));
            }
            
            for (const ad of ads) {
              // Ads returned from RUNNING campaigns are already active
              // They use listingId for non-inventory items, inventoryReferenceId for inventory items
              const adId = ad.listingId || ad.inventoryReferenceId;
              
              if (adId) {
                const bidPercentage = typeof ad.bidPercentage === 'string' 
                  ? parseFloat(ad.bidPercentage) 
                  : ad.bidPercentage;
                
                promotionMap.set(adId, {
                  rate: bidPercentage || 0,
                  adId: ad.adId || '',
                  campaignId: campaign.campaignId
                });
              }
            }
          } catch (adErr: any) {
            console.error(`[ebay-list-active-trading] Error fetching ads for campaign ${campaign.campaignId}:`, adErr.message);
          }
        }
      }
      
      console.log('[ebay-list-active-trading] Built promotion map with', promotionMap.size, 'entries');
      if (promotionMap.size > 0) {
        console.log('[ebay-list-active-trading] Sample promotion keys:', Array.from(promotionMap.keys()).slice(0, 5));
      }
      
      // Merge promotion data into listings
      let promotedCount = 0;
      for (const offer of activeOffers) {
        // Try matching by SKU, itemId, or offerId
        const promoData = promotionMap.get(offer.sku) || 
                         (offer.itemId ? promotionMap.get(offer.itemId) : undefined) || 
                         promotionMap.get(offer.offerId);
        if (promoData) {
          offer.autoPromote = true;
          offer.autoPromoteAdRate = promoData.rate;
          promotedCount++;
        } else {
          offer.autoPromote = false;
          offer.autoPromoteAdRate = undefined;
        }
      }
      
      console.log('[ebay-list-active-trading] Merged promotion data -', promotedCount, 'of', activeOffers.length, 'listings are promoted');
    } catch (promoErr: any) {
      console.error('[ebay-list-active-trading] Error fetching promotion data:', promoErr.message);
      console.error('[ebay-list-active-trading] Stack:', promoErr.stack);
      // Continue without promotion data - just log the error
    }
    
    if (activeOffers.length > 0) {
      console.log('[ebay-list-active-trading] Sample listing:', JSON.stringify(activeOffers[0]).substring(0, 400));
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
