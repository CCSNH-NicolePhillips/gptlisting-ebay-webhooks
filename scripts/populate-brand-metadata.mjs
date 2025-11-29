#!/usr/bin/env node
import { setBrandMetadata } from '../dist/src/lib/brand-map.js';

/**
 * Populate initial brand metadata database
 * Supports brands with multiple product types using pattern matching
 */

const brandMetadata = [
  // Single product type brands
  { 
    brand: 'root', 
    defaultProductType: 'vitamin supplement',
    brandWebsite: 'https://therootbrands.com',
    ebayCategory: '180959' // Vitamins & Dietary Supplements
  },
  { brand: 'jocko', defaultProductType: 'vitamin supplement' },
  { brand: 'naked', defaultProductType: 'vitamin supplement' },
  { brand: 'rkmd', defaultProductType: 'vitamin supplement' },
  { brand: 'vita plynxera', defaultProductType: 'vitamin supplement' },
  { brand: 'ryse', defaultProductType: 'sports nutrition supplement' },
  { brand: 'prequel', defaultProductType: 'skincare beauty' },
  { brand: 'oganacell', defaultProductType: 'skincare beauty' },
  { brand: 'evereden', defaultProductType: 'skincare beauty' },
  { brand: 'maude', defaultProductType: 'bath body' },
  
  // Example: Multi-category brand (if a brand sells both supplements AND skincare)
  // {
  //   brand: 'example-brand',
  //   defaultProductType: 'vitamin supplement', // Default if no pattern matches
  //   productPatterns: [
  //     { keywords: ['serum', 'cream', 'lotion'], productType: 'skincare beauty' },
  //     { keywords: ['vitamin', 'capsule', 'supplement'], productType: 'vitamin supplement' },
  //     { keywords: ['protein', 'pre workout'], productType: 'sports nutrition supplement' }
  //   ]
  // }
];

async function main() {
  console.log('Populating brand metadata database...\n');
  
  for (const metadata of brandMetadata) {
    const { brand, defaultProductType, productPatterns } = metadata;
    
    if (productPatterns) {
      console.log(`Setting: ${brand} (multi-type with ${productPatterns.length} patterns)`);
      productPatterns.forEach(p => {
        console.log(`  - ${p.keywords.join(', ')} → ${p.productType}`);
      });
      if (defaultProductType) {
        console.log(`  - default → ${defaultProductType}`);
      }
    } else {
      console.log(`Setting: ${brand} → ${defaultProductType}`);
    }
    
    await setBrandMetadata(brand, metadata);
  }
  
  console.log(`\n✓ Successfully populated ${brandMetadata.length} brand metadata entries`);
  console.log('\nTo add more brands in the future, just add them to this script and run it again.');
  console.log('Or create a UI to manage brand metadata via the database.');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
