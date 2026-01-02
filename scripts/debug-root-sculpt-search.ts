#!/usr/bin/env tsx
/**
 * Debug Root Sculpt brand search
 */

import { braveFirstUrlForBrandSite } from '../src/lib/search.js';
import { extractPriceFromBrand } from '../src/lib/html-price.js';

async function debugRootSculpt() {
  console.log('Testing Root Sculpt brand search...\n');
  
  // Test 1: Brave search
  console.log('Step 1: Brave search for Root brand site');
  const url = await braveFirstUrlForBrandSite(
    'Root',
    'Root Sculpt Dietary Supplement 60 Capsules for Weight Management Support'
  );
  
  if (url) {
    console.log(`✓ Found URL: ${url}\n`);
    
    // Test 2: Extract price
    console.log('Step 2: Extract price from brand URL');
    const price = await extractPriceFromBrand(
      url,
      'Root',
      'Root Sculpt Dietary Supplement 60 Capsules for Weight Management Support'
    );
    
    if (price) {
      console.log(`✓ Extracted price: $${price.toFixed(2)}`);
      
      if (Math.abs(price - 108) < 5) {
        console.log('✅ SUCCESS: Found correct $108 price!');
      } else {
        console.log(`⚠️ WARNING: Price is $${price}, expected ~$108`);
      }
    } else {
      console.log('❌ FAILED: Could not extract price from URL');
    }
  } else {
    console.log('❌ FAILED: Brave search did not find brand URL\n');
    
    // Test manual URL
    console.log('Step 3: Try manual URL therootbrands.com');
    const manualPrice = await extractPriceFromBrand(
      'https://therootbrands.com/product/root-sculpt/',
      'Root',
      'Root Sculpt Dietary Supplement 60 Capsules'
    );
    
    if (manualPrice) {
      console.log(`✓ Manual URL extracted: $${manualPrice.toFixed(2)}`);
    } else {
      console.log('❌ Manual URL also failed');
    }
  }
}

debugRootSculpt().catch(console.error);
