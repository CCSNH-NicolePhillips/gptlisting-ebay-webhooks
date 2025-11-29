import fetch from 'node-fetch';

const url = 'https://therootbrands.com/product/sculpt/';
const response = await fetch(url);
const html = await response.text();

const regex = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
let match;
let count = 1;

while ((match = regex.exec(html)) !== null) {
  console.log(`\n=== JSON-LD #${count} ===`);
  try {
    const json = JSON.parse(match[1]);
    console.log(JSON.stringify(json, null, 2));
  } catch (e) {
    console.log('Failed to parse:', e.message);
    console.log('Raw content:', match[1].substring(0, 500));
  }
  count++;
}

console.log('\n=== TESTING EXTRACTION ===');
import { extractPriceFromHtml } from '../dist/src/lib/html-price.js';
const price = extractPriceFromHtml(html);
console.log('Extracted price:', price);
