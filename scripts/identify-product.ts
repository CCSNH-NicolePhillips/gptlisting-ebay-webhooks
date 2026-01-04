import fs from 'fs';
import OpenAI from 'openai';
import { searchGoogleShopping, getRetailPrice } from '../src/lib/google-shopping-search.js';

const openai = new OpenAI();

const imagePath = process.argv[2] || 'c:/Users/hanri/OneDrive/Documents/GitHub/gptlisting-ebay-webhooks/testDropbox/ebay10/IMG_20251231_184446.jpg';
const base64 = fs.readFileSync(imagePath).toString('base64');

console.log('='.repeat(60));
console.log('PRODUCT IDENTIFICATION & PRICING TEST');
console.log('='.repeat(60));
console.log('\n📷 Image:', imagePath);

// Step 1: Vision AI identifies the product
console.log('\n🔍 Step 1: Identifying product with GPT-4o-mini vision...');
const response = await openai.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'What product is this? Return ONLY the brand and full product name with size/count. Format: Brand | Product Name' },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } }
    ]
  }],
  max_tokens: 100
});

const productInfo = response.choices[0].message.content || '';
console.log('   Product identified:', productInfo);

// Parse brand and product name
const parts = productInfo.split('|').map(s => s.trim());
const brand = parts[0] || '';
const productName = parts[1] || productInfo;

// Step 2: Search Google Shopping for prices
console.log('\n🛒 Step 2: Searching Google Shopping...');
const fullResult = await searchGoogleShopping(brand, productName);

console.log('\n📊 Results Summary:');
console.log('   Amazon:  ', fullResult.amazonPrice ? `$${fullResult.amazonPrice}` : 'Not found');
console.log('   Walmart: ', fullResult.walmartPrice ? `$${fullResult.walmartPrice}` : 'Not found');
console.log('   Target:  ', fullResult.targetPrice ? `$${fullResult.targetPrice}` : 'Not found');
console.log('   Best:    ', fullResult.bestPrice ? `$${fullResult.bestPrice} (${fullResult.bestPriceSource})` : 'Not found');
console.log('   Confidence:', fullResult.confidence);
console.log('   Reasoning:', fullResult.reasoning);

// Step 3: Get the priority-based retail price (what pricing pipeline would use)
console.log('\n💰 Step 3: Priority-based retail price (Amazon > Walmart > Target > Other):');
const retailPrice = await getRetailPrice(brand, productName);
console.log('   Price:  ', retailPrice.price ? `$${retailPrice.price}` : 'Not found');
console.log('   Source: ', retailPrice.source);
console.log('   URL:    ', retailPrice.url || 'N/A');

// Show all results
if (fullResult.allResults.length > 0) {
  console.log('\n📋 All Results (top 10):');
  fullResult.allResults.slice(0, 10).forEach((r, i) => {
    const priceStr = r.extracted_price ? `$${r.extracted_price.toFixed(2)}` : 'N/A';
    console.log(`   ${i + 1}. ${priceStr.padEnd(10)} ${r.seller?.padEnd(20)} ${r.title?.slice(0, 40)}`);
  });
}

console.log('\n' + '='.repeat(60));
