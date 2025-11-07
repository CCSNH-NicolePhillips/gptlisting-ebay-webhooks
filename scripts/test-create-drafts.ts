/**
 * Test script for smartdrafts-create-drafts endpoint
 * Usage: tsx scripts/test-create-drafts.ts
 */

import { config } from 'dotenv';
config();

// Sample pairing products from your /test3 folder
const sampleProducts = [
  {
    productId: "wishtrend_acid_duo_hibiscus",
    brand: "By Wishtrend",
    product: "Acid-Duo 2% Mild Gel Cleanser",
    variant: "Hibiscus AHA-BHA",
    size: "150ml",
    categoryPath: "Health & Beauty > Skin Care > Cleansers",
    frontUrl: "https://example.com/wishtrend_front.jpg",
    backUrl: "https://example.com/wishtrend_back.jpg",
    heroDisplayUrl: "https://example.com/wishtrend_front.jpg",
    backDisplayUrl: "https://example.com/wishtrend_back.jpg",
    extras: [],
    evidence: ["Brand match", "Visual similarity: 1.000", "Category compatible"]
  },
  {
    productId: "natural_stacks_neuromaster",
    brand: "Natural Stacks",
    product: "NeuroMaster",
    variant: null,
    size: "60 capsules",
    categoryPath: "Health & Wellness > Supplements",
    frontUrl: "https://example.com/naturalstacks_front.jpg",
    backUrl: "https://example.com/naturalstacks_back.jpg",
    heroDisplayUrl: "https://example.com/naturalstacks_front.jpg",
    backDisplayUrl: "https://example.com/naturalstacks_back.jpg",
    extras: [],
    evidence: ["Brand match", "Supplement facts detected", "Visual similarity: 0.875"]
  },
];

async function testCreateDrafts() {
  console.log('🧪 Testing smartdrafts-create-drafts endpoint...\n');
  
  const url = process.env.APP_URL 
    ? `${process.env.APP_URL}/.netlify/functions/smartdrafts-create-drafts`
    : 'https://ebaywebhooks.netlify.app/.netlify/functions/smartdrafts-create-drafts';
  
  console.log(`📍 Endpoint: ${url}`);
  console.log(`📦 Sending ${sampleProducts.length} products...\n`);
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Add auth header if needed
        // 'Authorization': 'Bearer YOUR_TOKEN_HERE'
      },
      body: JSON.stringify({
        products: sampleProducts
      })
    });
    
    const data = await response.json();
    
    if (!response.ok) {
      console.error('❌ Request failed:', response.status, response.statusText);
      console.error('Error:', data);
      return;
    }
    
    console.log('✅ Success!\n');
    console.log('📊 Summary:');
    console.log(`   Total: ${data.summary?.total || 0}`);
    console.log(`   Succeeded: ${data.summary?.succeeded || 0}`);
    console.log(`   Failed: ${data.summary?.failed || 0}\n`);
    
    if (data.drafts && data.drafts.length > 0) {
      console.log('📝 Generated Drafts:\n');
      data.drafts.forEach((draft: any, index: number) => {
        console.log(`${index + 1}. ${draft.title}`);
        console.log(`   Brand: ${draft.brand}`);
        console.log(`   Product: ${draft.product}`);
        console.log(`   Category: ${draft.category.title} (${draft.category.id})`);
        console.log(`   Price: $${draft.price || 'N/A'}`);
        console.log(`   Condition: ${draft.condition || 'N/A'}`);
        console.log(`   Description: ${draft.description.slice(0, 100)}...`);
        console.log(`   Bullets: ${draft.bullets.length} items`);
        console.log(`   Aspects: ${Object.keys(draft.aspects).length} fields`);
        console.log(`   Images: ${draft.images.length} URLs\n`);
      });
    }
    
    if (data.errors && data.errors.length > 0) {
      console.log('⚠️ Errors:\n');
      data.errors.forEach((err: any) => {
        console.log(`   ${err.productId}: ${err.error}`);
      });
    }
    
    // Write full output to file
    const fs = await import('fs');
    const outputFile = 'test-create-drafts-output.json';
    fs.writeFileSync(outputFile, JSON.stringify(data, null, 2));
    console.log(`\n💾 Full output saved to: ${outputFile}`);
    
  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

// Run the test
testCreateDrafts().catch(console.error);
