import * as cheerio from 'cheerio';
import fs from 'fs/promises';

// RKMD Glutathione products - test with actual product URLs
const urls = [
  'https://robkellermd.com/glutathione-rapid-boost-sports-drink.html', // GRB™+ - Glutathione Drink
  'https://robkellermd.com/original-glutathione-supplement.html',      // OGF® - Glutathione Supplement
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
  
  // If JSON-LD found prices, use those
  if (allPrices.length > 0) {
    const retailPrices = allPrices.filter(p => p <= 500);
    
    if (retailPrices.length === 0) {
      console.log(`All prices rejected as bulk/wholesale (>$500): ${allPrices.join(', ')}`);
      return null;
    }
    
    const minRetailPrice = Math.min(...retailPrices);
    console.log(`Found ${allPrices.length} price(s) in JSON-LD: ${allPrices.join(', ')}`);
    console.log(`Using lowest retail: $${minRetailPrice}`);
    return minRetailPrice;
  }
  
  // Fallback: Try Open Graph meta tags
  const og = $('meta[property="product:price:amount"], meta[property="og:price:amount"]').attr('content');
  if (og) {
    const price = toNumber(og);
    if (price) {
      console.log(`Found price in Open Graph: $${price}`);
      return price;
    }
  }
  
  // Last resort: Extract from body text
  console.log('Trying to extract from body text...');
  const bodyText = $.root().text();
  
  // First try: Look for price in context
  const targeted = bodyText.match(/(?:price|buy|order)[^$]{0,60}\$\s?(\d{1,4}(?:\.\d{2})?)/i);
  if (targeted) {
    const price = toNumber(targeted[1]);
    if (price && price >= 10) {
      console.log(`Found targeted price: $${price}`);
      return price;
    }
  }
  
  // Second try: Extract all prices and filter
  const priceMatches = bodyText.match(/\$\s?(\d{1,4}(?:\.\d{2})?)/g);
  if (priceMatches) {
    console.log(`Found ${priceMatches.length} price patterns in body:`, priceMatches.slice(0, 10));
    const prices = priceMatches
      .map(m => m.replace(/\$/g, '').trim())
      .map(m => toNumber(m))
      .filter(p => p !== null && p >= 15 && p <= 500); // Filter realistic product prices (>=15 filters out discount amounts)
    
    if (prices.length > 0) {
      console.log(`Filtered prices (>=$15):`, prices);
      
      // Prefer prices ending in .95 or .99 (typical retail pricing)
      const retailPrices = prices.filter(p => {
        const cents = Math.round((p % 1) * 100);
        return cents === 95 || cents === 99;
      });
      
      if (retailPrices.length > 0) {
        const minPrice = Math.min(...retailPrices);
        console.log(`Using lowest retail-formatted price (.95/.99): $${minPrice}`);
        return minPrice;
      }
      
      const minPrice = Math.min(...prices);
      console.log(`Using lowest price: $${minPrice}`);
      return minPrice;
    }
  }
  
  return null;
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
