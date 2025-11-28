// Test bundle/subscription page detection
import { extractPriceFromHtml } from '../dist/src/lib/html-price.js';

console.log('Testing bundle/subscription page detection...\n');

// Test 1: Fetch a Root product page (should be detected as bundle)
console.log('Test 1: Root Zero-In product page (has subscription language)');
const rootUrl = 'https://therootbrands.com/product/zero-in/';

try {
  const response = await fetch(rootUrl);
  const html = await response.text();
  
  const price = extractPriceFromHtml(html);
  
  if (price === null) {
    console.log('✅ PASS: Bundle page detected, no price extracted\n');
  } else {
    console.log(`❌ FAIL: Extracted price $${price} from bundle page\n`);
  }
} catch (err) {
  console.error('Error fetching Root page:', err.message);
}

// Test 2: Fetch Amazon (should NOT be detected as bundle)
console.log('Test 2: Amazon product page (normal single-product page)');
const amazonUrl = 'https://www.amazon.com/Vita-PLynxera-D-Chiro-Inositol-Supplement/dp/B0DZW37LQJ';

try {
  const response = await fetch(amazonUrl);
  const html = await response.text();
  
  const price = extractPriceFromHtml(html);
  
  if (price !== null) {
    console.log(`✅ PASS: Normal page not flagged as bundle, extracted $${price}\n`);
  } else {
    console.log('❌ FAIL: Amazon page incorrectly flagged as bundle\n');
  }
} catch (err) {
  console.error('Error fetching Amazon page:', err.message);
}

// Test 3: Mock HTML with subscription keywords
console.log('Test 3: Mock HTML with "Subscribe & Save" text');
const mockBundleHtml = `
  <html>
    <head><title>Test Product</title></head>
    <body>
      <h1>Test Product</h1>
      <p>Subscribe & Save 15% on auto-delivery</p>
      <span class="price">$29.99</span>
    </body>
  </html>
`;

const price3 = extractPriceFromHtml(mockBundleHtml);
if (price3 === null) {
  console.log('✅ PASS: Mock bundle page detected\n');
} else {
  console.log(`❌ FAIL: Extracted $${price3} from mock bundle page\n`);
}

// Test 4: Mock HTML without subscription keywords
console.log('Test 4: Mock HTML without bundle indicators');
const mockNormalHtml = `
  <html>
    <head><title>Test Product</title></head>
    <body>
      <h1>Test Product</h1>
      <p>Great single-product listing</p>
      <span class="price">$29.99</span>
    </body>
  </html>
`;

const price4 = extractPriceFromHtml(mockNormalHtml);
if (price4 !== null) {
  console.log(`✅ PASS: Normal HTML not flagged, extracted $${price4}\n`);
} else {
  console.log('❌ FAIL: Normal HTML incorrectly flagged as bundle\n');
}

console.log('Bundle detection tests complete!');
