/**
 * Test script to verify category aspects are loaded in Redis
 */

import { getCategoryById, listCategories } from '../src/lib/taxonomy-store.js';

async function testCategoryAspects() {
  console.log('Testing category aspects in taxonomy...\n');
  
  // Test some common categories
  const testCategoryIds = [
    '180960', // Dietary Supplements
    '260817', // Detox & Cleansers
    '168113', // Books
    '177732', // Hair & Makeup Mannequins
  ];
  
  for (const id of testCategoryIds) {
    console.log(`\n=== Category ${id} ===`);
    const cat = await getCategoryById(id);
    
    if (!cat) {
      console.log(`❌ Category ${id} not found in Redis`);
      continue;
    }
    
    console.log(`✓ Title: ${cat.title}`);
    console.log(`✓ Slug: ${cat.slug}`);
    console.log(`✓ Item Specifics Count: ${cat.itemSpecifics?.length || 0}`);
    
    if (cat.itemSpecifics && cat.itemSpecifics.length > 0) {
      console.log('\nFirst 10 Item Specifics:');
      cat.itemSpecifics.slice(0, 10).forEach((spec, idx) => {
        console.log(`  ${idx + 1}. ${spec.name} (${spec.type}${spec.required ? ', required' : ''})`);
      });
    } else {
      console.log('⚠️  NO ITEM SPECIFICS FOUND!');
    }
  }
  
  // Test the category list generation logic
  console.log('\n\n=== Testing Category List Generation ===\n');
  
  const allCategories = await listCategories();
  console.log(`Total categories in Redis: ${allCategories.length}`);
  
  // Simulate what getRelevantCategories does
  const testProduct = {
    product: 'Dopamine Brain Food',
    brand: 'Natural Stacks',
  };
  
  const searchTerms = [testProduct.product, testProduct.brand]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  
  const relevant = allCategories
    .filter(cat => {
      const catText = `${cat.title} ${cat.slug}`.toLowerCase();
      return searchTerms.split(/\s+/).some(term => 
        term.length > 3 && catText.includes(term)
      );
    })
    .slice(0, 5) // Just top 5 for testing
    .map(cat => {
      const aspects = cat.itemSpecifics
        ?.filter(spec => !spec.required && spec.name !== 'Brand')
        .slice(0, 8)
        .map(spec => spec.name)
        .join(', ') || '';
      
      return {
        id: cat.id,
        title: cat.title,
        aspectCount: cat.itemSpecifics?.length || 0,
        aspectsPreview: aspects || '(none)',
        formatted: aspects 
          ? `${cat.id}: ${cat.title} (aspects: ${aspects})`
          : `${cat.id}: ${cat.title}`,
      };
    });
  
  console.log(`Found ${relevant.length} relevant categories for "${testProduct.brand} ${testProduct.product}":\n`);
  
  relevant.forEach(cat => {
    console.log(`${cat.formatted}`);
    console.log(`  → Total aspects: ${cat.aspectCount}, Showing: ${cat.aspectsPreview.split(', ').length}`);
    console.log();
  });
}

testCategoryAspects()
  .then(() => {
    console.log('\n✓ Test complete');
    process.exit(0);
  })
  .catch(err => {
    console.error('\n❌ Test failed:', err);
    process.exit(1);
  });
