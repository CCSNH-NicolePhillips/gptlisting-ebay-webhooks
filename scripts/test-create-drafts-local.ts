#!/usr/bin/env tsx
/**
 * Test smartdrafts-create-drafts locally without HTTP
 */

import { config } from "dotenv";
config();

// Sample products from pairing results
const sampleProducts = [
  {
    productId: "wishtrend_cleanser",
    brand: "Wishtrend",
    product: "Mandelic Acid 5% Skin Prep Water",
    heroDisplayUrl: "https://example.com/front.jpg",
    backDisplayUrl: "https://example.com/back.jpg",
    categoryPath: "Health & Beauty > Skin Care > Cleansers",
    extras: [],
  },
  {
    productId: "natural_stacks_supplement", 
    brand: "Natural Stacks",
    product: "BioCreatine Supplement",
    heroDisplayUrl: "https://example.com/front2.jpg",
    backDisplayUrl: "https://example.com/back2.jpg",
    categoryPath: "Health & Beauty > Vitamins & Supplements",
    extras: [],
  },
];

async function testCreateDraftsLocal() {
  console.log("🧪 Testing smartdrafts-create-drafts locally...\n");
  
  // Import the function directly
  const { createDraftForProduct } = await import("../netlify/functions/smartdrafts-create-drafts.js");
  
  console.log(`📦 Processing ${sampleProducts.length} products...\n`);
  
  for (const product of sampleProducts) {
    try {
      console.log(`\n${"=".repeat(60)}`);
      console.log(`Processing: ${product.brand} ${product.product}`);
      console.log("=".repeat(60));
      
      const draft = await createDraftForProduct(product);
      
      console.log("\n✅ Draft created successfully!");
      console.log("\n📝 Draft Details:");
      console.log(`  Title: ${draft.title}`);
      console.log(`  Description: ${draft.description.substring(0, 100)}...`);
      console.log(`  Bullets: ${draft.bullets.length} items`);
      console.log(`  Aspects: ${Object.keys(draft.aspects).length} attributes`);
      console.log(`  Category: ${draft.category.title} (${draft.category.id})`);
      console.log(`  Price: $${draft.price}`);
      console.log(`  Condition: ${draft.condition}`);
      console.log(`  Images: ${draft.images.length}`);
      
    } catch (error: any) {
      console.error(`\n❌ Error processing ${product.productId}:`, error.message);
    }
  }
  
  console.log("\n" + "=".repeat(60));
  console.log("✅ Local test complete!");
}

testCreateDraftsLocal().catch(err => {
  console.error("\n❌ Test failed:", err.message);
  console.error(err.stack);
  process.exit(1);
});
