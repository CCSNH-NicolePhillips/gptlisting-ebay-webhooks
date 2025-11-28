// Test Phase 2: Normal brand with close prices shouldn't be filtered

console.log('Testing Phase 2: Normal brand price sanity check\n');

// Scenario: Brand website $30, Amazon $29.50
// Ratio: 30 / 29.50 = 1.02x (should NOT trigger)

const candidates = [
  {
    source: 'brand-msrp',
    price: 30.00,
    currency: 'USD',
    url: 'https://normal-brand.com/product',
    notes: 'Brand MSRP'
  },
  {
    source: 'brand-msrp',
    price: 29.50,
    currency: 'USD',
    url: 'https://amazon.com/product',
    notes: 'Amazon price'
  }
];

console.log('Testing candidates:');
candidates.forEach(c => console.log(`  - ${c.source}: $${c.price} (${c.url})`));

const brandCandidates = candidates.filter(c => c.source === 'brand-msrp');
const marketCandidates = candidates.filter(c => c.url?.includes('amazon.com'));

if (marketCandidates.length > 0) {
  const bestMarket = marketCandidates[0];
  const ratio = candidates[0].price / bestMarket.price;
  
  console.log(`\nRatio: ${ratio.toFixed(2)}x`);
  console.log(`Threshold: 2.5x`);
  
  if (ratio > 2.5) {
    console.log('❌ FAIL: Would incorrectly filter normal brand price');
  } else {
    console.log('✅ PASS: Normal brand price kept (not flagged as bundle)');
  }
}

// Test edge cases
console.log('\n\n=== Edge case tests ===');

const testCases = [
  { brand: 30, market: 29, expected: 'keep', name: 'Slightly higher brand price' },
  { brand: 60, market: 30, expected: 'keep', name: '2x price (premium brand)' },
  { brand: 75, market: 30, expected: 'filter', name: '2.5x exactly (at threshold)' },
  { brand: 76, market: 30, expected: 'filter', name: '2.53x (just over threshold)' },
  { brand: 225, market: 77.60, expected: 'filter', name: 'Root scenario (2.90x)' },
  { brand: 240, market: 77.60, expected: 'filter', name: 'Higher Root bundle (3.09x)' },
];

testCases.forEach(test => {
  const ratio = test.brand / test.market;
  const wouldFilter = ratio > 2.5;
  const correct = (wouldFilter && test.expected === 'filter') || (!wouldFilter && test.expected === 'keep');
  
  console.log(`\n${test.name}:`);
  console.log(`  $${test.brand} / $${test.market} = ${ratio.toFixed(2)}x`);
  console.log(`  ${correct ? '✅' : '❌'} ${wouldFilter ? 'FILTER' : 'KEEP'} (expected: ${test.expected.toUpperCase()})`);
});
