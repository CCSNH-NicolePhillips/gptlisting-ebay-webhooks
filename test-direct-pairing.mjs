// Test script for direct pairing endpoint
// Run with: node test-direct-pairing.mjs

import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env file
dotenv.config({ path: join(__dirname, 'prod.env') });

const NETLIFY_URL = 'https://draftpilot.app/.netlify/functions/smartdrafts-pairing-direct';
const FOLDER = '/newStuff';

// Get auth token from environment
const AUTH_TOKEN = process.env.TEST_AUTH_TOKEN || process.env.AUTH_TOKEN;

async function testDirectPairing() {
  console.log('[test] Fetching analysis for folder:', FOLDER);
  
  // First, get the analysis to extract imageInsights
  const analysisResp = await fetch(`https://draftpilot.app/.netlify/functions/smartdrafts-scan?folder=${encodeURIComponent(FOLDER)}`, {
    headers: {
      'Authorization': `Bearer ${AUTH_TOKEN}`
    }
  });
  
  if (!analysisResp.ok) {
    console.error('Failed to fetch analysis:', analysisResp.status, analysisResp.statusText);
    return;
  }
  
  const analysis = await analysisResp.json();
  console.log('[test] Analysis loaded, imageInsights count:', Object.keys(analysis.imageInsights || {}).length);
  
  // Build images array for direct pairing
  const imageInsights = analysis.imageInsights || {};
  const images = Object.values(imageInsights).map(insight => ({
    url: insight.displayUrl || insight.url,
    filename: insight.url.split('/').pop()
  }));
  
  console.log('[test] Calling direct pairing with', images.length, 'images');
  console.log('[test] Sample URLs:', images.slice(0, 2).map(i => ({ filename: i.filename, url: i.url.substring(0, 60) + '...' })));
  
  // Call direct pairing
  const startTime = Date.now();
  const pairingResp = await fetch(NETLIFY_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${AUTH_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ images })
  });
  
  const elapsed = Date.now() - startTime;
  
  if (!pairingResp.ok) {
    const errorText = await pairingResp.text();
    console.error('[test] Direct pairing failed:', pairingResp.status, errorText);
    return;
  }
  
  const result = await pairingResp.json();
  
  console.log('\n[test] ✅ Direct pairing succeeded in', elapsed, 'ms');
  console.log('[test] Products found:', result.products.length);
  console.log('\n[test] Results:');
  
  result.products.forEach((product, i) => {
    console.log(`\n${i + 1}. ${product.productName}`);
    console.log(`   Front: ${product.frontImage}`);
    console.log(`   Back:  ${product.backImage}`);
  });
}

if (!AUTH_TOKEN) {
  console.error('❌ Please set TEST_AUTH_TOKEN or AUTH_TOKEN in prod.env');
  console.error('   Get token from browser devtools: localStorage.getItem("auth0.access_token")');
  console.error('   Then add to prod.env: TEST_AUTH_TOKEN=your_token_here');
  process.exit(1);
}

testDirectPairing().catch(err => {
  console.error('[test] Error:', err);
  process.exit(1);
});
