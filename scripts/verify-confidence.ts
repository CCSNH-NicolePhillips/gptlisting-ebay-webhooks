import 'dotenv/config';
import { lookupPrice } from '../src/lib/price-lookup.js';

async function run() {
  console.log('--- TEST: Confidence Scoring ---');
  // Use Cymbiotika - known to find Amazon match
  await lookupPrice({
    brand: 'Cymbiotika',
    title: 'Liposomal Magnesium L-Threonate',
    netWeight: { value: 280, unit: 'ml' },
    keyText: ['Liposomal', 'Magnesium'],
    skipCache: true
  });
}
run();
