// Test Phase 2: Simulate bundle price scenario
// We'll mock a lookup that has both brand-site ($225) and Amazon ($77.60) candidates

import { extractPriceFromHtml } from '../dist/src/lib/html-price.js';

console.log('Testing Phase 2: Price sanity check (simulated scenario)\n');

// Scenario: Brand website returns $225, Amazon returns $77.60
// Ratio: 225 / 77.60 = 2.9x (should trigger at 3x)

const candidates = [
  {
    source: 'brand-msrp',
    price: 225,
    currency: 'USD',
    url: 'https://therootbrands.com/zero-in.html',
    notes: 'Official brand site MSRP'
  },
  {
    source: 'brand-msrp',
    price: 77.60,
    currency: 'USD',
    url: 'https://us.amazon.com/THEROOTBRANDS-Root-Wellness-Zero-Rahm/dp/B0BQ2VT3CB',
    notes: 'Official brand site MSRP'
  }
];

console.log('Initial candidates:');
candidates.forEach((c, i) => {
  console.log(`  ${i + 1}. ${c.source}: $${c.price} from ${c.url}`);
});

// Simulate the filtering logic
const brandCandidates = candidates.filter(c => c.source === 'brand-msrp');
const marketCandidates = candidates.filter(c => 
  c.url?.includes('amazon.com') || 
  c.url?.includes('walmart.com')
);

console.log(`\nFound ${brandCandidates.length} brand candidates, ${marketCandidates.length} market candidates`);

if (brandCandidates.length > 0 && marketCandidates.length > 0) {
  const bestMarket = marketCandidates.reduce((best, c) =>
    c.price < best.price ? c : best,
    marketCandidates[0]
  );
  
  console.log(`\nBest market price: $${bestMarket.price} (${bestMarket.url})`);
  
  for (const brand of brandCandidates) {
    const ratio = brand.price / bestMarket.price;
    console.log(`\nChecking brand candidate: $${brand.price}`);
    console.log(`  Ratio: ${ratio.toFixed(2)}x`);
    console.log(`  Threshold: 3.0x`);
    
    if (ratio > 3.0) {
      console.log(`  ✅ WOULD FILTER: Ratio ${ratio.toFixed(2)}x > 3.0x`);
    } else {
      console.log(`  ❌ WOULD KEEP: Ratio ${ratio.toFixed(2)}x <= 3.0x`);
    }
  }
}

// Now test with actual threshold crossing
console.log('\n\n=== Test 2: Higher bundle price ($240) ===');
const candidates2 = [
  {
    source: 'brand-msrp',
    price: 240, // 240 / 77.60 = 3.09x (should trigger!)
    currency: 'USD',
    url: 'https://therootbrands.com/bundle',
    notes: 'Bundle pricing'
  },
  {
    source: 'brand-msrp',
    price: 77.60,
    currency: 'USD',
    url: 'https://amazon.com/product',
    notes: 'Single product'
  }
];

const ratio2 = candidates2[0].price / candidates2[1].price;
console.log(`Ratio: ${ratio2.toFixed(2)}x`);
if (ratio2 > 3.0) {
  console.log('✅ PASS: Would filter bundle price');
} else {
  console.log('❌ FAIL: Would not filter bundle price');
}
