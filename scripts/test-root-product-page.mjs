// Test fetching Root product page to see what prices are available
const url = 'https://therootbrands.com/clean-slate.html';

console.log(`Fetching: ${url}\n`);

try {
  const response = await fetch(url);
  const html = await response.text();
  
  // Look for all dollar amounts
  const pricePattern = /\$\d+(?:\.\d{2})?/g;
  const prices = [...new Set(html.match(pricePattern) || [])];
  
  console.log('All dollar amounts found on page:');
  prices.forEach(p => console.log(`  ${p}`));
  
  // Check for "Subscribe & Save" or subscription language
  if (html.includes('Subscribe') || html.includes('subscription')) {
    console.log('\n⚠️ Page contains subscription/bundle language');
  }
  
  // Check for "retail" or "MSRP"
  if (html.includes('retail') || html.includes('MSRP')) {
    console.log('\n✓ Page mentions retail/MSRP pricing');
  }
  
  // Look for price near "one-time purchase" or similar
  const oneTimeMatch = html.match(/one[- ]time[^$]*\$(\d+(?:\.\d{2})?)/i);
  if (oneTimeMatch) {
    console.log(`\n✓ One-time purchase price: $${oneTimeMatch[1]}`);
  }
  
} catch (err) {
  console.error('Fetch failed:', err.message);
}
