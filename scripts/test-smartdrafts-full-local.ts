#!/usr/bin/env tsx
/**
 * Full SmartDrafts test: analyze real photos using PRODUCTION analyze-core → pair them
 * This simulates exactly what production does
 */

import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import OpenAI from "openai";
import { runAnalysis } from "../src/lib/analyze-core.js";
import { runPairing } from "../src/pairing/runPairing.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function main() {
  console.log("🧪 Full SmartDrafts Local Test");
  console.log("=" .repeat(60));

  const photoDir = join(process.cwd(), "testDropbox", "EBAY");
  const allFiles = readdirSync(photoDir).filter(f => f.endsWith('.jpg'));
  
  // Use the 9 main photos (excluding duplicates)
  const uniquePhotos = allFiles.filter(f => !f.includes('untitled'));
  console.log(`\n📸 Found ${uniquePhotos.length} photos in testDropbox/EBAY`);
  
  // Convert to file:// URLs since we're local
  const imageUrls = uniquePhotos.map(f => `file://${join(photoDir, f).replace(/\\/g, '/')}`);
  
  // Step 1: Analyze using PRODUCTION analyze-core.ts
  console.log("\n📊 Step 1: Analyzing with runAnalysis() (PRODUCTION code)...");
  console.log("  (This uses the same Vision prompt as production)");
  
  const analysis = await runAnalysis(imageUrls, 12, { 
    skipPricing: true,
    forceRescan: true  // Bypass cache like "Force Rescan" checkbox does
  });

  console.log(`\n✅ Analysis complete:`);
  console.log(`  - Groups: ${analysis.groups?.length || 0}`);
  console.log(`  - Image insights: ${analysis.imageInsights?.length || 0}`);
  
  // Check if visualDescription is present
  const withVisual = analysis.imageInsights?.filter((ins: any) => ins.visualDescription).length || 0;
  console.log(`  - With visualDescription: ${withVisual}/${analysis.imageInsights?.length || 0}`);
  
  if (withVisual === 0) {
    console.log("\n❌ PROBLEM: No visualDescription fields found!");
    console.log("   This means packaging detection will fail.");
  }
  
  // Show first few insights
  console.log("\n📋 Sample insights:");
  for (const insight of (analysis.imageInsights || []).slice(0, 3)) {
    const filename = (insight as any).url?.split(/[\\/]/).pop();
    console.log(`\n  ${filename}:`);
    console.log(`    Role: ${(insight as any).role}`);
    console.log(`    Text length: ${(insight as any).textExtracted?.length || 0} chars`);
    console.log(`    Visual: ${(insight as any).visualDescription?.substring(0, 80)}...`);
  }

  // Step 2: Pair them
  console.log("\n\n🔗 Step 2: Running pairing algorithm...");
  const { result, metrics } = await runPairing({
    client,
    analysis,
    model: "gpt-4o-mini"
  });

  console.log(`\n✅ Pairing complete: ${result.products.length} products`);
  console.log("=" .repeat(60));
  
  for (const prod of result.products) {
    const frontFile = prod.front?.url.split(/[\\/]/).pop();
    const backFile = prod.back?.url.split(/[\\/]/).pop();
    console.log(`\n📦 ${prod.productName || "Unknown Product"}`);
    console.log(`   Front: ${frontFile}`);
    console.log(`   Back:  ${backFile || "none"}`);
    console.log(`   Method: ${prod.pairingMethod || "?"}`);
  }

  console.log("\n" + "=" .repeat(60));
  console.log(`🎯 Expected: 4 products`);
  console.log(`🎯 Got:      ${result.products.length} products`);
  
  if (result.products.length === 4) {
    console.log("✅ SUCCESS - Local testing matches expected behavior!");
    console.log("\nIf production still shows 2 products:");
    console.log("  1. Make sure 'Force Rescan' checkbox is checked");
    console.log("  2. Clear browser cache and try again");
    console.log("  3. Check Netlify function logs for errors");
  } else {
    console.log(`❌ FAILED - Expected 4 products, got ${result.products.length}`);
    console.log("\nMissing products likely due to:");
    console.log("  - Missing visualDescription fields");
    console.log("  - Vision API not extracting full text");
    console.log("  - Pairing algorithm issues");
    process.exit(1);
  }
}

main().catch(err => {
  console.error("\n❌ ERROR:", err.message);
  console.error(err.stack);
  process.exit(1);
});
