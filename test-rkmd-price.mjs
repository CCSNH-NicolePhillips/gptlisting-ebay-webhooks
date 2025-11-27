import * as cheerio from 'cheerio';
import fs from 'fs/promises';

// Try multiple possible domains for RKMD
const urls = [
  'https://www.drrkmd.com/products/glutathione-rapid-boost',
  'https://drrkmd.com/products/glutathione-rapid-boost',
  'https://rkmd.com/products/glutathione-rapid-boost',
  'https://www.rkmd.com/products/glutathione-rapid-boost',
];

async function fetchHtml(url) {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
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

function extractPriceFromHtml(html) {
  const $ = cheerio.load(html);
  const scripts = $('script[type="application/ld+json"]').toArray();
  
  console.log(`Found ${scripts.length} JSON-LD script(s)`);
  
  const allPrices = [];
  
  for (const node of scripts) {
    try {
      const raw = $(node).text().trim();
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const type = String(item['@type'] || '').toLowerCase();
        if (!type.includes('product')) continue;
        
        const offers = item.offers;
        if (!offers) continue;
        const offerList = Array.isArray(offers) ? offers : [offers];
        
        for (const offer of offerList) {
          if (!offer || typeof offer !== 'object') continue;
          
          const priceSpec = offer.priceSpecification;
          const priceFromSpec = Array.isArray(priceSpec)
            ? toNumber(priceSpec[0]?.price)
            : toNumber(priceSpec?.price);
          
          const priceFromOffer =
            toNumber(offer.price) ??
            priceFromSpec ??
            toNumber(offer.lowPrice);
          
          if (priceFromOffer) {
            allPrices.push(priceFromOffer);
          }
        }
      }
    } catch (err) {
      continue;
    }
  }
  
  if (allPrices.length === 0) {
    return null;
  }
  
  // Filter out unrealistic bulk/wholesale prices
  const retailPrices = allPrices.filter(p => p <= 500);
  
  if (retailPrices.length === 0) {
    console.log(`All prices rejected as bulk/wholesale (>$500): ${allPrices.join(', ')}`);
    return null;
  }
  
  const minRetailPrice = Math.min(...retailPrices);
  console.log(`Found ${allPrices.length} price(s): ${allPrices.join(', ')}`);
  console.log(`Using lowest retail: $${minRetailPrice}`);
  return minRetailPrice;
}

console.log('Testing RKMD Glutathione price extraction...\n');

for (const url of urls) {
  console.log(`Trying: ${url}`);
  try {
    const html = await fetchHtml(url);
    console.log(`✓ Successfully fetched (${(html.length / 1024).toFixed(1)} KB)`);
    
    // Save HTML for inspection
    await fs.writeFile('rkmd-glutathione.html', html);
    console.log('✓ Saved to rkmd-glutathione.html\n');
    
    // Extract price
    const price = extractPriceFromHtml(html);
    console.log(`\n✅ Final extracted price: $${price}\n`);
    
    break; // Success - stop trying other URLs
  } catch (err) {
    console.log(`✗ Failed: ${err.message}\n`);
  }
}
