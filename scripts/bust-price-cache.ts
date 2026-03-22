#!/usr/bin/env tsx
/**
 * Bust stale price-cache entries for flagged drafts.
 *
 * Run after a pricing code change to force a fresh lookup on next draft creation.
 * Usage:  npx tsx scripts/bust-price-cache.ts
 */
import 'dotenv/config';
import { makePriceSig, getCachedPrice, deleteCachedPrice } from '../src/lib/price-cache.js';
import { deleteAmazonAsin, saveAmazonAsin, savePriceOverride, deletePriceOverride } from '../src/lib/brand-registry.js';

const ENTRIES = [
  { brand: 'Cymbiotika',    title: 'Irish Sea Moss Lemon Vanilla Powder Supplement' },
  { brand: 'Triquetra',     title: '5-MTHF L-Methylfolate Berry Powder Supplement' },
  { brand: 'Plant People',  title: 'Wonder Sleep Wild Elderberry Capsules' },
  { brand: 'Viv',           title: 'Menstrual Disc Starter Kit' },
  { brand: "Sha's Organic", title: 'Acne Pore Cleanser' },
  { brand: 'Root',          title: 'ReLive Greens' },
  { brand: 'Nello',         title: 'SuperCalm' },
  { brand: 'Makeup Eraser', title: '7-Day Set' },
  { brand: 'Root',          title: 'Zero-In' },
  { brand: 'Stasis',        title: 'Nighttime' },
];

// Direct price overrides — for DTC-only brands not sold on Amazon.
// Bypasses ALL search steps (Rainforest, Amazon keyword, Google Shopping, Perplexity).
// Use when Perplexity returns an incorrect or inflated price for a DTC brand.
const PRICE_OVERRIDES: { brand: string; product: string; price: number; url?: string; notes?: string }[] = [
  // therootbrands.com Restore product ($74). Root is DTC-only; not on Amazon.
  // Without this: Perplexity fires Step 5 and returns ~$167 (wrong product/bundle).
  { brand: 'Root', product: 'Restore', price: 74, url: 'https://therootbrands.com/products/restore', notes: 'DTC-only. Amazon query returns generic $33 result. Perplexity returned ~$167 (wrong).' },
  // Immerge Health Hersitol ($49.99) — DTC-only, not on Amazon.
  // GPT misclassified as brand="Stasis" productName="Nighttime" (wrong label in photo).
  // Pin both the real name AND the misclassified name so reprice works on existing draft.
  { brand: 'Immerge Health', product: 'Hersitol', price: 49.99, url: 'https://www.immergehealth.com/products/hersitol', notes: 'DTC-only. Not on Amazon.' },
  { brand: 'Stasis', product: 'Nighttime', price: 49.99, url: 'https://www.immergehealth.com/products/hersitol', notes: 'Misclassified as Stasis/Nighttime — actual product is Immerge Health Hersitol ($49.99). DTC-only.' },
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
  // Root Zero-In — keyword search returns a single-serve packet at $14.99 ($12.74 eBay).
  // Correct full-bottle ASIN B0BQ2VT3CB ($97) → eBay ~$76.45.
  { brand: 'Root', product: 'Zero-In', asin: 'B0BQ2VT3CB' },
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

  // ── Price overrides (DTC-only brands) ──────────────────────────────────────
  if (PRICE_OVERRIDES.length > 0) {
    console.log('\nPrice Overrides\n' + '─'.repeat(60));
    for (const p of PRICE_OVERRIDES) {
      await deletePriceOverride(p.brand, p.product);
      await savePriceOverride(p.brand, p.product, p.price, p.url, p.notes);
      console.log(`  ✅ Price override $${p.price} → ${p.brand} ${p.product}${p.url ? ` (${p.url})` : ''}`);
    }
  }

  // ── Pin correct ASINs ────────────────────────────────────────────────────
  if (ASIN_PINS.length > 0) {
    console.log('\nASIN Pins\n' + '─'.repeat(60));
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
