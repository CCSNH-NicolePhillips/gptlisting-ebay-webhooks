import 'dotenv/config';
import { lookupPrice } from './dist/src/lib/price-lookup.js';

// Test with the exact Vita PLynxera product
const testProduct = {
  brand: 'Vita PLynxera',
  title: 'Myo & D-Chiro Inositol',
  category: 'Health & Beauty > Vitamins & Lifestyle Supplements > Vitamins & Minerals',
  visionData: {
    brandWebsite: 'https://vitaplynxera.com/myo-d-chiro-inositol.html'
  }
};

console.log('Testing Vita PLynxera pricing...\n');
console.log('Product:', testProduct);
console.log('\n' + '='.repeat(80) + '\n');

try {
  const result = await lookupPrice(testProduct);
  
  console.log('\n' + '='.repeat(80));
  console.log('RESULT:');
  console.log('='.repeat(80));
  console.log(JSON.stringify(result, null, 2));
  
  if (result.ok && result.price) {
    console.log('\n✅ SUCCESS: Price found: $' + result.price.toFixed(2));
    console.log('Source:', result.source);
    console.log('Notes:', result.notes);
  } else {
    console.log('\n❌ FAILED: No price found');
    console.log('Error:', result.error);
  }
  
} catch (error) {
  console.error('\n❌ ERROR:', error.message);
  console.error(error.stack);
}
