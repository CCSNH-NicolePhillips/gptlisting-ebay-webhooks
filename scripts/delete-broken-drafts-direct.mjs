#!/usr/bin/env node
/**
 * Delete broken eBay drafts with invalid SKUs
 * Uses inventory scan since offer listing is broken by error 25707
 */

import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load environment variables from prod.env
const envPath = path.join(__dirname, '..', 'prod.env');
const envContent = fs.readFileSync(envPath, 'utf-8');
const env = {};
envContent.split('\n').forEach(line => {
  const match = line.match(/^([^=]+)=(.*)$/);
  if (match) {
    env[match[1].trim()] = match[2].trim();
  }
});

const EBAY_CLIENT_ID = env.EBAY_CLIENT_ID;
const EBAY_CLIENT_SECRET = env.EBAY_CLIENT_SECRET;

if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) {
  console.error('ERROR: EBAY_CLIENT_ID or EBAY_CLIENT_SECRET not found in prod.env');
  process.exit(1);
}

// Get refresh token
const EBAY_USER_REFRESH_TOKEN = process.env.EBAY_USER_REFRESH_TOKEN || process.argv[2];

if (!EBAY_USER_REFRESH_TOKEN) {
  console.error('ERROR: Please provide your eBay refresh token as an argument:');
  console.error('  node delete-broken-drafts-direct.mjs YOUR_REFRESH_TOKEN');
  console.error('');
  console.error('To get your refresh token:');
  console.error('  1. Open Netlify dashboard: https://app.netlify.com');
  console.error('  2. Go to your site > Functions > ebay-list-offers');
  console.error('  3. Check recent function logs');
  console.error('  4. Look for "Access token refreshed" - the refresh token was used');
  console.error('');
  console.error('OR check your eBay Developer account:');
  console.error('  1. Go to https://developer.ebay.com/my/auth?env=production&index=0');
  console.error('  2. Click "Get a User Token"');
  console.error('  3. Sign in with your eBay account');
  console.error('  4. Copy the User Refresh Token');
  process.exit(1);
}

const EBAY_ENV = 'PROD';
const API_HOST = EBAY_ENV === 'SANDBOX' 
  ? 'https://api.sandbox.ebay.com' 
  : 'https://api.ebay.com';
const MARKETPLACE_ID = 'EBAY_US';

const validSku = (s) => !!s && /^[A-Za-z0-9]{1,50}$/.test(s);

async function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, body: parsed });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getAccessToken(refreshToken) {
  console.log('Getting access token...');
  const auth = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString('base64');
  const tokenBody = `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`;
  
  const tokenHost = EBAY_ENV === 'SANDBOX' 
    ? 'api.sandbox.ebay.com'
    : 'api.ebay.com';
  
  const options = {
    hostname: tokenHost,
    path: '/identity/v1/oauth2/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${auth}`,
      'Content-Length': Buffer.byteLength(tokenBody),
    },
  };
  
  const res = await httpsRequest(options, tokenBody);
  if (res.status !== 200) {
    throw new Error(`Token refresh failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  
  console.log('Access token obtained');
  return res.body.access_token;
}

async function listInventory(accessToken, offset = 0) {
  const url = new URL(`${API_HOST}/sell/inventory/v1/inventory_item`);
  url.searchParams.set('limit', '200');
  url.searchParams.set('offset', String(offset));
  
  const options = {
    hostname: url.hostname,
    path: url.pathname + url.search,
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
      'Content-Language': 'en-US',
      'Accept-Language': 'en-US',
      'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID,
    },
  };
  
  const res = await httpsRequest(options);
  if (res.status !== 200) {
    throw new Error(`Inventory list failed: ${res.status}`);
  }
  
  const items = Array.isArray(res.body?.inventoryItems) ? res.body.inventoryItems : [];
  const hasMore = res.body?.href && res.body?.next;
  return { items, hasMore };
}

async function listOffersForSku(accessToken, sku) {
  if (!validSku(sku)) return [];
  
  const url = new URL(`${API_HOST}/sell/inventory/v1/offer`);
  url.searchParams.set('sku', sku);
  url.searchParams.set('limit', '50');
  
  const options = {
    hostname: url.hostname,
    path: url.pathname + url.search,
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
      'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID,
    },
  };
  
  const res = await httpsRequest(options);
  if (res.status !== 200) return [];
  
  return Array.isArray(res.body?.offers) ? res.body.offers : [];
}

async function deleteOffer(accessToken, offerId) {
  const url = new URL(`${API_HOST}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`);
  
  const options = {
    hostname: url.hostname,
    path: url.pathname,
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
    },
  };
  
  const res = await httpsRequest(options);
  return res.status === 204 || res.status === 200;
}

async function main() {
  console.log('='.repeat(60));
  console.log('eBay Broken Drafts Cleanup');
  console.log('='.repeat(60));
  
  const accessToken = await getAccessToken(EBAY_USER_REFRESH_TOKEN);
  
  let offset = 0;
  let scanned = 0;
  let deleted = 0;
  const maxScans = 2000;
  
  console.log('\nScanning inventory items...\n');
  
  while (scanned < maxScans) {
    const page = await listInventory(accessToken, offset);
    
    if (page.items.length === 0) {
      console.log('No more items to scan');
      break;
    }
    
    for (const item of page.items) {
      const sku = item?.sku;
      scanned++;
      const bad = !validSku(sku);
      
      if (bad) {
        console.log(`[${scanned}] Invalid SKU: "${sku}"`);
      } else {
        process.stdout.write(`\r[${scanned}] Scanning SKU: ${sku}...`);
      }
      
      // Get offers for this SKU
      const offers = await listOffersForSku(accessToken, sku);
      
      // Delete UNPUBLISHED offers or offers with bad SKUs
      for (const offer of offers) {
        const status = String(offer?.status || '').toUpperCase();
        if (status === 'UNPUBLISHED' || bad) {
          process.stdout.write('\n');
          console.log(`  Deleting offer ${offer.offerId} (status: ${status}, SKU: ${sku})`);
          const success = await deleteOffer(accessToken, offer.offerId);
          if (success) {
            deleted++;
            console.log(`  ✓ Deleted (${deleted} total)`);
          } else {
            console.log(`  ✗ Failed to delete`);
          }
        }
      }
    }
    
    if (!page.hasMore) {
      console.log('\n\nReached end of inventory');
      break;
    }
    
    offset += 200;
  }
  
  console.log('\n' + '='.repeat(60));
  console.log(`SUMMARY`);
  console.log('='.repeat(60));
  console.log(`Items scanned: ${scanned}`);
  console.log(`Offers deleted: ${deleted}`);
  console.log('='.repeat(60));
}

main().catch(err => {
  console.error('\nERROR:', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
