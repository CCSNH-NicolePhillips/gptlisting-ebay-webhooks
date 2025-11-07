#!/usr/bin/env tsx
/**
 * Test full SmartDrafts flow: scan → pair → create drafts (via endpoints)
 */

import { config } from "dotenv";
config();

const APP_URL = process.env.APP_URL || "https://ebaywebhooks.netlify.app";

async function testFullEndpointFlow() {
  console.log("🧪 Testing full SmartDrafts endpoint flow\n");
  console.log("=" .repeat(60));
  
  // Use your test3 folder
  const folderUrl = "https://www.dropbox.com/scl/fo/eqcqbslf6xnb9aaexfttf/AELdgj89mHs09hCiJnQjxOs?rlkey=wawx0vczfq4yjhvxqzf7xqb0u&st=4wfkj3f3&dl=0";
  
  console.log("\n📁 Test Folder: /test3");
  console.log(`🔗 URL: ${folderUrl.substring(0, 60)}...`);
  
  // Step 1: Scan
  console.log("\n" + "=" .repeat(60));
  console.log("STEP 1: Scanning folder");
  console.log("=" .repeat(60));
  
  const scanUrl = `${APP_URL}/.netlify/functions/smartdrafts-scan-bg`;
  const scanResponse = await fetch(scanUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Test-Mode": "true",
    },
    body: JSON.stringify({ folder: folderUrl, force: true }),
  });
  
  if (!scanResponse.ok) {
    const error = await scanResponse.text();
    throw new Error(`Scan failed: ${scanResponse.status} ${error}`);
  }
  
  const scanResult = await scanResponse.json();
  console.log(`✅ Scan complete`);
  console.log(`   Groups: ${scanResult.groups?.length || 0}`);
  console.log(`   Orphans: ${scanResult.orphans?.length || 0}`);
  
  // Step 2: Pair
  console.log("\n" + "=" .repeat(60));
  console.log("STEP 2: Pairing products");
  console.log("=" .repeat(60));
  
  const pairUrl = `${APP_URL}/.netlify/functions/smartdrafts-pairing`;
  const pairResponse = await fetch(pairUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Test-Mode": "true",
    },
    body: JSON.stringify({ folder: folderUrl }),
  });
  
  if (!pairResponse.ok) {
    const error = await pairResponse.text();
    throw new Error(`Pairing failed: ${pairResponse.status} ${error}`);
  }
  
  const pairResult = await pairResponse.json();
  console.log(`✅ Pairing complete`);
  console.log(`   Products: ${pairResult.products?.length || 0}`);
  
  if (!pairResult.products || pairResult.products.length === 0) {
    console.log("\n⚠️  No products to create drafts for");
    return;
  }
  
  // Show paired products
  console.log("\n📦 Paired Products:");
  for (const product of pairResult.products) {
    console.log(`   • ${product.brand} ${product.product} (${product.productId})`);
  }
  
  // Step 3: Create Drafts
  console.log("\n" + "=" .repeat(60));
  console.log("STEP 3: Creating drafts with ChatGPT");
  console.log("=" .repeat(60));
  
  const draftsUrl = `${APP_URL}/.netlify/functions/smartdrafts-create-drafts`;
  const draftsResponse = await fetch(draftsUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Test-Mode": "true",
    },
    body: JSON.stringify({ products: pairResult.products }),
  });
  
  if (!draftsResponse.ok) {
    const error = await draftsResponse.text();
    throw new Error(`Create drafts failed: ${draftsResponse.status} ${error}`);
  }
  
  const draftsResult = await draftsResponse.json();
  console.log(`✅ Drafts created`);
  console.log(`   Total: ${draftsResult.summary.total}`);
  console.log(`   Succeeded: ${draftsResult.summary.succeeded}`);
  console.log(`   Failed: ${draftsResult.summary.failed}`);
  
  // Show draft details
  console.log("\n" + "=" .repeat(60));
  console.log("📝 GENERATED DRAFTS");
  console.log("=" .repeat(60));
  
  for (let i = 0; i < draftsResult.drafts.length; i++) {
    const draft = draftsResult.drafts[i];
    console.log(`\n${i + 1}. ${draft.title}`);
    console.log(`   Brand: ${draft.brand}`);
    console.log(`   Product: ${draft.product}`);
    console.log(`   Category: ${draft.category.title}`);
    console.log(`   Price: $${draft.price}`);
    console.log(`   Condition: ${draft.condition}`);
    console.log(`   Description: ${draft.description.substring(0, 100)}...`);
    console.log(`   Bullets: ${draft.bullets.length} items`);
    draft.bullets.forEach((bullet: string, idx: number) => {
      console.log(`      ${idx + 1}. ${bullet}`);
    });
    console.log(`   Aspects: ${Object.keys(draft.aspects).length} fields`);
    Object.entries(draft.aspects).forEach(([key, values]: [string, any]) => {
      console.log(`      • ${key}: ${Array.isArray(values) ? values.join(', ') : values}`);
    });
    console.log(`   Images: ${draft.images.length} URLs`);
  }
  
  // Save output
  const fs = await import("fs/promises");
  await fs.writeFile(
    "test-smartdrafts-full-endpoint-output.json",
    JSON.stringify(draftsResult, null, 2)
  );
  
  console.log("\n" + "=" .repeat(60));
  console.log("✅ Full endpoint flow test complete!");
  console.log(`💾 Output saved to: test-smartdrafts-full-endpoint-output.json`);
  console.log("=" .repeat(60));
}

testFullEndpointFlow().catch(err => {
  console.error("\n❌ Test failed:", err.message);
  console.error(err.stack);
  process.exit(1);
});
