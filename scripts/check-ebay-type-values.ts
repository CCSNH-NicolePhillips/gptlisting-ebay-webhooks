/**
 * Check what values eBay accepts for Type, Volume, Item Weight in Dietary Supplements category
 */

import { fetchCategoryAspects } from '../src/lib/ebay-category-aspects.js';

async function main() {
  const categoryId = '180960'; // Dietary Supplements
  
  console.log(`Fetching aspects for category ${categoryId}...\n`);
  
  const result = await fetchCategoryAspects(categoryId);
  
  if (!result) {
    console.error('Failed to fetch aspects');
    return;
  }
  
  // Find the aspects we're interested in
  const aspectNames = ['Type', 'Volume', 'Item Weight', 'Formulation', 'Flavor'];
  
  for (const name of aspectNames) {
    const aspect = result.all.find(a => a.name === name);
    if (aspect) {
      console.log(`=== ${name} ===`);
      console.log(`  Required: ${aspect.required}`);
      console.log(`  Mode: ${aspect.mode}`);
      console.log(`  Multi: ${aspect.multi}`);
      console.log(`  Values (${aspect.values.length}):`);
      aspect.values.forEach((v, i) => {
        if (i < 30) console.log(`    - ${v}`);
      });
      if (aspect.values.length > 30) {
        console.log(`    ... and ${aspect.values.length - 30} more`);
      }
      console.log('');
    } else {
      console.log(`=== ${name} === NOT FOUND\n`);
    }
  }
}

main().catch(console.error);
