/**
 * Amazon price scraper - simple HTTP scraping fallback
 * Used when PA-API is unavailable or fails
 */

interface AmazonScraperResult {
  price: number | null;
  title?: string;
  asin?: string;
  url?: string;
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
      // Whole price pattern: $19.99 or $19
      /\$(\d+)\.(\d{2})/g,
      // Alternative: <span class="a-price-whole">19</span><span class="a-price-fraction">99</span>
      /<span class="a-price-whole">(\d+)<\/span>.*?<span class="a-price-fraction">(\d+)<\/span>/g,
      // Just whole dollars
      /\$(\d+)/g
    ];

    let price: number | null = null;

    // Find the section of HTML for this ASIN
    const asinSectionStart = html.indexOf(`data-asin="${asin}"`);
    if (asinSectionStart === -1) {
      console.warn('[amazon-scraper] Could not find product section for ASIN:', asin);
      return { price: null, asin };
    }

    // Get a reasonable chunk of HTML after the ASIN (next 2000 chars should contain price)
    const asinSection = html.substring(asinSectionStart, asinSectionStart + 2000);

    // Try each pattern
    for (const pattern of pricePatterns) {
      pattern.lastIndex = 0; // Reset regex
      const matches = [...asinSection.matchAll(pattern)];
      
      if (matches.length > 0) {
        const match = matches[0];
        if (match[2]) {
          // Has cents: $19.99
          price = parseFloat(`${match[1]}.${match[2]}`);
        } else {
          // Just dollars: $19
          price = parseFloat(match[1]);
        }

        if (price && price > 0 && price < 10000) {
          // Sanity check: reasonable price range
          console.log('[amazon-scraper] ✓ Found price:', `$${price}`);
          break;
        }
      }
    }

    if (!price) {
      console.warn('[amazon-scraper] Could not extract price from product section');
      return { price: null, asin };
    }

    return {
      price,
      asin,
      url: `https://www.amazon.com/dp/${asin}`
    };

  } catch (error) {
    console.error('[amazon-scraper] Error:', error);
    return { price: null };
  }
}
