import { extractPriceFromHtml } from './dist/src/lib/html-price.js';
import https from 'https';

const url = 'https://www.amazon.com/Vita-PLynxera-D-Chiro-Inositol-Supplement/dp/B0DZW37LQJ';

console.log('Testing multi-pack price extraction for Vita PLynxera...\n');
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
  console.log(`   Expected: ~$14 (half of $27.99 2-pack price)`);
  console.log(`   eBay listing (10% off): $${(price * 0.9).toFixed(2)}`);
  console.log(`   Expected eBay price: ~$12.60 (10% off $14)`);
  
  if (price >= 13 && price <= 15) {
    console.log('\n✅ SUCCESS: Price correctly adjusted for 2-pack!');
  } else {
    console.log(`\n⚠️ UNEXPECTED: Price is $${price}, expected ~$14`);
  }
  
} catch (err) {
  console.error('✗ Error:', err.message);
}
