/**
 * Amazon price scraper - simple HTTP scraping fallback
 * Used when PA-API is unavailable or fails
 */

interface AmazonScraperResult {
  price: number | null;
  title?: string;
  asin?: string;
  url?: string;
  packQuantity?: number; // Number of units in pack (1 for single, 2 for 2-pack, etc.)
  pricePerUnit?: number; // Calculated price per single unit
  weight?: { value: number; unit: string } | null; // Shipping weight extracted from product page
}

/**
 * Search Amazon and scrape the first result's price
 */
export async function scrapeAmazonPrice(
  brand?: string,
  product?: string,
  upc?: string
): Promise<AmazonScraperResult> {
  try {
    // Build search query
    const searchTerms = [];
    if (upc) {
      searchTerms.push(upc);
    } else {
      if (brand) searchTerms.push(brand);
      if (product) searchTerms.push(product);
    }

    if (searchTerms.length === 0) {
      console.warn('[amazon-scraper] No search terms provided');
      return { price: null };
    }

    const query = searchTerms.join(' ');
    const searchUrl = `https://www.amazon.com/s?k=${encodeURIComponent(query)}`;

    console.log('[amazon-scraper] Searching Amazon:', query);

    // Fetch search results page
    const response = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      }
    });

    if (!response.ok) {
      console.error('[amazon-scraper] Failed to fetch:', response.status, response.statusText);
      return { price: null };
    }

    const html = await response.text();

    // Extract first product ASIN
    const asinMatch = html.match(/data-asin="([A-Z0-9]{10})"/);
    if (!asinMatch) {
      console.warn('[amazon-scraper] No products found for:', query);
      return { price: null };
    }

    const asin = asinMatch[1];
    console.log('[amazon-scraper] Found ASIN:', asin);

    // Try to extract price from search results
    // Amazon uses various price formats, try multiple patterns
    const pricePatterns = [
      // Pattern 1: a-price-whole + a-price-fraction spans
      /<span class="a-price-whole">(\d+)<\/span><span class="a-offscreen">\$\d+\.\d+<\/span><span class="a-price-fraction">(\d+)<\/span>/,
      // Pattern 2: Simple $19.99 format
      /\$(\d+)\.(\d{2})/,
      // Pattern 3: a-price-whole only (whole dollars)
      /<span class="a-price-whole">(\d+)<\/span>/,
      // Pattern 4: JSON price data
      /"priceAmount":(\d+\.?\d*)/,
      // Pattern 5: Offscreen price (accessibility text)
      /<span class="a-offscreen">\$(\d+)\.(\d{2})<\/span>/,
    ];

    let price: number | null = null;

    // Find the section of HTML for this ASIN
    const asinSectionStart = html.indexOf(`data-asin="${asin}"`);
    if (asinSectionStart === -1) {
      console.warn('[amazon-scraper] Could not find product section for ASIN:', asin);
      return { price: null, asin };
    }

    // Get a larger chunk of HTML (4000 chars should definitely contain price)
    const asinSection = html.substring(asinSectionStart, asinSectionStart + 4000);

    // Try each pattern
    for (let i = 0; i < pricePatterns.length; i++) {
      const pattern = pricePatterns[i];
      const match = asinSection.match(pattern);
      
      if (match) {
        if (match[2]) {
          // Has cents: $19.99
          price = parseFloat(`${match[1]}.${match[2]}`);
        } else {
          // Just dollars: $19 or "priceAmount":29.99
          price = parseFloat(match[1]);
        }

        if (price && price > 0 && price < 10000) {
          // Sanity check: reasonable price range
          console.log(`[amazon-scraper] ✓ Found price: $${price} (pattern ${i + 1})`);
          break;
        } else {
          price = null; // Reset if invalid
        }
      }
    }

    if (!price) {
      // Last resort: try to find ANY price-like pattern in the section
      const anyPriceMatch = asinSection.match(/\$(\d+)\.(\d{2})/);
      if (anyPriceMatch) {
        price = parseFloat(`${anyPriceMatch[1]}.${anyPriceMatch[2]}`);
        if (price > 0 && price < 10000) {
          console.log(`[amazon-scraper] ✓ Found price: $${price} (fallback pattern)`);
        } else {
          price = null;
        }
      }
    }

    if (!price) {
      console.warn('[amazon-scraper] Could not extract price from product section');
      console.warn('[amazon-scraper] Section preview:', asinSection.substring(0, 500));
      return { price: null, asin };
    }

    // Detect pack quantity from title or product details
    let packQuantity = 1;
    const packPatterns = [
      /(\d+)[\s-]?pack/i,           // "2-Pack", "2 Pack", "3Pack"
      /pack\s+of\s+(\d+)/i,         // "Pack of 2", "Pack of 3"
      /(\d+)\s+count/i,             // "2 Count", "3 Count"
      /set\s+of\s+(\d+)/i,          // "Set of 2"
      /\((\d+)\s*pcs?\)/i,          // "(2 pcs)", "(3 pc)"
      /(\d+)[\s-]?piece/i,          // "2-Piece", "2 Piece"
    ];

    // Check in a larger section that includes title
    const searchSection = html.substring(asinSectionStart, asinSectionStart + 8000);
    
    for (const pattern of packPatterns) {
      const match = searchSection.match(pattern);
      if (match && match[1]) {
        const quantity = parseInt(match[1], 10);
        if (quantity > 1 && quantity <= 100) { // Sanity check
          packQuantity = quantity;
          console.log(`[amazon-scraper] ✓ Detected pack quantity: ${packQuantity} (${match[0]})`);
          break;
        }
      }
    }

    const pricePerUnit = packQuantity > 1 ? price / packQuantity : price;
    
    if (packQuantity > 1) {
      console.log(`[amazon-scraper] ⚠️  Multi-pack detected: ${packQuantity} units @ $${price} = $${pricePerUnit.toFixed(2)} per unit`);
    }

    // Extract weight from product details section
    let weight: { value: number; unit: string } | null = null;
    const weightPatterns = [
      /(\d+(?:\.\d+)?)\s*(pound|lb|ounce|oz|gram|g|kg)\s*\(Pack of \d+\)/i, // "1.98 Pound (Pack of 1)"
      /(\d+(?:\.\d+)?)\s*(pound|lb|ounce|oz|gram|g|kg)/i, // Generic weight
      /Item Weight.*?(\d+(?:\.\d+)?)\s*(pound|lb|ounce|oz)/i, // Product details table
      /Shipping Weight.*?(\d+(?:\.\d+)?)\s*(pound|lb|ounce|oz)/i, // Shipping weight line
    ];

    for (const pattern of weightPatterns) {
      const match = searchSection.match(pattern);
      if (match && match[1] && match[2]) {
        const value = parseFloat(match[1]);
        let unit = match[2].toLowerCase();
        // Normalize unit names
        if (unit === 'lb') unit = 'pound';
        if (unit === 'oz') unit = 'ounce';
        if (!isNaN(value) && value > 0) {
          weight = { value, unit };
          console.log(`[amazon-scraper] ✓ Found weight: ${value} ${unit} (${match[0]})`);
          break;
        }
      }
    }

    return {
      price,
      asin,
      url: `https://www.amazon.com/dp/${asin}`,
      packQuantity,
      pricePerUnit: Math.round(pricePerUnit * 100) / 100, // Round to 2 decimals
      weight,
    };

  } catch (error) {
    console.error('[amazon-scraper] Error:', error);
    return { price: null };
  }
}
