// Test Root Zero-In pricing locally
import { lookupPrice } from '../dist/src/lib/price-lookup.js';

console.log('Testing Root Zero-In (60 Capsules) pricing...\n');

const input = {
  brand: 'Root',
  title: 'Zero-In',
  category: 'Health & Beauty > Vitamins & Lifestyle Supplements > Vitamins & Minerals',
  brandWebsite: 'https://therootbrands.com/zero-in.html'
};

console.log('Input:', input);
console.log('\nExpected: Should find ~$77-80 for 60-count bottle on Amazon');
console.log('Running price lookup...\n');

const result = await lookupPrice(input);

console.log('\n=== RESULT ===');
console.log(`Source: ${result.chosen}`);
console.log(`Base price: $${result.basePrice?.toFixed(2) || 'N/A'}`);
console.log(`Final price: $${result.recommendedListingPrice?.toFixed(2) || 'N/A'}`);
console.log(`\nFull decision:`, JSON.stringify(result, null, 2));

if (result.recommendedListingPrice && result.recommendedListingPrice >= 60 && result.recommendedListingPrice <= 90) {
  console.log('\n✅ SUCCESS: Price is in expected range for 60-count bottle ($60-90)');
} else {
  console.log(`\n❌ UNEXPECTED: Price ${result.recommendedListingPrice} is outside expected range`);
}
