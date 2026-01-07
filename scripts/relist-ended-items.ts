/**
 * Relist ended/deleted eBay listings
 * 
 * This script:
 * 1. Fetches all unsold/ended items from eBay via GetMyeBaySelling
 * 2. Relists them using RelistFixedPriceItem Trading API
 * 
 * Usage:
 *   npx tsx scripts/relist-ended-items.ts --dry-run     # Preview what would be relisted
 *   npx tsx scripts/relist-ended-items.ts               # Actually relist
 */

import 'dotenv/config';
import { accessTokenFromRefresh } from '../src/lib/_common.js';
import { tokensStore } from '../src/lib/_blobs.js';
import { userScopedKey } from '../src/lib/_auth.js';

const USER_SUB = process.env.DEV_USER_ID || 'google-oauth2|108767599998494531403';
const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  console.log('='.repeat(70));
  console.log('RELIST ENDED ITEMS');
  console.log('='.repeat(70));
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (preview only)' : 'LIVE - WILL RELIST'}`);
  console.log('');

  // Get eBay access token
  const store = tokensStore();
  const saved = await store.get(userScopedKey(USER_SUB, 'ebay.json'), { type: 'json' }) as any;
  const refresh = saved?.refresh_token;
  
  if (!refresh) {
    console.error('No eBay refresh token found');
    process.exit(1);
  }

  const { access_token } = await accessTokenFromRefresh(refresh);
  const ENV = process.env.EBAY_ENV || 'PROD';
  const tradingHost = ENV === 'SANDBOX' 
    ? 'https://api.sandbox.ebay.com/ws/api.dll'
    : 'https://api.ebay.com/ws/api.dll';

  // Step 1: Get unsold items
  console.log('Fetching unsold/ended items from eBay...');
  
  const unsoldItems: any[] = [];
  let pageNumber = 1;
  let hasMore = true;

  while (hasMore) {
    const xmlRequest = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${access_token}</eBayAuthToken>
  </RequesterCredentials>
  <UnsoldList>
    <Include>true</Include>
    <DurationInDays>60</DurationInDays>
    <Pagination>
      <EntriesPerPage>200</EntriesPerPage>
      <PageNumber>${pageNumber}</PageNumber>
    </Pagination>
  </UnsoldList>
  <DetailLevel>ReturnAll</DetailLevel>
</GetMyeBaySellingRequest>`;

    const res = await fetch(tradingHost, {
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
    
    if (xmlText.includes('<Ack>Failure</Ack>')) {
      console.error('eBay API error:', xmlText.substring(0, 500));
      break;
    }

    // Parse items from UnsoldList
    const unsoldMatch = xmlText.match(/<UnsoldList>(.*?)<\/UnsoldList>/s);
    if (!unsoldMatch) {
      console.log('No UnsoldList found in response');
      break;
    }

    const itemMatches = unsoldMatch[1].matchAll(/<Item>(.*?)<\/Item>/gs);
    let pageItemCount = 0;
    
    for (const match of itemMatches) {
      const itemXml = match[1];
      const itemIdMatch = itemXml.match(/<ItemID>([^<]+)<\/ItemID>/);
      const titleMatch = itemXml.match(/<Title>([^<]+)<\/Title>/);
      const priceMatch = itemXml.match(/<CurrentPrice[^>]*>([^<]+)<\/CurrentPrice>/);
      const skuMatch = itemXml.match(/<SKU>([^<]+)<\/SKU>/);
      const endTimeMatch = itemXml.match(/<EndTime>([^<]+)<\/EndTime>/);
      
      if (itemIdMatch) {
        unsoldItems.push({
          itemId: itemIdMatch[1],
          title: titleMatch?.[1] || 'Unknown',
          price: priceMatch?.[1] || 'Unknown',
          sku: skuMatch?.[1] || null,
          endTime: endTimeMatch?.[1] || null,
        });
        pageItemCount++;
      }
    }

    console.log(`  Page ${pageNumber}: Found ${pageItemCount} ended items`);
    
    hasMore = xmlText.includes('<HasMoreItems>true</HasMoreItems>');
    pageNumber++;
    
    // Safety limit
    if (pageNumber > 20) break;
  }

  console.log('');
  console.log(`Total ended items found: ${unsoldItems.length}`);
  console.log('');

  if (unsoldItems.length === 0) {
    console.log('No ended items to relist');
    return;
  }

  // Show what we found
  console.log('Ended items:');
  unsoldItems.forEach((item, i) => {
    console.log(`  ${i + 1}. ${item.itemId} - $${item.price} - ${item.title.substring(0, 50)}...`);
  });
  console.log('');

  if (DRY_RUN) {
    console.log('DRY RUN - No items were relisted');
    console.log('Run without --dry-run to actually relist');
    return;
  }

  // Step 2: Relist each item
  console.log('Relisting items...');
  let successCount = 0;
  let errorCount = 0;

  for (const item of unsoldItems) {
    console.log(`  Relisting ${item.itemId}: ${item.title.substring(0, 40)}...`);
    
    const relistRequest = `<?xml version="1.0" encoding="utf-8"?>
<RelistFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${access_token}</eBayAuthToken>
  </RequesterCredentials>
  <Item>
    <ItemID>${item.itemId}</ItemID>
  </Item>
</RelistFixedPriceItemRequest>`;

    try {
      const relistRes = await fetch(tradingHost, {
        method: 'POST',
        headers: {
          'X-EBAY-API-COMPATIBILITY-LEVEL': '1193',
          'X-EBAY-API-CALL-NAME': 'RelistFixedPriceItem',
          'X-EBAY-API-SITEID': '0',
          'Content-Type': 'text/xml; charset=utf-8',
        },
        body: relistRequest,
      });

      const relistXml = await relistRes.text();
      
      if (relistXml.includes('<Ack>Success</Ack>') || relistXml.includes('<Ack>Warning</Ack>')) {
        const newItemIdMatch = relistXml.match(/<ItemID>([^<]+)<\/ItemID>/);
        console.log(`    ✅ Relisted! New ItemID: ${newItemIdMatch?.[1] || 'unknown'}`);
        successCount++;
      } else {
        const errorMatch = relistXml.match(/<LongMessage>([^<]+)<\/LongMessage>/);
        console.log(`    ❌ Failed: ${errorMatch?.[1] || 'Unknown error'}`);
        errorCount++;
      }
    } catch (err: any) {
      console.log(`    ❌ Error: ${err.message}`);
      errorCount++;
    }

    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('');
  console.log('='.repeat(70));
  console.log(`DONE: ${successCount} relisted, ${errorCount} errors`);
  console.log('='.repeat(70));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
