// Test the homepage detection regex

const testUrls = [
  'https://therootbrands.com',
  'https://therootbrands.com/',
  'http://example.com',
  'http://example.com/',
  'https://example.com/products',
  'https://example.com/products/',
  'https://robkellermd.com/glutathione-rapid-boost-sports-drink.html',
];

const isHomepage = (url) => /^https?:\/\/[^\/]+\/?$/.test(url);

console.log('Testing homepage detection regex:\n');

testUrls.forEach(url => {
  const result = isHomepage(url);
  console.log(`${result ? '✓ HOMEPAGE' : '✗ Product page'}: ${url}`);
});
