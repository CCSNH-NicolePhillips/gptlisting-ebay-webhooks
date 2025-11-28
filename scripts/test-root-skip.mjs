// Test that Root brand websites are skipped during price lookup
import { lookupPrice } from '../dist/src/lib/price-lookup.js';

console.log('Testing Root brand website skip...\n');

const input = {
  brand: 'Root',
  title: 'Clean Slate',
  category: 'Health & Beauty > Vitamins & Lifestyle Supplements > Vitamins & Minerals',
  brandWebsite: 'https://therootbrands.com/clean-slate.html'
};

console.log('Input:', input);
console.log('\nExpected: Skip therootbrands.com, fall back to category estimate ($29.99)');
console.log('Running price lookup...\n');

const result = await lookupPrice(input);

console.log('\n=== RESULT ===');
console.log(`Source: ${result.chosen}`);
console.log(`Base price: $${result.basePrice?.toFixed(2) || 'N/A'}`);
console.log(`Final price: $${result.recommendedListingPrice?.toFixed(2) || 'N/A'}`);

if (result.recommendedListingPrice && result.recommendedListingPrice < 50) {
  console.log('\n✅ SUCCESS: Price is under $50 (not the $225 bundle price)');
} else {
  console.log('\n❌ FAILED: Still getting bundle pricing ($202.50)');
}
