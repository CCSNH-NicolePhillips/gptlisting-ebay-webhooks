// Check what bundle indicators are on Root pages
const urls = [
  'https://therootbrands.com/zero-in.html',
  'https://therootbrands.com/product/zero-in/'
];

const strongIndicators = [
  { pattern: /\b\d+\s*-\s*month\s*(supply|pack|kit)\b/i, name: '# month supply/pack/kit' },
  { pattern: /\b\d+\s*(month|mo)\s*(supply|pack|kit)\b/i, name: '# month supply' },
  { pattern: /starter\s*(pack|kit|bundle)/i, name: 'starter pack' },
  { pattern: /\bvalue\s*pack\b/i, name: 'value pack' },
  { pattern: /\brefill\s*program\b/i, name: 'refill program' },
];

for (const url of urls) {
  console.log(`\nChecking: ${url}`);
  
  try {
    const response = await fetch(url);
    const html = await response.text();
    
    console.log('Strong bundle indicators found:');
    let foundAny = false;
    for (const ind of strongIndicators) {
      if (ind.pattern.test(html)) {
        console.log(`  ✓ ${ind.name}`);
        foundAny = true;
        
        // Show the match
        const match = html.match(ind.pattern);
        if (match) {
          console.log(`    Match: "${match[0]}"`);
        }
      }
    }
    
    if (!foundAny) {
      console.log('  (none found)');
    }
    
    // Check if page mentions subscription
    if (/subscription/i.test(html)) {
      console.log('  ℹ️ Page contains "subscription" keyword');
    }
    
  } catch (err) {
    console.error(`  Error: ${err.message}`);
  }
}
