import 'dotenv/config';
import { lookupPrice } from '../src/lib/price-lookup.js';
import { extractPriceWithShipping } from '../src/lib/html-price.js';

async function run() {
  console.log('--- TEST 1: Net Weight ---');
  await lookupPrice({
    brand: 'BetterAlt',
    title: 'Testo Pro 90 Capsules',
    netWeight: { value: 90, unit: 'capsules' }, 
    keyText: ['Testo Pro'],
    skipCache: true
  });

  console.log('--- TEST 2: Pack Regex ---');
  const title = 'Product Name Box of 12';
  const result = extractPriceWithShipping(`<html><h1>${title}</h1></html>`, title);
  console.log('Box of 12 detected as:', result?.packQty);
}
run();
