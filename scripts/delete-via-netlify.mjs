#!/usr/bin/env node
/**
 * Delete broken eBay drafts by calling the Netlify function with admin auth
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
  line = line.trim();
  if (!line || line.startsWith('#')) return;
  const match = line.match(/^([^=]+)=(.*)$/);
  if (match) {
    env[match[1].trim()] = match[2].trim();
  }
});

const ADMIN_API_TOKEN = env.ADMIN_API_TOKEN;

if (!ADMIN_API_TOKEN) {
  console.error('ERROR: ADMIN_API_TOKEN not found in prod.env');
  process.exit(1);
}

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

async function callCleanupFunction() {
  const url = new URL('https://draftpilot.app/.netlify/functions/ebay-clean-broken-drafts');
  url.searchParams.set('deleteAll', 'true');
  url.searchParams.set('deleteInventory', 'true');
  url.searchParams.set('adminToken', ADMIN_API_TOKEN);
  url.searchParams.set('userSub', env.USER_SUB || 'auth0|6756b51bde4eccdb8ae98de7');
  
  const options = {
    hostname: url.hostname,
    path: url.pathname + url.search,
    method: 'GET',
    headers: {
      'Accept': 'application/json',
    },
  };
  
  console.log('Calling cleanup function...');
  const res = await httpsRequest(options);
  
  if (res.status !== 200) {
    console.error('ERROR:', res.status, res.body);
    return null;
  }
  
  return res.body;
}

async function main() {
  console.log('='.repeat(60));
  console.log('eBay Broken Drafts Cleanup via Netlify Function');
  console.log('='.repeat(60));
  console.log('');
  
  let totalDeleted = 0;
  let attempts = 0;
  const maxAttempts = 10;
  
  while (attempts < maxAttempts) {
    attempts++;
    console.log(`[Attempt ${attempts}/${maxAttempts}]`);
    
    const result = await callCleanupFunction();
    if (!result) {
      console.error('Cleanup failed');
      break;
    }
    
    const deleted = result.deletedOffers?.length || 0;
    totalDeleted += deleted;
    
    console.log(`  Deleted ${deleted} offers (${totalDeleted} total)`);
    
    if (!result.timedOut && !result.summary?.hasMore) {
      console.log('');
      console.log('✓ Cleanup complete!');
      break;
    }
    
    console.log('  More items to delete, continuing...');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  console.log('');
  console.log('='.repeat(60));
  console.log(`Total offers deleted: ${totalDeleted}`);
  console.log('='.repeat(60));
}

main().catch(err => {
  console.error('\nERROR:', err.message);
  process.exit(1);
});
