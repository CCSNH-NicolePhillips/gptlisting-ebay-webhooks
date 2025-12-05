#!/usr/bin/env node

import { getCategoryById } from '../dist/src/lib/taxonomy-store.js';

async function main() {
  console.log('Checking category 180960 in Redis...');
  
  const cat = await getCategoryById('180960');
  
  if (!cat) {
    console.log('❌ Category 180960 NOT FOUND in Redis');
    return;
  }
  
  console.log('\n✅ Category found:');
  console.log('ID:', cat.id);
  console.log('Title:', cat.title);
  console.log('Slug:', cat.slug);
  console.log('\nAllowed Conditions:', cat.allowedConditions);
  
  if (cat.allowedConditions && cat.allowedConditions.length > 0) {
    console.log('\nCondition details:');
    cat.allowedConditions.forEach(c => {
      console.log(`  - ${c.conditionId}: ${c.conditionDisplayName}`);
    });
  } else {
    console.log('\n⚠️  NO allowedConditions data for this category!');
  }
  
  console.log('\nRequired Aspects:', cat.requiredAspects?.length || 0);
  console.log('Recommended Aspects:', cat.recommendedAspects?.length || 0);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
