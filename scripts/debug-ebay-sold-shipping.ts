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
  q: 'New Chapter Liquid Multivitamin 30 fl oz',
  ebay_tbs: 'LH_Complete:1,LH_Sold:1',
});

const url = `https://www.searchapi.io/api/v1/search?${params.toString()}`;

const response = await fetch(url, {
  headers: { 'Authorization': `Bearer ${apiKey}` }
});

const data = await response.json();

console.log('=== FIRST 3 SOLD ITEMS (ALL FIELDS) ===\n');
for (const item of data.organic_results?.slice(0, 3) || []) {
  console.log('Title:', item.title);
  console.log('Price:', JSON.stringify(item.price));
  console.log('Shipping:', JSON.stringify(item.shipping));
  console.log('Extracted Price:', item.extracted_price);
  console.log('Total Price:', item.total_price);
  console.log('All keys:', Object.keys(item));
  console.log('---');
}
