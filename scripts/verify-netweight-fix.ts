import 'dotenv/config';
import { lookupPrice } from '../src/lib/price-lookup.js';

async function verifyFix() {
  console.log('🧪 VERIFICATION: Testing netWeight enforcement...');

  // Use Cymbiotika Magnesium - known to be on Amazon
  await lookupPrice({
    brand: 'Cymbiotika',
    title: 'Liposomal Magnesium L-Threonate',
    // This input MUST trigger the "[price-debug] Enforcing netWeight..." log
    netWeight: { value: 280, unit: 'ml' },
    keyText: ['Liposomal', 'Magnesium'],
  });
}

verifyFix().catch(console.error);
