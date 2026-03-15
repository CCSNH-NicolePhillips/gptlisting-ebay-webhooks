#!/usr/bin/env tsx
/**
 * Bust stale price-cache entries for the 5 flagged drafts.
 *
 * Run after a pricing code change to force a fresh lookup on next draft creation.
 * Usage:  npx tsx scripts/bust-price-cache.ts
 */
import 'dotenv/config';
import { makePriceSig, getCachedPrice, deleteCachedPrice } from '../src/lib/price-cache.js';

const ENTRIES = [
  { brand: 'Cymbiotika',    title: 'Irish Sea Moss Lemon Vanilla Powder Supplement' },
  { brand: 'Triquetra',     title: '5-MTHF L-Methylfolate Berry Powder Supplement' },
  { brand: 'Plant People',  title: 'Wonder Sleep Wild Elderberry Capsules' },
  { brand: 'Viv',           title: 'Menstrual Disc Starter Kit' },
  { brand: "Sha's Organic", title: 'Acne Pore Cleanser' },
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
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
