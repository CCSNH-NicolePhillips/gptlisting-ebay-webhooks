#!/usr/bin/env tsx
/**
 * Full local test: analyze real photos → pair them
 * Should produce 4 products
 */

import { readFileSync } from "fs";
import { join } from "path";
import OpenAI from "openai";
import { analyzeImages } from "../src/services/vision.js";
import { runPairing } from "../src/pairing/runPairing.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function main() {
  console.log("🧪 Full Local Test: Analyze + Pair");
  console.log("=" .repeat(60));

  const photoDir = join(process.cwd(), "testDropbox", "EBAY");
  const photos = [
    "asd32q.jpg",      // R+Co front
    "azdfkuj.jpg",     // R+Co back
    "awef.jpg",        // myBrainCo front
    "awefawed.jpg",    // myBrainCo back
    "frog_01.jpg",     // Frog Fuel front
    "faeewfaw.jpg",    // Frog Fuel back
    "rgxbbg.jpg",      // Nusava front
    "dfzdvzer.jpg",    // Nusava back
    "IMG_20251102_144346.jpg" // extra
  ];

  // Step 1: Analyze photos
  console.log("\n📸 Step 1: Analyzing photos with Vision API...");
  const imageUrls = photos.map(f => join(photoDir, f));
  
  const analysis = await analyzeImages(client, imageUrls, {
    model: "gpt-4o",
    maxTokens: 3000
  });

  console.log(`✅ Analysis complete: ${analysis.imageInsights.length} images`);
  
  // Show what was extracted
  for (const insight of analysis.imageInsights) {
    const filename = insight.url.split(/[\\/]/).pop();
    console.log(`  ${filename}:`);
    console.log(`    Role: ${insight.role}`);
    console.log(`    Text: ${insight.textExtracted.substring(0, 100)}...`);
  }

  // Step 2: Pair them
  console.log("\n🔗 Step 2: Running pairing algorithm...");
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
    console.log("✅ SUCCESS!");
  } else {
    console.log("❌ FAILED - not 4 products");
    process.exit(1);
  }
}

main().catch(console.error);
