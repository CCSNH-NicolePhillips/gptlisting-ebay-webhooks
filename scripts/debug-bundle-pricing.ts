/**
 * Debug script for bundle/set pricing
 * 
 * Tests how bundles (shampoo+conditioner sets, kits, etc.) get priced
 * 
 * Usage: npx tsx scripts/debug-bundle-pricing.ts
 */

import 'dotenv/config';
import { searchGoogleShopping } from '../src/lib/google-shopping-search.js';
import { fetchSoldPriceStats } from '../src/lib/pricing/ebay-sold-prices.js';
import { getDeliveredPricing } from '../src/lib/delivered-pricing.js';

// Test cases for bundle pricing
const TEST_CASES = [
  {
    name: "Panda's Promise Shampoo + Conditioner SET",
    brand: "Panda's Promise",
    // Simulating what vision would output for bundleProducts
    bundleProducts: ["Batana Oil Nourishing Shampoo 12 fl oz", "Batana Oil Soft Conditioner 12 fl oz"],
    bundleType: "duo" as const,
  },
  {
    name: "Peach & Lily Glass Skin Discovery Kit",
    brand: "Peach & Lily",
    bundleProducts: ["Glass Skin Refining Serum", "Wild Dew Treatment Essence", "Glass Skin Veil Mist", "Matcha Pudding Cream"],
    bundleType: "kit" as const,
  },
];

// Extract product types from bundle products (like the improved code does)
function extractProductTypes(bundleProducts: string[]): string {
  return bundleProducts
    .map(p => {
      const lower = p.toLowerCase();
      if (lower.includes('shampoo')) return 'Shampoo';
      if (lower.includes('conditioner')) return 'Conditioner';
      if (lower.includes('serum')) return 'Serum';
      if (lower.includes('cream')) return 'Cream';
      if (lower.includes('mask')) return 'Mask';
      if (lower.includes('oil')) return 'Oil';
      if (lower.includes('mist')) return 'Mist';
      if (lower.includes('essence')) return 'Essence';
      return p.split(' ')[0];
    })
    .filter((v, i, a) => a.indexOf(v) === i) // Dedupe
    .join(' ');
}

async function testBundlePricing(testCase: typeof TEST_CASES[0]) {
  console.log('\n' + '='.repeat(80));
  console.log(`TESTING: ${testCase.name}`);
  console.log('='.repeat(80));
  
  // Step 1: Build queries (matching the improved code)
  const fullBundleQuery = `${testCase.bundleProducts.join(' ')} ${testCase.bundleType}`;
  const simpleBundleQuery = extractProductTypes(testCase.bundleProducts);
  
  console.log(`\n📦 Full bundle query: "${testCase.brand} ${fullBundleQuery}"`);
  console.log(`📦 Simple bundle query: "${testCase.brand} ${simpleBundleQuery}"`);
  
  // Step 2: Try FULL query
  console.log('\n--- QUERY 1: Full bundle query ---');
  const fullSoldResult = await fetchSoldPriceStats({
    title: fullBundleQuery,
    brand: testCase.brand,
    condition: 'NEW',
  });
  if (fullSoldResult.ok && fullSoldResult.samplesCount && fullSoldResult.samplesCount >= 5) {
    console.log(`✅ eBay Sold (full): ${fullSoldResult.samplesCount} samples @ $${fullSoldResult.deliveredMedian?.toFixed(2)}`);
  } else {
    console.log(`❌ eBay Sold (full): ${fullSoldResult.samplesCount || 0} samples (not enough)`);
  }
  
  // Step 3: Try SIMPLE query (the new fallback)
  console.log('\n--- QUERY 2: Simple bundle query (NEW FALLBACK) ---');
  const simpleSoldResult = await fetchSoldPriceStats({
    title: simpleBundleQuery,
    brand: testCase.brand,
    condition: 'NEW',
  });
  if (simpleSoldResult.ok && simpleSoldResult.samplesCount && simpleSoldResult.samplesCount >= 5) {
    console.log(`✅ eBay Sold (simple): ${simpleSoldResult.samplesCount} samples @ $${simpleSoldResult.deliveredMedian?.toFixed(2)}`);
  } else {
    console.log(`❌ eBay Sold (simple): ${simpleSoldResult.samplesCount || 0} samples (not enough)`);
  }
  
  // Step 4: Try individual products (last resort)
  console.log('\n--- QUERY 3: Individual products (fallback sum) ---');
  let totalCents = 0;
  for (const product of testCase.bundleProducts) {
    const individualSold = await fetchSoldPriceStats({
      title: product,
      brand: testCase.brand,
      condition: 'NEW',
    });
    
    if (individualSold.ok && individualSold.samplesCount && individualSold.deliveredMedian) {
      console.log(`  + ${product}: $${individualSold.deliveredMedian.toFixed(2)} (${individualSold.samplesCount} samples)`);
      totalCents += Math.round(individualSold.deliveredMedian * 100);
    } else {
      console.log(`  ❌ ${product}: No sold data`);
    }
  }
  
  // Step 5: Summary
  console.log('\n--- SUMMARY ---');
  const fullPrice = fullSoldResult.samplesCount && fullSoldResult.samplesCount >= 5 ? fullSoldResult.deliveredMedian : null;
  const simplePrice = simpleSoldResult.samplesCount && simpleSoldResult.samplesCount >= 5 ? simpleSoldResult.deliveredMedian : null;
  const sumPrice = totalCents > 0 ? totalCents / 100 : null;
  const sumWithDiscount = sumPrice ? sumPrice * 0.95 : null;
  
  console.log(`Full query SET price: ${fullPrice ? `$${fullPrice.toFixed(2)}` : 'NOT FOUND'}`);
  console.log(`Simple query SET price: ${simplePrice ? `$${simplePrice.toFixed(2)}` : 'NOT FOUND'}`);
  console.log(`Sum of individuals: ${sumPrice ? `$${sumPrice.toFixed(2)}` : 'NOT FOUND'}`);
  console.log(`Sum with 5% discount: ${sumWithDiscount ? `$${sumWithDiscount.toFixed(2)}` : 'N/A'}`);
  
  // Determine best price
  const bestSetPrice = fullPrice || simplePrice;
  if (bestSetPrice && sumWithDiscount) {
    if (bestSetPrice < sumWithDiscount * 0.9) {
      console.log(`\n🎯 RECOMMENDATION: Use SET price $${bestSetPrice.toFixed(2)} (better deal than sum)`);
    } else {
      console.log(`\n🎯 RECOMMENDATION: Use SUM $${sumWithDiscount.toFixed(2)} (set is overpriced)`);
    }
  } else if (bestSetPrice) {
    console.log(`\n🎯 RECOMMENDATION: Use SET price $${bestSetPrice.toFixed(2)}`);
  } else if (sumWithDiscount) {
    console.log(`\n🎯 RECOMMENDATION: Use SUM $${sumWithDiscount.toFixed(2)} (no set price found)`);
  } else {
    console.log('\n⚠️ NO PRICING DATA FOUND');
  }
}

async function main() {
  console.log('🔍 BUNDLE PRICING DEBUG SCRIPT (v2 - with simple query fallback)');
  console.log('Testing how bundles/sets get priced...\n');
  
  for (const testCase of TEST_CASES) {
    await testBundlePricing(testCase);
  }
  
  console.log('\n' + '='.repeat(80));
  console.log('DEBUG COMPLETE');
  console.log('='.repeat(80));
}

main().catch(console.error);
