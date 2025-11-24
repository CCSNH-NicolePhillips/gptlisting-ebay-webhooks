#!/usr/bin/env node

/**
 * Delete broken eBay drafts using admin authentication
 * 
 * This script:
 * 1. Prompts for the user's 'sub' (from JWT)
 * 2. Calls the cleanup function with admin token + userSub
 * 3. Loops until all broken drafts are deleted
 */

import https from 'https';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load prod.env
const envPath = join(__dirname, '..', 'prod.env');
const envContent = readFileSync(envPath, 'utf-8');
const env = {};
for (const line of envContent.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const [key, ...valueParts] = trimmed.split('=');
  if (key && valueParts.length > 0) {
    env[key.trim()] = valueParts.join('=').trim();
  }
}

const ADMIN_TOKEN = env.ADMIN_API_TOKEN;
if (!ADMIN_TOKEN) {
  console.error('❌ ADMIN_API_TOKEN not found in prod.env');
  process.exit(1);
}

// Get userSub from command line
const userSub = process.argv[2];
if (!userSub) {
  console.error('❌ Usage: node delete-via-netlify-simple.mjs <userSub>');
  console.error('');
  console.error('To find your userSub:');
  console.error('1. Open browser DevTools on draftpilot.app');
  console.error('2. Go to Application > Local Storage > https://draftpilot.app');
  console.error('3. Look for netlifyIdentity or auth tokens');
  console.error('4. The "sub" claim is your user ID (looks like: a1b2c3d4-5678-90ab-cdef-1234567890ab)');
  process.exit(1);
}

console.log(`🔧 Admin Token: ${ADMIN_TOKEN.substring(0, 10)}...`);
console.log(`👤 User Sub: ${userSub}`);
console.log('');

async function callCleanup(iteration) {
  const url = `https://draftpilot.app/.netlify/functions/ebay-clean-broken-drafts?deleteAll=true&adminToken=${encodeURIComponent(ADMIN_TOKEN)}&userSub=${encodeURIComponent(userSub)}`;
  
  console.log(`🔄 Iteration ${iteration}: Calling cleanup function...`);
  
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const result = JSON.parse(data);
            console.log(`✅ Status: ${res.statusCode}`);
            console.log(`   Scanned: ${result.scanned || 0}`);
            console.log(`   Deleted Offers: ${result.deletedOffers || 0}`);
            console.log(`   Deleted Inventory: ${result.deletedInventory || 0}`);
            console.log(`   Timed Out: ${result.timedOut || false}`);
            resolve(result);
          } catch (e) {
            console.error(`❌ Parse error:`, e.message);
            console.error(`   Response: ${data}`);
            reject(e);
          }
        } else {
          console.error(`❌ Status: ${res.statusCode}`);
          console.error(`   Response: ${data}`);
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    }).on('error', reject);
  });
}

async function main() {
  let totalDeleted = 0;
  let iteration = 1;
  const MAX_ITERATIONS = 10;

  while (iteration <= MAX_ITERATIONS) {
    try {
      const result = await callCleanup(iteration);
      totalDeleted += (result.deletedOffers || 0);
      
      // If we deleted nothing or didn't time out, we're done
      if (result.deletedOffers === 0 || !result.timedOut) {
        console.log('');
        console.log(`✅ Cleanup complete!`);
        console.log(`   Total offers deleted: ${totalDeleted}`);
        break;
      }
      
      iteration++;
      console.log('');
    } catch (error) {
      console.error(`❌ Error:`, error.message);
      break;
    }
  }

  if (iteration > MAX_ITERATIONS) {
    console.log('');
    console.log(`⚠️  Reached maximum iterations (${MAX_ITERATIONS})`);
    console.log(`   Total offers deleted so far: ${totalDeleted}`);
  }
}

main().catch(console.error);
