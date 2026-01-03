/**
 * Clear price cache for the Neuro D3K2 product
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
  return result;
}

async function main() {
  await clearCache('Neuro', 'Vita+Mints Vitamins D3 & K2 mints 90 Pieces');
  console.log('\nCache cleared!');
}

main().catch(console.error);
