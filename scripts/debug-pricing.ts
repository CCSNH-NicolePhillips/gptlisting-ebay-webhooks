/**
 * Debug script to trace why a product got a specific price
 * 
 * Usage: 
 *   npx tsx scripts/debug-pricing.ts "Pump Sauce" "Shooters Watermelon Marg Liquid Supplement Hydration Boost"
 * 
 * Requires: SEARCHAPI_KEY in .env
 */

import 'dotenv/config';
import { searchGoogleShopping } from '../src/lib/google-shopping-search.js';
import { fetchSoldPriceStats } from '../src/lib/pricing/ebay-sold-prices.js';
import { getDeliveredPricing } from '../src/lib/delivered-pricing.js';

async function debugPricing(brand: string, productName: string) {
  console.log('='.repeat(80));
  console.log('PRICING DEBUG');
  console.log('='.repeat(80));
  console.log(`Brand: "${brand}"`);
  console.log(`Product: "${productName}"`);
  console.log(`Search Query: "${brand} ${productName}"`);
  console.log('');
  
  // Step 1: Google Shopping Search
  console.log('\n' + '='.repeat(80));
  console.log('STEP 1: GOOGLE SHOPPING SEARCH');
  console.log('='.repeat(80));
  
  const googleResult = await searchGoogleShopping(brand, productName);
  
  console.log('\n--- Summary ---');
  console.log(`Amazon: ${googleResult.amazonPrice ? '$' + googleResult.amazonPrice.toFixed(2) : 'NOT FOUND'}`);
  console.log(`Walmart: ${googleResult.walmartPrice ? '$' + googleResult.walmartPrice.toFixed(2) : 'NOT FOUND'}`);
  console.log(`Target: ${googleResult.targetPrice ? '$' + googleResult.targetPrice.toFixed(2) : 'NOT FOUND'}`);
  console.log(`Lowest Retail: ${googleResult.lowestRetailPrice ? '$' + googleResult.lowestRetailPrice.toFixed(2) + ' from ' + googleResult.lowestRetailSource : 'NOT FOUND'}`);
  console.log(`Best Price: ${googleResult.bestPrice ? '$' + googleResult.bestPrice.toFixed(2) + ' from ' + googleResult.bestPriceSource : 'NOT FOUND'}`);
  console.log(`Confidence: ${googleResult.confidence}`);
  console.log(`Reasoning: ${googleResult.reasoning}`);
  
  console.log('\n--- All Results (title-matched) ---');
  if (googleResult.allResults.length === 0) {
    console.log('NO RESULTS MATCHED TITLE');
  } else {
    googleResult.allResults.forEach((r, i) => {
      console.log(`${i + 1}. $${r.extracted_price?.toFixed(2) || 'N/A'} - ${r.seller || 'Unknown'}`);
      console.log(`   Title: ${(r.title || '').substring(0, 70)}`);
    });
  }
  
  // Step 2: eBay Sold Prices
  console.log('\n' + '='.repeat(80));
  console.log('STEP 2: EBAY SOLD PRICES');
  console.log('='.repeat(80));
  
  const soldResult = await fetchSoldPriceStats({
    title: productName,
    brand: brand,
    condition: 'NEW',
  });
  
  console.log('\n--- Summary ---');
  console.log(`Found: ${soldResult.ok ? 'YES' : 'NO'}`);
  console.log(`Sample Count: ${soldResult.samplesCount || 0}`);
  console.log(`Item Median: ${soldResult.median ? '$' + soldResult.median.toFixed(2) : 'N/A'}`);
  console.log(`Delivered Median: ${soldResult.deliveredMedian ? '$' + soldResult.deliveredMedian.toFixed(2) : 'N/A'}`);
  console.log(`Avg Shipping: ${soldResult.avgShipping ? '$' + soldResult.avgShipping.toFixed(2) : 'N/A'}`);
  
  if (soldResult.samples && soldResult.samples.length > 0) {
    console.log('\n--- Samples ---');
    soldResult.samples.forEach((s, i) => {
      console.log(`${i + 1}. Item: $${s.price.toFixed(2)} + Ship: $${s.shipping.toFixed(2)} = Delivered: $${s.deliveredPrice.toFixed(2)}`);
    });
  }
  
  // Step 3: Full Pricing Decision
  console.log('\n' + '='.repeat(80));
  console.log('STEP 3: FINAL PRICING DECISION');
  console.log('='.repeat(80));
  
  const decision = await getDeliveredPricing(brand, productName, {
    mode: 'market-match',
    minItemCents: 499,
    lowPriceMode: 'FLAG_ONLY',
    useSmartShipping: true,
  });
  
  console.log('\n--- Final Decision ---');
  console.log(`Final Item Price: $${(decision.finalItemCents / 100).toFixed(2)}`);
  console.log(`Final Ship Price: $${(decision.finalShipCents / 100).toFixed(2)}`);
  console.log(`Total Delivered: $${((decision.finalItemCents + decision.finalShipCents) / 100).toFixed(2)}`);
  console.log(`Can Compete: ${decision.canCompete}`);
  console.log(`Skip Listing: ${decision.skipListing}`);
  console.log(`Free Ship Applied: ${decision.freeShipApplied}`);
  console.log(`Subsidy: $${(decision.subsidyCents / 100).toFixed(2)}`);
  console.log(`Warnings: ${decision.warnings.join(', ') || 'none'}`);
  console.log(`Comps Source: ${decision.compsSource}`);
  
  console.log('\n--- Price Components ---');
  console.log(`Amazon: ${decision.amazonPriceCents ? '$' + (decision.amazonPriceCents / 100).toFixed(2) : 'N/A'}`);
  console.log(`Walmart: ${decision.walmartPriceCents ? '$' + (decision.walmartPriceCents / 100).toFixed(2) : 'N/A'}`);
  console.log(`eBay Floor: ${decision.activeFloorDeliveredCents ? '$' + (decision.activeFloorDeliveredCents / 100).toFixed(2) : 'N/A'}`);
  console.log(`eBay Median: ${decision.activeMedianDeliveredCents ? '$' + (decision.activeMedianDeliveredCents / 100).toFixed(2) : 'N/A'}`);
  console.log(`Sold Median: ${decision.soldMedianDeliveredCents ? '$' + (decision.soldMedianDeliveredCents / 100).toFixed(2) : 'N/A'}`);
  console.log(`Sold Count: ${decision.soldCount}`);
  console.log(`Sold Strong: ${decision.soldStrong}`);
  console.log(`Target Delivered: $${(decision.targetDeliveredCents / 100).toFixed(2)}`);
  
  console.log('\n' + '='.repeat(80));
  console.log('DEBUG COMPLETE');
  console.log('='.repeat(80));
}

// Parse command line args
const args = process.argv.slice(2);
if (args.length < 2) {
  console.log('Usage: npx tsx scripts/debug-pricing.ts "Brand" "Product Name"');
  console.log('');
  console.log('Example:');
  console.log('  npx tsx scripts/debug-pricing.ts "Pump Sauce" "Shooters Watermelon Marg Liquid Supplement Hydration Boost"');
  process.exit(1);
}

const brand = args[0];
const productName = args[1];

debugPricing(brand, productName).catch(console.error);
