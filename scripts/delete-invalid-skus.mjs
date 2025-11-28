// Delete inventory items with invalid SKUs
// Use after running find-invalid-skus.mjs to identify items

import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: join(__dirname, '..', 'prod.env') });

const SKU_OK = (s) => /^[A-Za-z0-9]{1,50}$/.test(s || '');

async function main() {
  const DRY_RUN = process.argv.includes('--dry-run');
  
  const appId = process.env.EBAY_CLIENT_ID;
  const certId = process.env.EBAY_CLIENT_SECRET;
  const refreshToken = process.env.EBAY_REFRESH_TOKEN || process.env.EBAY_REFRESH_TOKEN_ADMIN;
  const apiHost = process.env.EBAY_API_HOST || 'https://api.ebay.com';

  if (!appId || !certId || !refreshToken) {
    console.error('❌ Missing eBay credentials in .env');
    process.exit(1);
  }

  // Get access token
  console.log('🔑 Getting access token...');
  const authString = Buffer.from(`${appId}:${certId}`).toString('base64');
  const tokenRes = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${authString}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: 'https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.inventory',
    }),
  });

  if (!tokenRes.ok) {
    console.error('❌ Failed to get access token:', await tokenRes.text());
    process.exit(1);
  }

  const { access_token } = await tokenRes.json();
  const headers = {
    Authorization: `Bearer ${access_token}`,
    Accept: 'application/json',
    'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
  };

  // Scan for invalid SKUs
  console.log(`\n🔍 Scanning for invalid SKUs... ${DRY_RUN ? '(DRY RUN)' : ''}\n`);
  const toDelete = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const url = `${apiHost}/sell/inventory/v1/inventory_item?limit=${limit}&offset=${offset}`;
    const res = await fetch(url, { headers });
    
    if (!res.ok) {
      console.error('❌ API error:', await res.text());
      break;
    }

    const json = await res.json();
    const items = json.inventoryItems || [];
    
    if (!items.length) break;

    for (const item of items) {
      if (!SKU_OK(item.sku)) {
        toDelete.push(item);
      }
    }

    offset += limit;
    if (items.length < limit) break;
  }

  if (toDelete.length === 0) {
    console.log('✅ No invalid SKUs found!');
    return;
  }

  console.log(`📊 Found ${toDelete.length} items with invalid SKUs\n`);

  if (DRY_RUN) {
    console.log('--- DRY RUN: Would delete these items ---\n');
    toDelete.forEach(item => {
      console.log(`SKU: "${item.sku}"`);
      console.log(`Title: ${item.product?.title || 'N/A'}`);
      console.log('');
    });
    console.log(`\nTo actually delete, run: node scripts/delete-invalid-skus.mjs`);
    return;
  }

  // Delete items
  console.log('🗑️  Deleting invalid SKU items...\n');
  let deleted = 0;
  let failed = 0;

  for (const item of toDelete) {
    const sku = item.sku;
    // URL encode the SKU properly
    const encodedSku = encodeURIComponent(sku);
    const deleteUrl = `${apiHost}/sell/inventory/v1/inventory_item/${encodedSku}`;
    
    try {
      const res = await fetch(deleteUrl, {
        method: 'DELETE',
        headers,
      });

      if (res.ok || res.status === 204) {
        console.log(`✅ Deleted: "${sku}"`);
        deleted++;
      } else {
        const text = await res.text();
        console.error(`❌ Failed to delete "${sku}":`, res.status, text);
        failed++;
      }
    } catch (err) {
      console.error(`❌ Error deleting "${sku}":`, err.message);
      failed++;
    }

    // Rate limit protection
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  console.log(`\n📊 Summary:`);
  console.log(`   Deleted: ${deleted}`);
  console.log(`   Failed: ${failed}`);
  console.log(`   Total: ${toDelete.length}`);
}

main().catch(console.error);
