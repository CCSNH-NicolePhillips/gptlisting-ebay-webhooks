import 'dotenv/config';
import { lookupPrice } from '../src/lib/price-lookup.js';
import { extractPriceWithShipping } from '../src/lib/html-price.js';

async function verify() {
  console.log('🧪 VERIFICATION START');

  // Test 1: Identity Integrity (Net Weight)
  console.log('\n--- Test 1: Net Weight Enforcement ---');
  await lookupPrice({
    brand: 'BetterAlt',
    title: 'Testo Pro 90 Capsules',
    netWeight: { value: 90, unit: 'capsules' }, // This MUST be enforced in search query
    keyText: ['Testo Pro'],
    skipCache: true
  });

  // Test 2: Scraper Precision (Pack Detection)
  console.log('\n--- Test 2: Pack Detection Regex ---');
  const badBodyText = '<html><body>Some random text saying Pack of 20 here</body></html>';
  const goodTitle = '<html><title>Product Name</title><h1>Box of 12 Bars</h1><body>...</body></html>';

  // We want to ensure it catches "Box of 12" from title
  const priceResult = extractPriceWithShipping(goodTitle, 'Product Name');
  console.log('Extraction Result:', priceResult);
}
verify();
