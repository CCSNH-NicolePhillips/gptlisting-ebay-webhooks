import * as cheerio from 'cheerio';
import fs from 'fs/promises';

const url = 'https://www.amazon.com/Vita-PLynxera-D-Chiro-Inositol-Supplement/dp/B0DZW37LQJ';

async function fetchHtml(url) {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
    }
  });
  
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }
  
  return await resp.text();
}

function toNumber(value) {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return +num.toFixed(2);
}

function detectPackQty(text) {
  if (!text) return 1;
  const t = text.toLowerCase();

  // Strong signals: "pack of 2", "pk of 3"
  const m1 = t.match(/\b(?:pack|pk)\s*of\s*(\d+)\b/);
  if (m1) return parseInt(m1[1], 10);

  // "2 pack", "3 bottles", "4 count", "60 capsules"
  const m2 = t.match(/\b(\d+)\s*(?:pack|pk|count|ct|bottles?|capsules?|softgels?|units?)\b/);
  if (m2) {
    const qty = parseInt(m2[1], 10);
    // Ignore high counts that are likely product contents, not pack qty
    if (qty <= 10) return qty;
  }

  // Phrases like "2-pack", "3pk", "2x"
  const m3 = t.match(/\b(\d+)\s*-\s*pack\b|\b(\d+)\s*pk\b|\b(\d+)x\b/);
  const n = m3 && (m3[1] || m3[2] || m3[3]);
  if (n) {
    const qty = parseInt(n, 10);
    if (qty <= 10) return qty;
  }

  return 1;
}

function extractPriceFromHtml(html) {
  const $ = cheerio.load(html);
  
  // Check title and h1 for pack info
  const title = $('title').text();
  const h1 = $('#title, #productTitle, h1').first().text();
  console.log(`\n📦 Product Title: ${title.slice(0, 150)}`);
  console.log(`📦 H1: ${h1.slice(0, 150)}`);
  
  const packQty = detectPackQty(title) || detectPackQty(h1);
  console.log(`📦 Detected pack quantity: ${packQty}`);
  
  // Check for JSON-LD
  const scripts = $('script[type="application/ld+json"]').toArray();
  console.log(`\n🔍 Found ${scripts.length} JSON-LD script(s)`);
  
  if (scripts.length > 0) {
    for (const node of scripts) {
      const raw = $(node).text().trim();
      console.log(`\nJSON-LD content preview: ${raw.slice(0, 500)}...`);
    }
  }
  
  // Look for common Amazon price selectors
  console.log(`\n💰 Looking for prices in common Amazon selectors...`);
  
  const priceSelectors = [
    '.a-price .a-offscreen',
    '#priceblock_ourprice',
    '#priceblock_dealprice',
    '.a-price-whole',
    '#corePriceDisplay_desktop_feature_div .a-price .a-offscreen',
    '[data-feature-name="corePriceDisplay"] .a-price .a-offscreen'
  ];
  
  const foundPrices = [];
  for (const selector of priceSelectors) {
    const elements = $(selector);
    if (elements.length > 0) {
      elements.each((i, el) => {
        const text = $(el).text().trim();
        console.log(`  ${selector}: "${text}"`);
        foundPrices.push(text);
      });
    }
  }
  
  // Extract all dollar amounts from body
  console.log(`\n💵 Extracting all dollar amounts from page...`);
  const bodyText = $.root().text();
  const priceMatches = bodyText.match(/\$\s?(\d{1,4}(?:\.\d{2})?)/g);
  
  if (priceMatches) {
    const uniquePrices = [...new Set(priceMatches)];
    console.log(`Found ${uniquePrices.length} unique price patterns:`, uniquePrices.slice(0, 20));
    
    const prices = priceMatches
      .map(m => m.replace(/\$/g, '').trim())
      .map(m => toNumber(m))
      .filter(p => p !== null && p >= 15 && p <= 500);
    
    const uniqueNumericPrices = [...new Set(prices)].sort((a, b) => a - b);
    console.log(`Filtered prices (>=$15, <=$500):`, uniqueNumericPrices);
  }
  
  // Check for variant/option selectors
  console.log(`\n🔀 Looking for variant/option selectors...`);
  const variantSelectors = [
    '#twister',
    '.twister-plus-buying-options',
    '[id^="variation_"]',
    '#selectQuantity',
    '.a-native-dropdown'
  ];
  
  for (const selector of variantSelectors) {
    const elements = $(selector);
    if (elements.length > 0) {
      console.log(`  Found: ${selector} (${elements.length} element(s))`);
      elements.slice(0, 3).each((i, el) => {
        const text = $(el).text().trim().slice(0, 200);
        console.log(`    Text preview: ${text}`);
      });
    }
  }
  
  return null; // Just analyzing for now
}

console.log('Testing Vita PLynxera Amazon price extraction...\n');

// Try different URL variations
const searches = [
  { query: url, label: 'Original URL (2-pack)' },
  // Try removing "2 Pack" from the URL slug
  { query: 'https://www.amazon.com/Vita-PLynxera-D-Chiro-Inositol-Supplement/dp/B0DZLVQRNB', label: 'Possible single bottle ASIN' },
  // Try parent ASIN or variation
  { query: url + '?th=1', label: 'With variation parameter' }
];

for (const search of searches) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`Testing: ${search.label}`);
  console.log(`URL: ${search.query}`);
  console.log('='.repeat(80) + '\n');

  try {
    const html = await fetchHtml(search.query);
    console.log(`✓ Successfully fetched (${(html.length / 1024).toFixed(1)} KB)`);
    
    // Save HTML for inspection
    const filename = search.label.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.html';
    await fs.writeFile(filename, html);
    console.log(`✓ Saved to ${filename}\n`);
    
    // Analyze
    extractPriceFromHtml(html);
    
  } catch (err) {
    console.log(`✗ Failed: ${err.message}`);
  }
}

console.log('\n' + '='.repeat(80));
console.log('✅ Analysis complete');
console.log('='.repeat(80));
