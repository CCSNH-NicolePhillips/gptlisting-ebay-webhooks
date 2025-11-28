import { extractPriceFromHtml } from './dist/src/lib/html-price.js';
import https from 'https';

// Root Clean Slate on brand website
const url = 'https://therootbrands.com/';

console.log('Testing Root Clean Slate price extraction...\n');
console.log(`URL: ${url}\n`);

async function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

try {
  const html = await fetchHtml(url);
  console.log(`✓ Fetched ${(html.length / 1024).toFixed(1)} KB\n`);
  
  const price = extractPriceFromHtml(html);
  
  console.log('\n📊 RESULT:');
  console.log(`   Price extracted: $${price}`);
  console.log(`   eBay listing (10% off): $${price ? (price * 0.9).toFixed(2) : 'N/A'}`);
  
  if (price && price > 100) {
    console.log(`\n⚠️  WARNING: Price over $100 for a supplement - this might be incorrect!`);
    console.log(`   Expected range for supplements: $15-$60`);
    console.log(`   Actual extracted: $${price}`);
  }
  
} catch (err) {
  console.error('✗ Error:', err.message);
}
