import "dotenv/config";
import { deleteCachedPrice, makePriceSig } from '../src/lib/price-cache.js';

const products = [
  { brand: 'Too Faced', title: 'Born This Way The Natural Nudes' },
  { brand: 'bettr.', title: 'Morning Complete Strawberry Mango' },
  { brand: 'BetterAlt', title: 'Testo Pro 90 Capsules' },
  { brand: 'Needed', title: 'Collagen Protein' },
  { brand: 'Jarrow Formulas', title: 'Fem Dophilus Ultra 50 Billion CFU 30 Capsules' },
  { brand: 'Frog Fuel', title: 'Ultra Energized' },
];

async function main() {
  console.log('Clearing price cache for discrepancy products...\n');
  
  for (const p of products) {
    const sig = makePriceSig(p.brand, p.title);
    console.log(`Clearing: ${p.brand} | sig: ${sig}`);
    const deleted = await deleteCachedPrice(sig);
    console.log(`  Result: ${deleted ? '✓ Deleted' : '✗ Not found'}`);
  }
  
  console.log('\nDone!');
}

main().catch(console.error);
