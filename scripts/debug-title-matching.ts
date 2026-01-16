/**
 * Debug script for testing isTitleMatch() function
 * 
 * Tests whether brand site results (e.g., pumpsauce.com) are being
 * incorrectly filtered due to title mismatches.
 * 
 * Usage: npx tsx scripts/debug-title-matching.ts
 */

// Inline the isTitleMatch logic to test it directly
const LOT_PATTERNS = [
  /\b\d+\s*(?:pack|pc|pcs|lot|case|set)\s+of\s+\d+/i,
  /\bset\s+of\s+\d+\b/i,
  /\blot\s+of\s+\d+\b/i,
];

const PRODUCT_TYPE_GROUPS = [
  ['mask', 'masks'],
  ['balm', 'balms'],
  ['cream', 'creams'],
  ['serum', 'serums'],
  ['lotion', 'lotions'],
  ['gel', 'gels'],
  ['oil', 'oils'],
  ['spray', 'sprays'],
  ['gummy', 'gummies'],
  ['capsule', 'capsules'],
  ['tablet', 'tablets'],
  ['pill', 'pills'],
  ['powder', 'powders'],
  ['liquid', 'liquids'],
  ['drop', 'drops'],
  ['patch', 'patches'],
  ['bar', 'bars'],
  ['drink', 'drinks'],
  ['shot', 'shots'],
  ['pack', 'packs'],
];

const ALL_PRODUCT_TYPES = PRODUCT_TYPE_GROUPS.flat();

function normalize(s: string): string[] {
  return s.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2)
    .filter(w => !['the', 'and', 'for', 'with', 'new'].includes(w));
}

function normalizeType(word: string): string {
  for (const group of PRODUCT_TYPE_GROUPS) {
    if (group.includes(word)) return group[0];
  }
  return word;
}

/**
 * Updated isTitleMatch with sellerUrl parameter
 * NOW: If seller URL contains brand name, trust the result even without brand in title
 */
function isTitleMatch(
  resultTitle: string, 
  searchQuery: string, 
  searchBrand?: string,
  sellerUrl?: string,
  verbose = true
): boolean {
  const queryWords = normalize(searchQuery);
  const titleWords = normalize(resultTitle);
  
  if (verbose) {
    console.log(`\n=== Title Match Test ===`);
    console.log(`Result title: "${resultTitle}"`);
    console.log(`Search query: "${searchQuery}"`);
    console.log(`Brand: "${searchBrand || '(none)'}"`);
    console.log(`Seller URL: "${sellerUrl || '(none)'}"`);
    console.log(`Query words: [${queryWords.join(', ')}]`);
    console.log(`Title words: [${titleWords.join(', ')}]`);
  }
  
  if (queryWords.length === 0) {
    if (verbose) console.log(`✅ PASS: Empty query = auto-match`);
    return true;
  }
  
  // Check brand match
  if (searchBrand && searchBrand.length > 0) {
    const brandWords = normalize(searchBrand);
    const titleLower = resultTitle.toLowerCase();
    
    const brandInTitle = brandWords.some(bw => 
      titleLower.includes(bw) || 
      titleWords.some(tw => tw.includes(bw) || bw.includes(tw))
    );
    
    // NEW: Check if seller URL contains brand name
    let brandInSellerUrl = false;
    if (sellerUrl) {
      const urlLower = sellerUrl.toLowerCase();
      const domainMatch = urlLower.match(/(?:https?:\/\/)?(?:www\.)?([^\/]+)/);
      const domain = domainMatch?.[1] || urlLower;
      
      const brandSlug = searchBrand.toLowerCase().replace(/[^a-z0-9]/g, '');
      const brandWordsNormalized = brandWords.map(w => w.replace(/[^a-z0-9]/g, ''));
      
      brandInSellerUrl = domain.includes(brandSlug) || 
                         brandWordsNormalized.some(bw => bw.length > 3 && domain.includes(bw));
      
      if (verbose) {
        console.log(`Domain extracted: "${domain}"`);
        console.log(`Brand slug: "${brandSlug}"`);
        console.log(`Brand in URL? ${brandInSellerUrl}`);
      }
      
      if (brandInSellerUrl && !brandInTitle) {
        if (verbose) console.log(`✅ Brand "${searchBrand}" found in seller URL - trusting despite title mismatch`);
      }
    }
    
    if (verbose) {
      console.log(`Brand check: brand words [${brandWords.join(', ')}]`);
      console.log(`Brand in title? ${brandInTitle}`);
      console.log(`Brand in seller URL? ${brandInSellerUrl}`);
    }
    
    if (!brandInTitle && !brandInSellerUrl) {
      if (verbose) console.log(`❌ FAIL: Brand "${searchBrand}" not found in title OR URL`);
      return false;
    }
    
    // NEW: If brand was verified via URL (official brand site), trust it for pricing
    // Brand sites are authoritative and may use different product names than retailers
    if (brandInSellerUrl && !brandInTitle) {
      if (verbose) console.log(`✅ PASS: Brand site detected (${sellerUrl}) - auto-approving for pricing`);
      return true;  // Trust the brand's own site
    }
  }
  
  // Check product type match
  const queryTypes = queryWords.filter(w => ALL_PRODUCT_TYPES.includes(w)).map(normalizeType);
  const titleTypes = titleWords.filter(w => ALL_PRODUCT_TYPES.includes(w)).map(normalizeType);
  
  if (verbose) {
    console.log(`Query product types: [${queryTypes.join(', ')}]`);
    console.log(`Title product types: [${titleTypes.join(', ')}]`);
  }
  
  if (queryTypes.length > 0 && titleTypes.length > 0) {
    const typesMatch = queryTypes.some(qt => titleTypes.includes(qt));
    if (!typesMatch) {
      if (verbose) console.log(`❌ FAIL: Product type mismatch: query "${queryTypes.join(',')}" vs title "${titleTypes.join(',')}"`);
      return false;
    }
  }
  
  // Forward match ratio
  const forwardMatchCount = queryWords.filter(qw => 
    titleWords.some(tw => tw.includes(qw) || qw.includes(tw))
  ).length;
  const forwardMatchRatio = forwardMatchCount / queryWords.length;
  
  if (verbose) {
    console.log(`Forward match: ${forwardMatchCount}/${queryWords.length} = ${(forwardMatchRatio * 100).toFixed(0)}%`);
  }
  
  // Backward match ratio  
  const backwardMatchCount = titleWords.filter(tw =>
    queryWords.some(qw => tw.includes(qw) || qw.includes(tw))
  ).length;
  const backwardMatchRatio = titleWords.length > 0 
    ? backwardMatchCount / titleWords.length 
    : 0;
    
  if (verbose) {
    console.log(`Backward match: ${backwardMatchCount}/${titleWords.length} = ${(backwardMatchRatio * 100).toFixed(0)}%`);
  }
  
  // Combined score
  const combinedScore = (forwardMatchRatio * 0.6) + (backwardMatchRatio * 0.4);
  if (verbose) {
    console.log(`Combined score: ${(combinedScore * 100).toFixed(0)}%`);
  }
  
  // Final decision
  const forwardPasses = forwardMatchRatio >= 0.4;
  const backwardPasses = backwardMatchRatio >= 0.3;
  const combinedPasses = combinedScore >= 0.35;
  
  const result = forwardPasses || backwardPasses || combinedPasses;
  
  if (verbose) {
    console.log(`\nThresholds:`);
    console.log(`  Forward >= 40%: ${forwardPasses ? '✅' : '❌'}`);
    console.log(`  Backward >= 30%: ${backwardPasses ? '✅' : '❌'}`);
    console.log(`  Combined >= 35%: ${combinedPasses ? '✅' : '❌'}`);
    console.log(`\nFinal result: ${result ? '✅ MATCH' : '❌ NO MATCH'}`);
  }
  
  return result;
}

