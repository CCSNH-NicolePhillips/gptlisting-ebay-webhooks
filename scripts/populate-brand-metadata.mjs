#!/usr/bin/env node
import { setBrandMetadata } from '../dist/src/lib/brand-map.js';

/**
 * Populate initial brand metadata database
 * Add brands as you discover them - no more hardcoding!
 */

const brandMetadata = [
  // Supplements
  { brand: 'root', productType: 'vitamin supplement' },
  { brand: 'jocko', productType: 'vitamin supplement' },
  { brand: 'naked', productType: 'vitamin supplement' },
  { brand: 'rkmd', productType: 'vitamin supplement' },
  { brand: 'vita plynxera', productType: 'vitamin supplement' },
  
  // Sports Nutrition
  { brand: 'ryse', productType: 'sports nutrition supplement' },
  
  // Skincare
  { brand: 'prequel', productType: 'skincare beauty' },
  { brand: 'oganacell', productType: 'skincare beauty' },
  { brand: 'evereden', productType: 'skincare beauty' },
  
  // Bath & Body
  { brand: 'maude', productType: 'bath body' },
];

async function main() {
  console.log('Populating brand metadata database...\n');
  
  for (const { brand, productType, category, notes } of brandMetadata) {
    console.log(`Setting: ${brand} → ${productType}`);
    await setBrandMetadata(brand, { productType, category, notes });
  }
  
  console.log(`\n✓ Successfully populated ${brandMetadata.length} brand metadata entries`);
  console.log('\nTo add more brands in the future, just add them to this script and run it again.');
  console.log('Or create a UI to manage brand metadata via the database.');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
