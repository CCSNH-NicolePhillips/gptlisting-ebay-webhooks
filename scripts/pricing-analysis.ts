import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import { searchGoogleShopping } from '../src/lib/google-shopping-search.js';

const openai = new OpenAI();

interface ProductPricingData {
  imagePath: string;
  brand: string;
  productName: string;
  // Retail prices
  amazonPrice: number | null;
  walmartPrice: number | null;
  targetPrice: number | null;
  otherRetailPrice: number | null;
  otherRetailSource: string | null;
  // eBay competition
  ebayLowestPrice: number | null;
  ebayLowestSeller: string | null;
  ebayLowestFreeShipping: boolean;
  ebayMedianPrice: number | null;
  ebayHighestPrice: number | null;
  ebayListingCount: number;
  ebayFreeShippingCount: number;
  // Current algo estimate (70% of retail)
  currentAlgoPrice: number | null;
  // Suggested price (competitive with eBay)
  suggestedPrice: number | null;
  pricingNotes: string;
}

async function identifyProduct(imagePath: string): Promise<{ brand: string; productName: string }> {
  const base64 = fs.readFileSync(imagePath).toString('base64');
  const ext = path.extname(imagePath).toLowerCase();
  const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'What product is this? Return ONLY: Brand | Product Name with size/count. Example: NOW Foods | Vitamin D3 5000 IU 240 Softgels' },
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } }
      ]
    }],
    max_tokens: 100
  });

  const content = response.choices[0].message.content || '';
  const parts = content.split('|').map(s => s.trim());
  return {
    brand: parts[0] || 'Unknown',
    productName: parts[1] || content
  };
}

async function analyzeProduct(imagePath: string): Promise<ProductPricingData> {
  console.log(`\n📷 Processing: ${path.basename(imagePath)}`);
  
  // Step 1: Identify product
  const { brand, productName } = await identifyProduct(imagePath);
  console.log(`   Product: ${brand} | ${productName}`);

  // Step 2: Search Google Shopping
  const results = await searchGoogleShopping(brand, productName);
  
  // Step 3: Extract eBay competitor data
  const ebayResults = results.allResults.filter(r => 
    r.seller?.toLowerCase().includes('ebay') && 
    r.extracted_price > 0
  );
  
  const ebayWithFreeShipping = ebayResults.filter(r => 
    r.delivery?.toLowerCase().includes('free')
  );

  // Sort by price
  ebayResults.sort((a, b) => a.extracted_price - b.extracted_price);
  
  const ebayPrices = ebayResults.map(r => r.extracted_price);
  const ebayMedian = ebayPrices.length > 0 
    ? ebayPrices[Math.floor(ebayPrices.length / 2)] 
    : null;

  // Get retail price (non-eBay)
  const retailPrice = results.amazonPrice || results.walmartPrice || results.targetPrice || results.bestPrice;
  
  // Current algo: 70% of retail
  const currentAlgoPrice = retailPrice ? Math.round(retailPrice * 0.7 * 100) / 100 : null;
  
  // Suggested: Match eBay median or slightly below if we have data
  let suggestedPrice: number | null = null;
  let pricingNotes = '';
  
  if (ebayMedian && retailPrice) {
    // Price between eBay median and 70% retail
    suggestedPrice = Math.round(Math.min(ebayMedian, retailPrice * 0.7) * 100) / 100;
    pricingNotes = `eBay median $${ebayMedian}, retail $${retailPrice}`;
  } else if (ebayMedian) {
    suggestedPrice = ebayMedian;
    pricingNotes = `Based on eBay median (no retail found)`;
  } else if (retailPrice) {
    suggestedPrice = currentAlgoPrice;
    pricingNotes = `70% of retail (no eBay competition found)`;
  } else {
    pricingNotes = 'No pricing data found';
  }

  return {
    imagePath: path.basename(imagePath),
    brand,
    productName,
    amazonPrice: results.amazonPrice,
    walmartPrice: results.walmartPrice,
    targetPrice: results.targetPrice,
    otherRetailPrice: results.bestPrice,
    otherRetailSource: results.bestPriceSource,
    ebayLowestPrice: ebayResults[0]?.extracted_price || null,
    ebayLowestSeller: ebayResults[0]?.seller?.replace('eBay - ', '') || null,
    ebayLowestFreeShipping: ebayResults[0]?.delivery?.toLowerCase().includes('free') || false,
    ebayMedianPrice: ebayMedian,
    ebayHighestPrice: ebayResults[ebayResults.length - 1]?.extracted_price || null,
    ebayListingCount: ebayResults.length,
    ebayFreeShippingCount: ebayWithFreeShipping.length,
    currentAlgoPrice,
    suggestedPrice,
    pricingNotes
  };
}