// ========================================
// TEST CASES
// ========================================

console.log('\n' + '='.repeat(60));
console.log('PUMP SAUCE TITLE MATCHING TESTS');
console.log('='.repeat(60));

// Test 1: The original failing case (no URL) - should FAIL
console.log('\n\n>>> Test 1: Brand site missing brand name (NO URL)');
isTitleMatch(
  "Watermelon Marg 12 x 2 fl oz",
  "Pump Sauce 12-Pack",
  "Pump Sauce"
);

// Test 2: WITH brand site URL - should now PASS!
console.log('\n\n>>> Test 2: Brand site WITH URL containing brand name - SHOULD PASS NOW');
isTitleMatch(
  "Watermelon Marg 12 x 2 fl oz",
  "Pump Sauce 12-Pack",
  "Pump Sauce",
  "https://www.pumpsauce.com/products/watermelon-marg-12-pack"
);

// Test 3: What if the brand site had proper title?
console.log('\n\n>>> Test 3: If brand site had proper title (no URL needed)');
isTitleMatch(
  "Pump Sauce Watermelon Marg 12 Pack",
  "Pump Sauce 12-Pack",
  "Pump Sauce"
);

// Test 4: Non-brand-site URL should still fail
console.log('\n\n>>> Test 4: Non-brand URL should still fail');
isTitleMatch(
  "Watermelon Marg 12 x 2 fl oz",
  "Pump Sauce 12-Pack",
  "Pump Sauce",
  "https://www.randomstore.com/products/watermelon-marg"
);

console.log('\n' + '='.repeat(60));
console.log('PANDA\'S PROMISE TITLE MATCHING TESTS');
console.log('='.repeat(60));

console.log('\n\n>>> Test 5: Panda\'s Promise exact match');
isTitleMatch(
  "Panda's Promise Bamboo Boost Nourishing Conditioner 8 fl oz",
  "Panda's Promise Bamboo Boost Nourishing Conditioner 8 oz",
  "Panda's Promise"
);

console.log('\n\n>>> Test 6: Brand site abbreviated title WITH URL - SHOULD PASS');
isTitleMatch(
  "Bamboo Boost Conditioner",
  "Panda's Promise Bamboo Boost Nourishing Conditioner 8 oz",
  "Panda's Promise",
  "https://pandaspromise.com/products/bamboo-boost-conditioner"
);

console.log('\n' + '='.repeat(60));
console.log('PEACH & LILY TITLE MATCHING TESTS');
console.log('='.repeat(60));

console.log('\n\n>>> Test 7: Peach & Lily kit WITH brand URL - SHOULD PASS');
isTitleMatch(
  "Glass Skin Discovery Kit",
  "Peach & Lily Glass Skin Discovery Kit",
  "Peach & Lily",
  "https://www.peachandlily.com/products/glass-skin-discovery-kit"
);

console.log('\n' + '='.repeat(60));
console.log('SUMMARY');
console.log('='.repeat(60));

console.log(`
Key Findings:

1. FIX IMPLEMENTED: When sellerUrl contains brand name (e.g., pumpsauce.com),
   we now trust the result even if the title doesn't include the brand.
   
2. TESTS SHOULD SHOW:
   - Test 1 (no URL): ❌ FAIL - expected, no way to verify brand
   - Test 2 (with brand URL): ✅ PASS - URL contains "pumpsauce"
   - Test 3 (proper title): ✅ PASS - brand in title
   - Test 4 (wrong URL): ❌ FAIL - URL doesn't contain brand
   
3. The fix allows brand sites to be used for retail cap pricing even when
   they omit their brand name from product titles.
`);
