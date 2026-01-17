#!/usr/bin/env tsx
import 'dotenv/config';
import { getDeliveredPricing } from '../src/lib/delivered-pricing.js';

async function main() {
  console.log('Checking r.e.m. beauty pricing...\n');
  
  const result = await getDeliveredPricing(
    'r.e.m. beauty',
    'Wicked Luxury Beautification Undereye Masks 6 Pairs',
    { mode: 'market-match', shippingEstimateCents: 600, minItemCents: 499, useSmartShipping: true }
  );

  console.log('\n=== FINAL RESULT ===');
  console.log('Final Item Price: $' + (result.finalItemCents / 100).toFixed(2));
  console.log('Final Ship Price: $' + (result.finalShipCents / 100).toFixed(2));
  console.log('Total Delivered: $' + ((result.finalItemCents + result.finalShipCents) / 100).toFixed(2));
  console.log('Amazon:', result.amazonPriceCents ? '$' + (result.amazonPriceCents / 100).toFixed(2) : 'not found');
  console.log('Walmart:', result.walmartPriceCents ? '$' + (result.walmartPriceCents / 100).toFixed(2) : 'not found');
  console.log('eBay Floor:', result.activeFloorDeliveredCents ? '$' + (result.activeFloorDeliveredCents / 100).toFixed(2) : 'not found');
  console.log('Sold Median:', result.soldMedianDeliveredCents ? '$' + (result.soldMedianDeliveredCents / 100).toFixed(2) : 'not found');
  console.log('Sold Count:', result.soldCount);
  console.log('Confidence:', result.matchConfidence);
  console.log('Warnings:', result.warnings);
}

main().catch(console.error);
