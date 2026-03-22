#!/usr/bin/env tsx
/**
 * Bust stale price-cache entries for flagged drafts.
 *
 * Run after a pricing code change to force a fresh lookup on next draft creation.
 * Usage:  npx tsx scripts/bust-price-cache.ts
 */
import 'dotenv/config';
import { makePriceSig, getCachedPrice, deleteCachedPrice } from '../src/lib/price-cache.js';
import { deleteAmazonAsin, saveAmazonAsin } from '../src/lib/brand-registry.js';

const ENTRIES = [
  { brand: 'Cymbiotika',    title: 'Irish Sea Moss Lemon Vanilla Powder Supplement' },
  { brand: 'Triquetra',     title: '5-MTHF L-Methylfolate Berry Powder Supplement' },
  { brand: 'Plant People',  title: 'Wonder Sleep Wild Elderberry Capsules' },
  { brand: 'Viv',           title: 'Menstrual Disc Starter Kit' },
  { brand: "Sha's Organic", title: 'Acne Pore Cleanser' },
  { brand: 'Root',          title: 'ReLive Greens' },
  { brand: 'Nello',         title: 'SuperCalm' },
  { brand: 'Makeup Eraser', title: '7-Day Set' },
];

// Correct ASIN pins — overwrite any bad auto-discovered ASIN with the verified one
const ASIN_PINS: { brand: string; product: string; asin: string }[] = [
  { brand: 'Root', product: 'ReLive Greens', asin: 'B0BQ2YY5YB' },
  // ki Vinoreset — pin multiple product name variations
  { brand: 'ki',   product: 'Vinoreset Mist',      asin: 'B0G442H9RZ' },
  { brand: 'ki',   product: 'Vinoreset Face Mist',  asin: 'B0G442H9RZ' },
  // Nello SuperCalm — pin 30-serving version ($44.95). Keyword search returns the
  // 20-serving ($39.95) which is wrong. All 30-serving flavors are same price.
  { brand: 'Nello', product: 'SuperCalm', asin: 'B0FJ31ZMHX' },
  // Makeup Eraser 7-Day Set — Rainforest picks the cheapest color variant ($12.69).
  // Pin the standard product ASIN B0CDNHHB2Z ($25). Product key matches the
  // keyText disambiguation fix which sends productName="7-Day Set" to search.
  { brand: 'Makeup Eraser', product: '7-Day Set', asin: 'B0CDNHHB2Z' },
];

async function main() {
  console.log('\nPrice Cache Buster\n' + '─'.repeat(60));

  for (const e of ENTRIES) {
    const sig = makePriceSig(e.brand, e.title);
    const cached = await getCachedPrice(sig);

    if (!cached) {
      console.log(`  ○ Not cached: ${e.brand} — ${e.title}`);
      console.log(`    sig: ${sig}`);
      continue;
    }

    const msrp = cached.msrpCents ? `$${(cached.msrpCents / 100).toFixed(2)}` : '(no MSRP)';
    const source = cached.chosen?.source ?? cached.source ?? '?';
    console.log(`  ✗ Found stale cache: ${e.brand} — ${e.title}`);
    console.log(`    sig:    ${sig}`);
    console.log(`    cached: ${msrp}  source=${source}  ts=${cached.ts ? new Date(cached.ts).toISOString() : '?'}`);

    const deleted = await deleteCachedPrice(sig);
    console.log(`    ${deleted ? '✅ Deleted' : '❌ Delete failed'}`);
  }

  console.log('\nDone. Next pricing run will fetch fresh data.\n');

  // ── Pin correct ASINs ────────────────────────────────────────────────────
  if (ASIN_PINS.length > 0) {
    console.log('ASIN Pins\n' + '─'.repeat(60));
    for (const p of ASIN_PINS) {
      // Delete any wrongly auto-discovered ASIN first
      await deleteAmazonAsin(p.brand, p.product);
      // Save the verified correct one
      await saveAmazonAsin(p.brand, p.product, p.asin, true);
      console.log(`  ✅ Pinned ASIN ${p.asin} → ${p.brand} ${p.product}`);
    }
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