async function main() {
  const inputDir = process.argv[2] || 'testDropbox/ebay10';
  const outputFile = process.argv[3] || 'pricing-analysis.csv';
  
  console.log('='.repeat(60));
  console.log('COMPETITIVE PRICING ANALYSIS');
  console.log('='.repeat(60));
  console.log(`Input folder: ${inputDir}`);
  console.log(`Output file: ${outputFile}`);

  // Find all images
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp'];
  const files = fs.readdirSync(inputDir)
    .filter(f => imageExtensions.includes(path.extname(f).toLowerCase()))
    .map(f => path.join(inputDir, f));

  console.log(`Found ${files.length} images to analyze`);

  const results: ProductPricingData[] = [];
  
  for (let i = 0; i < files.length; i++) {
    console.log(`\n[${i + 1}/${files.length}]`);
    try {
      const data = await analyzeProduct(files[i]);
      results.push(data);
      
      // Rate limit
      if (i < files.length - 1) {
        await new Promise(r => setTimeout(r, 500));
      }
    } catch (error) {
      console.error(`   ❌ Error: ${error instanceof Error ? error.message : error}`);
      results.push({
        imagePath: path.basename(files[i]),
        brand: 'ERROR',
        productName: String(error),
        amazonPrice: null,
        walmartPrice: null,
        targetPrice: null,
        otherRetailPrice: null,
        otherRetailSource: null,
        ebayLowestPrice: null,
        ebayLowestSeller: null,
        ebayLowestFreeShipping: false,
        ebayMedianPrice: null,
        ebayHighestPrice: null,
        ebayListingCount: 0,
        ebayFreeShippingCount: 0,
        currentAlgoPrice: null,
        suggestedPrice: null,
        pricingNotes: 'Error processing'
      });
    }
  }

  // Generate CSV
  const headers = [
    'Image', 'Brand', 'Product Name',
    'Amazon', 'Walmart', 'Target', 'Other Retail', 'Other Source',
    'eBay Lowest', 'eBay Seller', 'Free Ship?', 'eBay Median', 'eBay Highest', 
    'eBay Count', 'Free Ship Count',
    'Current Algo (70%)', 'Suggested Price', 'Notes'
  ];

  const rows = results.map(r => [
    r.imagePath,
    r.brand,
    `"${r.productName.replace(/"/g, '""')}"`,
    r.amazonPrice || '',
    r.walmartPrice || '',
    r.targetPrice || '',
    r.otherRetailPrice || '',
    r.otherRetailSource || '',
    r.ebayLowestPrice || '',
    r.ebayLowestSeller || '',
    r.ebayLowestFreeShipping ? 'Yes' : 'No',
    r.ebayMedianPrice || '',
    r.ebayHighestPrice || '',
    r.ebayListingCount,
    r.ebayFreeShippingCount,
    r.currentAlgoPrice || '',
    r.suggestedPrice || '',
    `"${r.pricingNotes.replace(/"/g, '""')}"`
  ]);

  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  fs.writeFileSync(outputFile, csv);

  console.log('\n' + '='.repeat(60));
  console.log(`✅ Analysis complete! Saved to: ${outputFile}`);
  console.log('='.repeat(60));

  // Print summary
  console.log('\n📊 SUMMARY:');
  const withEbay = results.filter(r => r.ebayListingCount > 0);
  const withAmazon = results.filter(r => r.amazonPrice);
  const pricingGaps = results.filter(r => 
    r.currentAlgoPrice && r.ebayLowestPrice && 
    r.currentAlgoPrice > r.ebayLowestPrice
  );

  console.log(`   Products analyzed: ${results.length}`);
  console.log(`   With eBay competition: ${withEbay.length}`);
  console.log(`   With Amazon price: ${withAmazon.length}`);
  console.log(`   ⚠️  Current algo HIGHER than eBay lowest: ${pricingGaps.length}`);
  
  if (pricingGaps.length > 0) {
    console.log('\n   Products where current algo is not competitive:');
    pricingGaps.forEach(r => {
      console.log(`   - ${r.brand} ${r.productName.slice(0, 30)}: Algo $${r.currentAlgoPrice} vs eBay $${r.ebayLowestPrice}`);
    });
  }
}

main().catch(console.error);
