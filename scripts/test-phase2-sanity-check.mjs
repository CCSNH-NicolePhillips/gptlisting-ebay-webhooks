// Test Phase 2: Price sanity check catches bundle pricing
// This simulates what happens when Root website slips past Phase 1 detection

import { lookupPrice } from '../dist/src/lib/price-lookup.js';

console.log('Testing Phase 2: Bundle price sanity check...\n');

// Simulate a scenario where:
// - Brand site returns $225 (bundle price)
// - Amazon returns $77.60 (actual single-product price)
// - Ratio: 225 / 77.60 = 2.9x (just under 3x threshold)

// Let's test with a product that should trigger the sanity check
const input = {
  brand: 'Test Brand',
  title: 'Test Product',
  category: 'Health & Beauty',
  // Simulate a brand website that returns high price
  brandWebsite: 'https://example-mlm-brand.com/product'
};

console.log('This test requires mocking prices, so we'll use Root as a real-world test case.');
console.log('Testing Root Zero-In with Phase 2 enabled...\n');

// Test with actual Root product
const rootInput = {
  brand: 'Root',
  title: 'Zero-In',
  category: 'Health & Beauty > Vitamins & Lifestyle Supplements',
  brandWebsite: 'https://therootbrands.com/zero-in.html'
};

const result = await lookupPrice(rootInput);

console.log('\n=== RESULT ===');
console.log(`Source: ${result.chosen?.source}`);
console.log(`Base price: $${result.chosen?.price?.toFixed(2) || 'N/A'}`);
console.log(`Final price: $${result.recommendedListingPrice?.toFixed(2) || 'N/A'}`);
console.log(`\nCandidates that made it to AI:`);
result.candidates.forEach((c, i) => {
  console.log(`  ${i + 1}. ${c.source}: $${c.price.toFixed(2)} (${c.url || 'no URL'})`);
});

// Check if bundle price was filtered out
const hasBrandMSRP = result.candidates.some(c => c.source === 'brand-msrp');
const hasHighPrice = result.candidates.some(c => c.price > 150);

if (hasHighPrice) {
  console.log('\n❌ FAIL: High bundle price ($225) was NOT filtered out');
} else if (result.recommendedListingPrice && result.recommendedListingPrice >= 60 && result.recommendedListingPrice <= 90) {
  console.log('\n✅ PASS: Bundle price filtered, Amazon price used ($60-90 range)');
} else {
  console.log(`\n⚠️ PARTIAL: Price is $${result.recommendedListingPrice}, investigate further`);
}
