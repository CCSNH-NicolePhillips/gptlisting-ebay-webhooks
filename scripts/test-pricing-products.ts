#!/usr/bin/env tsx
/**
 * Pricing V2 Product Test Matrix
 *
 * Tests real products through the full pricing pipeline (V2 when DP_PRICING_V2=true)
 * and validates that outputs fall within expected ranges.
 *
 * Usage:
 *   npx tsx scripts/test-pricing-products.ts
 *
 * Requires env vars: SEARCHAPI_KEY (for Google Shopping / eBay sold comps)
 * Optional: DP_PRICING_V2=true (test V2 pipeline — default tests whatever is active)
 *
 * Each product has:
 *   - brand / productName (as they'd appear in our listings)
 *   - amazonPriceDollars (expected retail reference)
 *   - expectedRange [min, max] in dollars — the price we SHOULD produce
 *   - notes for context
 */

import 'dotenv/config';
import { quickPrice } from '../src/lib/delivered-pricing.js';

// ── Product Test Matrix ──────────────────────────────────────────────────────

interface ProductTest {
  brand: string;
  productName: string;
  amazonPriceDollars: number;
  expectedRange: [number, number]; // [minDollars, maxDollars]
  notes: string;
}

const PRODUCTS: ProductTest[] = [
  {
    brand: 'MaryRuth Organics',
    productName: 'Womens Multivitamin Hair Growth Liposomal',
    amazonPriceDollars: 38.97,
    expectedRange: [22, 36],
    notes: 'KNOWN BUG — V2 was producing $11.09. Should be $25-35.',
  },
  {
    brand: "Panda's Promise",
    productName: 'Batana Oil Shampoo & Conditioner Set Hair Care Duo',
    amazonPriceDollars: 23.90,
    expectedRange: [14, 22],
    notes: 'New/niche brand. Likely few eBay comps → retail fallback expected.',
  },
  {
    brand: 'Milamend',
    productName: 'Hormone Balance Mixed Berry Powder Supplement',
    amazonPriceDollars: 77.00,
    expectedRange: [34, 55],
    notes: '29 cleaned sold. P35=$37.46, P50=$44.28. Brand site $154. Wide IQR.',
  },
  {
    brand: 'Global Healing',
    productName: 'Lithium Orotate 10mg Mood Balance Calm Support Capsules',
    amazonPriceDollars: 19.96,
    expectedRange: [20, 30],
    notes: '41 cleaned sold. P35=$26.24. Brand site $49.95. eBay prices above Amazon — niche markup.',
  },
  {
    brand: 'Pump Sauce',
    productName: 'Shooters Watermelon Margarita Liquid Supplement',
    amazonPriceDollars: 37.99,
    expectedRange: [10, 25],
    notes: '0 cleaned sold. Brand site $23.99. Amazon mismatches. Retail fallback ~$17.',
  },
  {
    brand: 'Peach & Lily',
    productName: 'Glass Skin Discovery Kit',
    amazonPriceDollars: 39.00,
    expectedRange: [27, 39],
    notes: '47 cleaned sold. P35=$32.99. Brand site $39, Amazon $39. Retail cap should be gentle with 47 samples.',
  },
  {
    brand: 'HumanN',
    productName: 'SuperBeets Heart Chews Pomegranate Berry',
    amazonPriceDollars: 39.95,
    expectedRange: [26, 40],
    notes: '44 cleaned sold. P35=$36.22. Brand site $33.96. Walmart may match wrong product (Gummies vs Chews) capping at ~$27.',
  },
  {
    brand: 'BioDance',
    productName: 'Bio Collagen Real Deep Mask',
    amazonPriceDollars: 19.00,
    expectedRange: [14, 20],
    notes: '46 cleaned sold. P35=$25.51. Amazon $19.00. 100% retail cap with strong sold data → $19.',
  },
  {
    brand: 'r.e.m. beauty',
    productName: 'Wicked Luxury Beautification Undereye Masks',
    amazonPriceDollars: 30.00,
    expectedRange: [13, 25],
    notes: '0 cleaned sold. Brand site $30. Amazon mismatches. Retail fallback expected.',
  },
];

// ── Runner ───────────────────────────────────────────────────────────────────

