/**
 * Quick diagnostic script to check what's in the eBay Inventory API for a specific SKU
 * Usage: node scripts/check-inventory-item.mjs <SKU>
 */

import { tokensStore } from '../src/lib/_blobs.js';
import { accessTokenFromRefresh } from '../src/lib/_common.js';

const sku = process.argv[2];
if (!sku) {
  console.error('Usage: node scripts/check-inventory-item.mjs <SKU>');
  process.exit(1);
}

// Default user - you can override this if needed
const userId = process.env.USER_ID || 'google-oauth2|113932255661341771636';

async function main() {
  console.log('Fetching inventory item for SKU:', sku);
  console.log('User:', userId);

  const store = tokensStore();
  const saved = await store.get(`${userId}:ebay.json`, { type: 'json' });
  const refresh = saved?.refresh_token;

  if (!refresh) {
    console.error('No eBay refresh token found for user');
    process.exit(1);
  }

  const { access_token } = await accessTokenFromRefresh(refresh);
  const apiHost = 'https://api.ebay.com';

  // Get inventory item
  const itemUrl = `${apiHost}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`;
  console.log('\nFetching:', itemUrl);

  const itemRes = await fetch(itemUrl, {
    headers: {
      'Authorization': `Bearer ${access_token}`,
      'Content-Type': 'application/json',
      'Accept-Language': 'en-US',
      'Content-Language': 'en-US',
    },
  });

  if (!itemRes.ok) {
    console.error('Failed to fetch inventory item:', itemRes.status);
    const errorText = await itemRes.text();
    console.error(errorText);
    process.exit(1);
  }

  const item = await itemRes.json();
  console.log('\n=== INVENTORY ITEM ===');
  console.log('SKU:', item.sku);
  console.log('Availability:', item.availability?.shipToLocationAvailability?.quantity || 0);
  console.log('Condition:', item.condition);
  console.log('\n--- Product Data ---');
  console.log('Title:', item.product?.title || 'N/A');
  console.log('Description (first 200 chars):', (item.product?.description || 'N/A').substring(0, 200));
  console.log('Images:', item.product?.imageUrls?.length || 0);
  console.log('Aspects:', Object.keys(item.product?.aspects || {}).length, 'keys');
  
  if (item.packageWeightAndSize?.weight) {
    console.log('\n--- Package Weight ---');
    console.log('Weight:', item.packageWeightAndSize.weight.value, item.packageWeightAndSize.weight.unit);
  } else {
    console.log('\n--- Package Weight ---');
    console.log('Weight: NOT SET');
  }

  // Get offer
  const offerUrl = `${apiHost}/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=EBAY_US`;
  console.log('\n\nFetching offers:', offerUrl);

  const offerRes = await fetch(offerUrl, {
    headers: {
      'Authorization': `Bearer ${access_token}`,
      'Content-Type': 'application/json',
      'Accept-Language': 'en-US',
      'Content-Language': 'en-US',
    },
  });

  if (!offerRes.ok) {
    console.error('Failed to fetch offers:', offerRes.status);
    const errorText = await offerRes.text();
    console.error(errorText);
  } else {
    const offers = await offerRes.json();
    if (offers.offers && offers.offers.length > 0) {
      const offer = offers.offers[0];
      console.log('\n=== OFFER ===');
      console.log('Offer ID:', offer.offerId);
      console.log('Status:', offer.status);
      console.log('Price:', offer.pricingSummary?.price?.value, offer.pricingSummary?.price?.currency);
      console.log('Quantity:', offer.availableQuantity);
      console.log('Format:', offer.format);
      console.log('Listing ID:', offer.listingId);
    } else {
      console.log('\nNo offers found for this SKU');
    }
  }

  console.log('\n\n=== FULL INVENTORY ITEM JSON ===');
  console.log(JSON.stringify(item, null, 2));
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
