#!/usr/bin/env tsx
/**
 * Focused test for JYM Pre-Workout pricing
 * Tests Fix 2: Amazon prices should NOT be discounted
 */

import { lookupPrice } from '../src/lib/price-lookup.js';

async function testJYM() {
  console.log('='.repeat(80));
  console.log('Testing JYM Pre-Workout Pricing');
  console.log('Expected: Amazon $54.99, Final eBay item price ~$48.99 (+ $6 shipping = $54.99 delivered)');
  console.log('='.repeat(80));
  console.log('');

  const result = await lookupPrice({
    title: 'JYM Supplement Science Pre-Workout Juicy Orange 31.7 oz',
    brand: 'JYM',
    productName: 'Pre-Workout Juicy Orange',
    netWeight: '31.7 oz',
    keyText: ['JYM', 'Pre-Workout', 'Juicy Orange', '31.7 oz', 'Pre JYM'],
    condition: 'NEW',
    categoryPath: 'Health & Personal Care > Vitamins & Dietary Supplements',
    quantity: 1,
    pricingSettings: {
      discountPercent: 10, // Should be ignored for Amazon source
      shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
      templateShippingEstimateCents: 600, // $6 shipping
      shippingSubsidyCapCents: null,
    },
    skipCache: true,
  });

  console.log('');
  console.log('='.repeat(80));
  console.log('RESULT:');
  console.log('='.repeat(80));
  
  if (result.ok) {
    console.log(`✓ Price lookup successful`);
    console.log(`  Source: ${result.source}`);
    console.log(`  Base price: $${result.chosen?.price.toFixed(2) || 'N/A'}`);
    console.log(`  eBay item price: $${result.recommendedListingPrice?.toFixed(2)}`);
    console.log(`  Confidence: ${result.confidence}`);
    console.log(`  Reason: ${result.reason}`);
    console.log('');
    
    // Validation
    console.log('VALIDATION:');
    
    if (result.source === 'amazon') {
      console.log(`  ✓ Source is Amazon (correct)`);
      
      const basePrice = result.chosen?.price || 0;
      const itemPrice = result.recommendedListingPrice || 0;
      const templateShipping = 6.00;
      const deliveredTotal = itemPrice + templateShipping;
      
      console.log(`  Base (Amazon retail): $${basePrice.toFixed(2)}`);
      console.log(`  eBay item price: $${itemPrice.toFixed(2)}`);
      console.log(`  + Template shipping: $${templateShipping.toFixed(2)}`);
      console.log(`  = Delivered total: $${deliveredTotal.toFixed(2)}`);
      
      const deliveredDiff = Math.abs(deliveredTotal - basePrice);
      if (deliveredDiff < 0.50) {
        console.log(`  ✓ Delivered total matches Amazon (diff: $${deliveredDiff.toFixed(2)})`);
        console.log('');
        console.log('✅ TEST PASSED: No discount applied to Amazon price');
      } else {
        console.log(`  ❌ Delivered total doesn't match Amazon (diff: $${deliveredDiff.toFixed(2)})`);
        console.log('');
        console.log('❌ TEST FAILED: Amazon price was discounted');
      }
    } else {
      console.log(`  ❌ Source is ${result.source}, expected 'amazon'`);
      console.log('');
      console.log('❌ TEST FAILED: Amazon source not used');
    }
  } else {
    console.log(`❌ Price lookup failed`);
    console.log(`  Error: ${result.error}`);
  }
  
  console.log('='.repeat(80));
}

testJYM().catch(console.error);
