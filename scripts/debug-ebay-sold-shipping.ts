/**
 * Debug script to inspect raw SearchAPI eBay sold item response
 * to see if shipping info is available
 */

import { config } from 'dotenv';
config();

const apiKey = process.env.SEARCHAPI_KEY;

if (!apiKey) {
  console.error('No SEARCHAPI_KEY set');
  process.exit(1);
}

const params = new URLSearchParams({
  engine: 'ebay_search',
  ebay_domain: 'ebay.com',
  q: 'OGX Bond Protein Repair 3-in-1 Oil Mist',
  ebay_tbs: 'LH_Complete:1,LH_Sold:1',
});

const url = `https://www.searchapi.io/api/v1/search?${params.toString()}`;

const response = await fetch(url, {
  headers: { 'Authorization': `Bearer ${apiKey}` }
});

const data = await response.json();

console.log('=== FIRST 10 SOLD ITEMS ===\n');
for (const item of data.organic_results?.slice(0, 10) || []) {
  const ship = item.extracted_shipping || (item.shipping?.toLowerCase().includes('free') ? 0 : '?');
  const delivered = item.extracted_price + (typeof ship === 'number' ? ship : 0);
  console.log(`$${item.extracted_price} + $${ship} = $${delivered.toFixed(2)} | ${item.title?.slice(0,60)}`);
}
