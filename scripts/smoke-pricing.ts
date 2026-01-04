/**
 * Smoke Test: Delivered Pricing with Real API Calls
 * 
 * Tests the full pricing pipeline against real products.
 * Requires SEARCHAPI_KEY and optionally EBAY credentials.
 * 
 * Usage: npx tsx scripts/smoke-pricing.ts
 * 
 * @see docs/PRICING-OVERHAUL.md - Phase 5
 */

import { getDeliveredPricing, formatPrice } from '../src/lib/delivered-pricing.js';
import { config } from 'dotenv';

config(); // Load .env

// Test products from real inventory (ebay07 batch)
const TEST_PRODUCTS = [
  { brand: 'BetterAlt', productName: 'Himalayan Shilajit Honey Sticks 30 sticks' },
  { brand: 'Amaa Ayurveda', productName: 'Shilajit Resin 30 Sticks' },
  { brand: 'SNAP Supplements', productName: 'Skin Glow 60 Capsules' },
  { brand: 'Mary Ruth\'s', productName: 'Liquid Nighttime Multimineral + Skin Renew 15.22 fl oz' },
  { brand: 'MaryRuth Organics', productName: 'Vegan Vitamin D3 30 mL' },
  { brand: '10X Health', productName: 'TMG 60 Capsules' },
  { brand: 'Poggers', productName: 'Sleep Drink Mix 30 Servings' },
  { brand: 'Neuro', productName: 'Memory & Focus Gum 90 Pieces' },
  { brand: 'Neuro', productName: 'Neuro Gum 90 Pieces' },
  { brand: 'Neuro', productName: 'Vita+Mints D3 K2 90 Pieces' },
];

interface SmokeResult {
  brand: string;
  productName: string;
  targetDelivered: string;
  finalItem: string;
  finalShip: string;
  totalDelivered: string;
  compsSource: string;
  shippingSource: string;
  confidence: string;
  warnings: string[];
  pass: boolean;
}

async function runSmokeTest(): Promise<void> {
  console.log('='.repeat(80));
  console.log('SMOKE TEST: Delivered-Price-First Pricing Pipeline');
  console.log('='.repeat(80));
  console.log();

  if (!process.env.SEARCHAPI_KEY) {
    console.error('❌ SEARCHAPI_KEY not set. Cannot run smoke test.');
    process.exit(1);
  }

  const results: SmokeResult[] = [];
  let passed = 0;
  let failed = 0;

  for (const product of TEST_PRODUCTS) {
    console.log(`\n📦 Testing: ${product.brand} ${product.productName}`);
    console.log('-'.repeat(60));

    try {
      const decision = await getDeliveredPricing(product.brand, product.productName, {
        mode: 'market-match',
        useSmartShipping: true,
      });

      const totalDelivered = decision.finalItemCents + decision.finalShipCents;
      
      // Validate: should have some pricing data
      const hasData = decision.targetDeliveredCents > 0;
      const isCompetitive = decision.targetDeliveredCents === 0 || 
                           totalDelivered <= decision.targetDeliveredCents + 100; // within $1 of target
      const cannotCompete = decision.warnings.includes('cannotCompete');
      // Pass = has data AND (competitive OR correctly flagged as uncompetitive)
      const pass = hasData && (isCompetitive || cannotCompete);

      const result: SmokeResult = {
        brand: product.brand,
        productName: product.productName,
        targetDelivered: formatPrice(decision.targetDeliveredCents),
        finalItem: formatPrice(decision.finalItemCents),
        finalShip: formatPrice(decision.finalShipCents),
        totalDelivered: formatPrice(totalDelivered),
        compsSource: decision.compsSource,
        shippingSource: decision.shippingEstimateSource,
        confidence: decision.matchConfidence,
        warnings: decision.warnings,
        pass,
      };

      results.push(result);

      console.log(`  Target Delivered: ${result.targetDelivered}`);
      console.log(`  Final:           ${result.finalItem} + ${result.finalShip} = ${result.totalDelivered}`);
      console.log(`  Comps Source:    ${result.compsSource} (${result.confidence} confidence)`);
      console.log(`  Shipping Source: ${result.shippingSource}`);
      console.log(`  eBay Comps:      ${decision.ebayComps.length}`);
      console.log(`  Retail Comps:    ${decision.retailComps.length}`);
      
      if (decision.warnings.length > 0) {
        console.log(`  ⚠️  Warnings:    ${decision.warnings.join(', ')}`);
      }

      if (pass) {
        if (cannotCompete) {
          console.log(`  ⚠️  PASS (flagged - cannot compete at market)`);
        } else {
          console.log(`  ✅ PASS`);
        }
        passed++;
      } else {
        const reason = !hasData ? 'No pricing data' : 
                      !isCompetitive ? `Price $${(totalDelivered/100).toFixed(2)} exceeds target $${(decision.targetDeliveredCents/100).toFixed(2)}` :
                      'Unknown';
        console.log(`  ❌ FAIL: ${reason}`);
        failed++;
      }

      // Rate limit - 1 second between calls
      await new Promise(resolve => setTimeout(resolve, 1000));

    } catch (err) {
      console.log(`  ❌ ERROR: ${err}`);
      results.push({
        brand: product.brand,
        productName: product.productName,
        targetDelivered: 'ERROR',
        finalItem: 'ERROR',
        finalShip: 'ERROR',
        totalDelivered: 'ERROR',
        compsSource: 'error',
        shippingSource: 'error',
        confidence: 'low',
        warnings: [String(err)],
        pass: false,
      });
      failed++;
    }
  }

  // Summary
  console.log('\n' + '='.repeat(80));
  console.log('SUMMARY');
  console.log('='.repeat(80));
  console.log(`Total:  ${TEST_PRODUCTS.length}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log();

  // Results table
  console.log('Product'.padEnd(40) + 'Target'.padEnd(10) + 'Final'.padEnd(15) + 'Source'.padEnd(15) + 'Status');
  console.log('-'.repeat(90));
  
  for (const r of results) {
    const name = `${r.brand} ${r.productName}`.substring(0, 38).padEnd(40);
    const target = r.targetDelivered.padEnd(10);
    const final = `${r.finalItem}+${r.finalShip}`.padEnd(15);
    const source = r.compsSource.padEnd(15);
    const status = r.pass ? '✅' : '❌';
    console.log(`${name}${target}${final}${source}${status}`);
  }

  console.log();
  
  if (failed > 0) {
    console.log(`❌ ${failed} test(s) failed`);
    process.exit(1);
  } else {
    console.log('✅ All tests passed!');
  }
}

runSmokeTest().catch(console.error);