async function testProduct(product: ProductTest, index: number): Promise<{
  product: ProductTest;
  result: Awaited<ReturnType<typeof quickPrice>>;
  passed: boolean;
  error?: string;
}> {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  [${index + 1}/${PRODUCTS.length}] ${product.brand} — ${product.productName}`);
  console.log(`  Amazon: $${product.amazonPriceDollars.toFixed(2)} | Expected: $${product.expectedRange[0]}-$${product.expectedRange[1]}`);
  console.log(`  Notes: ${product.notes}`);
  console.log('═'.repeat(70));

  try {
    const result = await quickPrice(product.brand, product.productName, 'market-match');

    const deliveredPrice = result.deliveredPrice;
    const [minExpected, maxExpected] = product.expectedRange;
    const inRange = deliveredPrice >= minExpected && deliveredPrice <= maxExpected;

    const status = inRange ? '✅ PASS' : '❌ FAIL';
    console.log(`\n  ${status}: $${deliveredPrice.toFixed(2)} delivered (item $${result.itemPrice.toFixed(2)} + ship $${result.shippingPrice.toFixed(2)})`);
    console.log(`  Confidence: ${result.confidence} | Can compete: ${result.canCompete} | Free ship: ${result.freeShipApplied}`);

    if (result.warnings.length > 0) {
      console.log(`  Warnings: ${result.warnings.join(', ')}`);
    }

    if (!inRange) {
      const direction = deliveredPrice < minExpected ? 'TOO LOW' : 'TOO HIGH';
      console.log(`  ⚠️  ${direction}: $${deliveredPrice.toFixed(2)} outside [$${minExpected}, $${maxExpected}]`);
    }

    return { product, result, passed: inRange };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.log(`\n  💥 ERROR: ${errorMsg}`);
    return {
      product,
      result: {
        itemPrice: 0, shippingPrice: 0, deliveredPrice: 0,
        confidence: 'low', canCompete: false, skipListing: true,
        freeShipApplied: false, warnings: [errorMsg],
      },
      passed: false,
      error: errorMsg,
    };
  }
}

async function main() {
  const v2 = process.env.DP_PRICING_V2 === 'true';
  console.log('\n' + '╔' + '═'.repeat(68) + '╗');
  console.log('║  PRICING V2 PRODUCT TEST MATRIX' + ' '.repeat(36) + '║');
  console.log(`║  Pipeline: ${v2 ? 'V2 (graduated tiers)' : 'V1 (legacy)'}` + ' '.repeat(v2 ? 34 : 43) + '║');
  console.log(`║  Products: ${PRODUCTS.length}` + ' '.repeat(55) + '║');
  console.log('╚' + '═'.repeat(68) + '╝');

  const results: Awaited<ReturnType<typeof testProduct>>[] = [];

  // Run sequentially to avoid rate limits on external APIs
  for (let i = 0; i < PRODUCTS.length; i++) {
    const result = await testProduct(PRODUCTS[i], i);
    results.push(result);
  }

  // ── Summary ──
  console.log('\n\n' + '═'.repeat(70));
  console.log('  SUMMARY');
  console.log('═'.repeat(70));

  const passed = results.filter(r => r.passed);
  const failed = results.filter(r => !r.passed);

  console.log(`\n  ${passed.length}/${results.length} products priced within expected range\n`);

  // Table
  console.log('  ┌─────────────────────────────────┬──────────┬───────────────┬────────┐');
  console.log('  │ Product                         │ Delivered│ Expected      │ Status │');
  console.log('  ├─────────────────────────────────┼──────────┼───────────────┼────────┤');

  for (const r of results) {
    const name = `${r.product.brand} ${r.product.productName}`.slice(0, 31).padEnd(31);
    const price = `$${r.result.deliveredPrice.toFixed(2)}`.padStart(8);
    const range = `$${r.product.expectedRange[0]}-$${r.product.expectedRange[1]}`.padEnd(13);
    const status = r.error ? '💥 ERR' : r.passed ? '✅ OK ' : '❌ FAIL';
    console.log(`  │ ${name} │ ${price} │ ${range} │ ${status} │`);
  }

  console.log('  └─────────────────────────────────┴──────────┴───────────────┴────────┘');

  if (failed.length > 0) {
    console.log(`\n  ❌ ${failed.length} FAILURES:`);
    for (const f of failed) {
      const price = f.result.deliveredPrice;
      const [min, max] = f.product.expectedRange;
      const direction = f.error ? 'ERROR' : price < min ? 'TOO LOW' : 'TOO HIGH';
      console.log(`     - ${f.product.brand}: $${price.toFixed(2)} (${direction}, expected $${min}-$${max})`);
      if (f.error) console.log(`       Error: ${f.error}`);
    }
  }

  console.log('');
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(2);
});
