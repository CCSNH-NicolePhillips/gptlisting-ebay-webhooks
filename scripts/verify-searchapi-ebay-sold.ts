import 'dotenv/config';
import { fetchSoldPriceStats } from '../src/lib/pricing/ebay-sold-prices.js';

async function run() {
  console.log('=== Testing SearchAPI.io for eBay Sold Prices ===\n');

  // Test with a common product
  const result = await fetchSoldPriceStats({
    brand: 'Cymbiotika',
    title: 'Liposomal Magnesium L-Threonate',
    condition: 'NEW',
    userId: process.env.DEV_USER_ID, // Use user OAuth token
  });

  console.log('\n=== RESULTS ===');
  console.log(`OK: ${result.ok}`);
  console.log(`Samples: ${result.samples.length}`);
  console.log(`Rate Limited: ${result.rateLimited || false}`);
  
  if (result.samples.length > 0) {
    console.log(`\nStatistics:`);
    console.log(`  Median: $${result.median?.toFixed(2)}`);
    console.log(`  P35 (35th percentile): $${result.p35?.toFixed(2)}`);
    console.log(`  P10 (10th percentile): $${result.p10?.toFixed(2)}`);
    console.log(`  P90 (90th percentile): $${result.p90?.toFixed(2)}`);
    
    console.log(`\nSample prices (first 5):`);
    result.samples.slice(0, 5).forEach((sample, idx) => {
      console.log(`  ${idx + 1}. $${sample.price} ${sample.currency} - ${sample.url || 'no URL'}`);
    });
  }
  
  console.log('\n=== Test Complete ===');
}

run().catch(console.error);
