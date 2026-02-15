/**
 * Clear all MaryRuth cached prices from Redis
 */
import 'dotenv/config';
import { makePriceSig, deleteCachedPrice, getCachedPrice } from '../src/lib/price-cache.js';

const variants = [
  ['MaryRuth Organics', "Women's Multivitamin + Hair Growth Liposomal"],
  ['MaryRuth Organics', 'Womens Multivitamin + Hair Growth Liposomal'],
  ['MaryRuth Organics', "Women's Multivitamin Hair Growth Liposomal"],
  ["Mary Ruth's", "Women's Multivitamin + Hair Growth Liposomal"],
  ['MaryRuths', "Women's Multivitamin + Hair Growth Liposomal"],
  ["Mary Ruth's", "Women's Multivitamin + Hair Growth Liposomal Liquid"],
  ['MaryRuth Organics', "Women's Multivitamin + Hair Growth Liposomal Liquid"],
];

async function main() {
  console.log('Clearing MaryRuth price cache entries...\n');
  let found = 0;
  for (const [brand, product] of variants) {
    const sig = makePriceSig(brand, product);
    console.log(`Key: pricecache:${sig}`);
    const cached = await getCachedPrice(sig);
    if (cached) {
      const itemPrice = cached.finalItemCents ? `$${(cached.finalItemCents / 100).toFixed(2)}` : 'unknown';
      console.log(`  FOUND! Cached item price: ${itemPrice}`);
      await deleteCachedPrice(sig);
      console.log(`  DELETED ✅`);
      found++;
    } else {
      console.log(`  (not cached)`);
    }
  }

  // Also scan for any pricecache keys containing "maryruth"
  const BASE = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
  const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
  
  console.log('\nScanning for all maryruth-related cache keys...');
  const scanRes = await fetch(`${BASE}/keys/pricecache:*maryruth*`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const scanData = await scanRes.json();
  const keys = (scanData.result || []) as string[];
  console.log(`Found ${keys.length} additional keys matching *maryruth*`);
  
  for (const key of keys) {
    // Read value first to show what's cached
    const getRes = await fetch(`${BASE}/GET/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const getData = await getRes.json();
    if (getData.result) {
      try {
        const parsed = JSON.parse(getData.result as string);
        const itemPrice = parsed.finalItemCents ? `$${(parsed.finalItemCents / 100).toFixed(2)}` : 'unknown';
        console.log(`  ${key} → item price: ${itemPrice}`);
      } catch {
        console.log(`  ${key} → (unparseable)`);
      }
    }
    
    // Delete it
    await fetch(`${BASE}/DEL/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    console.log(`  DELETED ✅`);
    found++;
  }

  console.log(`\nDone. Cleared ${found} cache entries.`);
  console.log('Next pricing request will recalculate with the new code.');
}

main().catch(console.error);
