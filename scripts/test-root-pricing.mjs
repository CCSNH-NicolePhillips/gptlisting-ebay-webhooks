import { lookupPrice } from './dist/src/lib/price-lookup.js';

console.log('Testing Root product pricing with homepage skip...\n');

const testProducts = [
  {
    name: 'Root Clean Slate',
    input: {
      title: 'Clean Slate',
      brand: 'Root',
      brandWebsite: 'https://therootbrands.com/',
      condition: 'NEW'
    }
  },
  {
    name: 'Root Sculpt',
    input: {
      title: 'Sculpt Weight Loss Support',
      brand: 'Root',
      brandWebsite: 'https://therootbrands.com/',
      condition: 'NEW'
    }
  }
];

for (const test of testProducts) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`Testing: ${test.name}`);
  console.log('='.repeat(80));
  
  try {
    const result = await lookupPrice(test.input);
    
    console.log('\n📊 RESULT:');
    console.log(`   Success: ${result.ok}`);
    console.log(`   Recommended price: $${result.recommendedListingPrice || 'N/A'}`);
    console.log(`   Source: ${result.chosen?.source || 'N/A'}`);
    console.log(`   Base price: $${result.chosen?.price || 'N/A'}`);
    console.log(`   Reason: ${result.reason || 'N/A'}`);
    
    console.log('\n   All candidates:');
    result.candidates.forEach(c => {
      console.log(`     - ${c.source}: $${c.price} ${c.notes ? `(${c.notes})` : ''}`);
    });
    
    if (result.recommendedListingPrice && result.recommendedListingPrice > 100) {
      console.log(`\n   ⚠️  WARNING: Price over $100 - expected $20-$60 for supplements`);
    } else if (result.recommendedListingPrice) {
      console.log(`\n   ✅ Price looks reasonable for a supplement`);
    }
    
  } catch (err) {
    console.error(`   ✗ Error: ${err.message}`);
  }
}

console.log('\n' + '='.repeat(80));
console.log('✅ Testing complete');
console.log('='.repeat(80));
