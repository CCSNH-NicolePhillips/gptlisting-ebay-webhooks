/**
 * Clear price cache for a specific product
 */
import 'dotenv/config';
import { makePriceSig } from '../src/lib/price-cache.js';

const BASE = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function clearCache(brand: string, title: string) {
  const sig = makePriceSig(brand, title);
  const key = `msrp:${sig}`;
  
  console.log(`Clearing cache for: ${brand} - ${title}`);
  console.log(`Cache key: ${key}`);
  
  const response = await fetch(`${BASE}/del/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${TOKEN}` }
  });
  
  const result = await response.json();
  console.log('Result:', result);
}

// Clear cache for test products
async function main() {
  await clearCache('Needed', 'Collagen Protein 15.9 oz');
  await clearCache('needed', 'Collagen Protein 15.9 oz');
  await clearCache('Needed', 'Collagen Protein');
  console.log('\nCache cleared!');
}

main().catch(console.error);
