// Find and optionally delete inventory items with invalid SKUs
// eBay only allows alphanumeric SKUs (A-Z, a-z, 0-9), max 50 chars

import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: join(__dirname, '..', 'prod.env') });

const SKU_OK = (s) => /^[A-Za-z0-9]{1,50}$/.test(s || '');

async function main() {
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

  // Scan all inventory items
  console.log('\n🔍 Scanning inventory for invalid SKUs...\n');
  const invalidItems = [];
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
      const sku = item.sku;
      if (!SKU_OK(sku)) {
        invalidItems.push(item);
        console.log(`❌ Invalid SKU: "${sku}"`);
        if (item.product?.title) {
          console.log(`   Title: ${item.product.title.substring(0, 60)}...`);
        }
        console.log(`   Issue: ${getSkuIssue(sku)}\n`);
      }
    }

    offset += limit;
    if (items.length < limit) break;
  }

  console.log(`\n📊 Found ${invalidItems.length} items with invalid SKUs`);

  if (invalidItems.length === 0) {
    console.log('✅ No invalid SKUs found!');
    return;
  }

  // Ask if user wants to delete
  console.log('\n⚠️  These items are causing eBay API errors.');
  console.log('Options:');
  console.log('1. Delete invalid items (run: node scripts/delete-invalid-skus.mjs)');
  console.log('2. Export list (run: node scripts/find-invalid-skus.mjs > invalid-skus.txt)');
  
  // Output JSON for other scripts to use
  console.log('\n--- JSON ---');
  console.log(JSON.stringify(invalidItems.map(i => ({
    sku: i.sku,
    title: i.product?.title,
    issue: getSkuIssue(i.sku)
  })), null, 2));
}

function getSkuIssue(sku) {
  if (!sku) return 'Empty SKU';
  if (sku.length > 50) return `Too long (${sku.length} chars, max 50)`;
  const invalidChars = sku.match(/[^A-Za-z0-9]/g);
  if (invalidChars) {
    return `Contains invalid characters: ${[...new Set(invalidChars)].join(', ')}`;
  }
  return 'Unknown issue';
}

main().catch(console.error);
