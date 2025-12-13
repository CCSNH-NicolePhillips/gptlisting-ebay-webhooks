#!/usr/bin/env tsx
/**
 * Complete Local Test: Vision → Pairing V2 → Draft Creation
 * Tests the full pipeline with local images from testDropbox/newStuff
 * 
 * This simulates the exact production flow:
 * 1. Vision analysis (extract keyText, categoryPath)
 * 2. Pairing V2 (classify images, pair front/back)
 * 3. Draft creation (with keyText and categoryPath available)
 * 
 * Usage: tsx scripts/test-full-pipeline-local.ts
 */

import "dotenv/config";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { runNewTwoStagePipeline } from "../src/smartdrafts/pairing-v2-core.js";

async function main() {
  console.log("🧪 Full Pipeline Local Test");
  console.log("=" .repeat(70));
  console.log("Testing: Vision → Pairing V2 → Draft Creation");
  console.log("Images: testDropbox/newStuff (Root Sculpt + Vita PLynxera)");
  console.log("=" .repeat(70));

  // Use Root Sculpt images (front and back)
  const photoDir = join(process.cwd(), "testDropbox", "newStuff");
  
  if (!existsSync(photoDir)) {
    console.error(`❌ Directory not found: ${photoDir}`);
    process.exit(1);
  }

  const allFiles = readdirSync(photoDir).filter(f => 
    f.endsWith('.jpg') || f.endsWith('.jpeg') || f.endsWith('.png')
  );
  
  console.log(`\n📸 Found ${allFiles.length} images in testDropbox/newStuff`);
  
  // Select test images - Maude (front + back)
  const maudeFront = "20251115_143002.jpg"; // Maude front panel
  const maudeBack = "20251115_143030.jpg";   // Maude back panel
  
  const testImages = [maudeFront, maudeBack];
  const imagePaths = testImages
    .filter(f => allFiles.includes(f))
    .map(f => join(photoDir, f));
  
  if (imagePaths.length !== 2) {
    console.error(`❌ Expected 2 test images, found ${imagePaths.length}`);
    console.error(`Missing: ${testImages.filter(f => !allFiles.includes(f)).join(', ')}`);
    process.exit(1);
  }
  
  console.log(`\n✅ Using test images:`);
  imagePaths.forEach((p, i) => {
    const filename = p.split(/[\\/]/).pop();
    console.log(`   ${i + 1}. ${filename}`);
  });

  // ================================================================
  // STAGE 1: Pairing V2 Classification + Pairing
  // ================================================================
  console.log("\n\n" + "=".repeat(70));
  console.log("STAGE 1: Pairing V2 (Classification → Pairing → Verification)");
  console.log("=".repeat(70));
  
  const pairingResult = await runNewTwoStagePipeline(imagePaths);
  
  console.log("\n✅ Pairing V2 Complete");
  console.log(`   Pairs: ${pairingResult.pairs.length}`);
  console.log(`   Unpaired: ${pairingResult.unpaired.length}`);
  
  // Display pairs with keyText and categoryPath
  console.log("\n📦 Paired Products:");
  for (const pair of pairingResult.pairs) {
    const frontName = pair.front.split(/[\\/]/).pop();
    const backName = pair.back.split(/[\\/]/).pop();
    
    console.log(`\n   ${pair.brand || 'Unknown'} - ${pair.product || 'Unknown'}`);
    console.log(`   Front: ${frontName}`);
    console.log(`   Back:  ${backName}`);
    console.log(`   Confidence: ${(pair.confidence * 100).toFixed(0)}%`);
    console.log(`   photoQuantity: ${pair.photoQuantity || 1} (max across front/back)`);
    console.log(`   keyText: [${(pair.keyText || []).join(', ')}]`);
    console.log(`   categoryPath: ${pair.categoryPath || 'NOT EXTRACTED ❌'}`);
    
    if (!pair.categoryPath) {
      console.log(`   ⚠️ WARNING: categoryPath missing! GPT will have no category hint.`);
    }
  }
  
  // ================================================================
  // STAGE 2: Check Data for Draft Creation
  // ================================================================
  console.log("\n\n" + "=".repeat(70));
  console.log("STAGE 2: Draft Creation Data Check");
  console.log("=".repeat(70));
  
  for (const pair of pairingResult.pairs) {
    console.log(`\n📋 Product: ${pair.brand} ${pair.product}`);
    
    // Check keyText
    if (pair.keyText && pair.keyText.length > 0) {
      console.log(`   ✅ keyText available (${pair.keyText.length} items)`);
      console.log(`      → Will be used in price search: "${pair.brand} ${pair.product} ${pair.keyText.join(' ')}"`);
      console.log(`      → Will be sent to GPT prompt as "Product Label Text"`);
    } else {
      console.log(`   ❌ keyText MISSING - price search will be generic`);
    }
    
    // Check categoryPath
    if (pair.categoryPath) {
      console.log(`   ✅ categoryPath available: "${pair.categoryPath}"`);
      console.log(`      → GPT will use this as a category hint`);
      
      // Infer expected eBay category
      if (pair.categoryPath.includes('Vitamin') || pair.categoryPath.includes('Supplement')) {
        console.log(`      → Expected category: Dietary Supplements (180960) or similar`);
      } else if (pair.categoryPath.includes('Beauty') || pair.categoryPath.includes('Cosmetic')) {
        console.log(`      → Expected category: Beauty category`);
      }
    } else {
      console.log(`   ❌ categoryPath MISSING`);
      console.log(`      → GPT will use fallback categories (may select "Every Other Thing")`);
    }
    
    // Check formulation info
    const hasFormulation = pair.keyText?.some(text => 
      /capsule|tablet|liquid|powder|gummy/i.test(text)
    );
    
    if (hasFormulation) {
      console.log(`   ✅ Formulation detected in keyText`);
      console.log(`      → GPT should read formulation from label text`);
    } else {
      console.log(`   ⚠️ No formulation in keyText - GPT may guess`);
    }
  }
  
  // ================================================================
  // VALIDATION SUMMARY
  // ================================================================
  console.log("\n\n" + "=".repeat(70));
  console.log("VALIDATION SUMMARY");
  console.log("=".repeat(70));
  
  const allHaveKeyText = pairingResult.pairs.every(p => p.keyText && p.keyText.length > 0);
  const allHaveCategoryPath = pairingResult.pairs.every(p => p.categoryPath);
  const expectedPairCount = 2; // Root Sculpt + Vita PLynxera
  
  console.log(`\n📊 Results:`);
  console.log(`   Pairs created: ${pairingResult.pairs.length}/${expectedPairCount}`);
  console.log(`   keyText coverage: ${pairingResult.pairs.filter(p => p.keyText?.length).length}/${pairingResult.pairs.length}`);
  console.log(`   categoryPath coverage: ${pairingResult.pairs.filter(p => p.categoryPath).length}/${pairingResult.pairs.length}`);
  
  let success = true;
  
  if (pairingResult.pairs.length !== expectedPairCount) {
    console.log(`\n❌ FAILED: Expected ${expectedPairCount} pairs, got ${pairingResult.pairs.length}`);
    success = false;
  }
  
  if (!allHaveKeyText) {
    console.log(`\n❌ FAILED: Not all pairs have keyText`);
    console.log(`   This will cause generic price searches`);
    success = false;
  }
  
  if (!allHaveCategoryPath) {
    console.log(`\n❌ FAILED: Not all pairs have categoryPath`);
    console.log(`   This will cause wrong category selection`);
    success = false;
  }
  
  if (success) {
    console.log(`\n✅ SUCCESS: All validation checks passed!`);
    console.log(`\n📝 What this means for production:`);
    console.log(`   1. Price lookup will use specific searches (e.g., "Root Sculpt Dietary Supplement")`);
    console.log(`   2. GPT will have category hints (e.g., "Health & Personal Care > Vitamins")`);
    console.log(`   3. Formulation will be read from label text (not guessed)`);
    console.log(`   4. Category should be supplement category (180960), not "Every Other Thing"`);
  } else {
    console.log(`\n❌ VALIDATION FAILED`);
    console.log(`\nPossible issues:`);
    console.log(`   1. Pairing V2 classification not extracting categoryPath from GPT response`);
    console.log(`   2. Classification prompt not asking for categoryPath`);
    console.log(`   3. Vision API data not being used`);
  }
  
  console.log("\n" + "=".repeat(70));
  
  process.exit(success ? 0 : 1);
}

main().catch(err => {
  console.error("\n❌ ERROR:", err.message);
  console.error(err.stack);
  process.exit(1);
});
