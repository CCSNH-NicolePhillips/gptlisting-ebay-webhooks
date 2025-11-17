#!/usr/bin/env node
/**
 * Test the new pairing system locally with data from Redis
 * 
 * Usage:
 *   npx tsx scripts/test-pairing-from-redis.ts [folder]
 * 
 * This script:
 * 1. Connects to Redis and pulls the cached analysis (same data the UI uses)
 * 2. Runs the NEW pairing system with color matching, distributor rescue, role override
 * 3. Shows detailed results including what pairs and why
 * 4. No browser/server needed - runs entirely locally
 */

import { config } from "dotenv";
import OpenAI from "openai";
import { runPairing } from "../src/pairing/runPairing.js";
import { createClient } from "redis";

config();

async function main() {
  console.log("\n🧪 TESTING NEW PAIRING SYSTEM WITH REDIS DATA\n");
  
  // Get folder from command line or use default
  const folder = process.argv[2] || "testDropbox/EBAY";
  console.log(`📁 Using folder: ${folder}\n`);
  
  // Connect to Redis to get the same cached data the UI uses
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.error("❌ REDIS_URL not found in environment");
    console.error("💡 Make sure you have a .env file with REDIS_URL set\n");
    process.exit(1);
  }
  
  console.log("🔗 Connecting to Redis...");
  const redis = createClient({ url: redisUrl });
  await redis.connect();
  console.log("✅ Connected to Redis\n");
  
  // Get cached analysis (same key format as Netlify function)
  const cacheKey = `smartdrafts-scan:${folder}`;
  console.log(`🔍 Looking for cached scan: ${cacheKey}`);
  const cachedStr = await redis.get(cacheKey);
  
  if (!cachedStr) {
    console.error(`❌ No cached scan found for folder: ${folder}`);
    console.error("💡 Run 'Force Rescan' in the UI first, or specify a different folder:");
    console.error(`   npx tsx scripts/test-pairing-from-redis.ts "your/folder/path"\n`);
    await redis.disconnect();
    process.exit(1);
  }
  
  const cached = JSON.parse(cachedStr);
  console.log(`✅ Found cached scan with ${Object.keys(cached.imageInsights || {}).length} images\n`);
  
  await redis.disconnect();
  
  // Convert to format expected by runPairing (array not object)
  const analysis = {
    groups: cached.groups || [],
    imageInsights: Array.isArray(cached.imageInsights)
      ? cached.imageInsights
      : Object.values(cached.imageInsights || {})
  };
  
  console.log("📦 Analysis summary:");
  console.log(`   Groups: ${analysis.groups.length}`);
  console.log(`   Images: ${analysis.imageInsights.length}`);
  
  // Count roles
  const roleCounts: Record<string, number> = { front: 0, back: 0, other: 0 };
  for (const ins of analysis.imageInsights) {
    const role = ins.role || 'other';
    roleCounts[role] = (roleCounts[role] || 0) + 1;
  }
  console.log(`   Fronts: ${roleCounts.front}, Backs: ${roleCounts.back}, Other: ${roleCounts.other}\n`);
  
  // Show what we're looking for
  console.log("🎯 Expected products (from groups):");
  const uniqueProducts = new Map<string, string>();
  for (const g of analysis.groups) {
    const brand = g.brand || 'Unknown';
    const product = g.product || 'Unknown';
    if (brand !== 'Unknown' && !product.includes('Unidentified')) {
      const key = `${brand.toLowerCase()} | ${product.toLowerCase()}`;
      uniqueProducts.set(key, `${brand} / ${product}`);
    }
  }
  
  for (const [_, label] of uniqueProducts) {
    console.log(`   - ${label}`);
  }
  
  const expectedPairs = uniqueProducts.size;
  console.log(`\n   Expected pairs: ~${expectedPairs} (one per unique product)\n`);
  
  // Run the NEW pairing system
  console.log("🔗 Running NEW pairing system with enhancements...");
  console.log("   ✓ Color matching (+1.5 bonus)");
  console.log("   ✓ Distributor rescue (+1.5 for brand mismatch)");
  console.log("   ✓ Role override (reduce penalty)\n");
  
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const { result, metrics } = await runPairing({
    client,
    analysis,
    log: console.log
  });
  
  console.log("\n" + "=".repeat(80));
  console.log("\n📊 PAIRING RESULTS\n");
  console.log("=".repeat(80) + "\n");
  
  if (result.pairs.length === 0) {
    console.log("❌ NO PAIRS FOUND\n");
  } else {
    for (let i = 0; i < result.pairs.length; i++) {
      const pair = result.pairs[i];
      console.log(`${i + 1}. ${pair.brand} - ${pair.product}`);
      console.log(`   Front: ${pair.frontUrl}`);
      console.log(`   Back:  ${pair.backUrl}`);
      console.log(`   Score: ${pair.matchScore?.toFixed(2) || 'N/A'}`);
      console.log(`   Confidence: ${pair.confidence?.toFixed(2) || 'N/A'}`);
      if (pair.evidence && pair.evidence.length > 0) {
        console.log(`   Evidence:`);
        for (const ev of pair.evidence.slice(0, 3)) {
          console.log(`     - ${ev}`);
        }
      }
      console.log();
    }
  }
  
  if (result.singletons && result.singletons.length > 0) {
    console.log("🔸 UNPAIRED IMAGES:\n");
    for (const s of result.singletons) {
      console.log(`   - ${s.url}: ${s.reason}`);
    }
    console.log();
  }
  
  console.log("=".repeat(80));
  console.log("\n📈 METRICS\n");
  console.log("=".repeat(80) + "\n");
  
  if (metrics) {
    console.log(`Total images:  ${metrics.totals.images}`);
    console.log(`Fronts:        ${metrics.totals.fronts}`);
    console.log(`Backs:         ${metrics.totals.backs}`);
    console.log(`Auto pairs:    ${metrics.totals.autoPairs} (high confidence, no GPT needed)`);
    console.log(`Model pairs:   ${metrics.totals.modelPairs} (GPT tiebreaker used)`);
    console.log(`Singletons:    ${metrics.totals.singletons}`);
    console.log();
  }
  
  console.log("=".repeat(80));
  console.log("\n🎯 SUCCESS ANALYSIS\n");
  console.log("=".repeat(80) + "\n");
  
  const actualPairs = result.pairs.length;
  console.log(`Expected pairs: ~${expectedPairs}`);
  console.log(`Actual pairs:   ${actualPairs}`);
  
  if (actualPairs >= expectedPairs * 0.8) {
    console.log(`\n✅ SUCCESS! Got ${actualPairs}/${expectedPairs} pairs (${Math.round(actualPairs / expectedPairs * 100)}%)`);
  } else {
    console.log(`\n⚠️  WARNING: Only got ${actualPairs}/${expectedPairs} pairs (${Math.round(actualPairs / expectedPairs * 100)}%)`);
    console.log(`\nCheck the unpaired images above to see why they didn't match.`);
  }
  
  console.log("\n" + "=".repeat(80) + "\n");
  
  // Check for specific issues
  console.log("🔍 QUALITY CHECKS:\n");
  
  // Build brand map from groups
  const urlToBrand = new Map<string, string>();
  for (const g of analysis.groups) {
    const brand = (g.brand || '').toLowerCase();
    for (const img of (g.images || [])) {
      const key = img.split('/').pop() || img;
      urlToBrand.set(key, brand);
    }
  }
  
  // Check for cross-brand pairing (wrong!)
  const crossBrandPairs: any[] = [];
  for (const p of result.pairs) {
    const frontKey = p.frontUrl.split('/').pop() || p.frontUrl;
    const backKey = p.backUrl.split('/').pop() || p.backUrl;
    
    const frontBrand = urlToBrand.get(frontKey) || (p.brand || '').toLowerCase();
    const backBrand = urlToBrand.get(backKey);
    
    if (frontBrand && backBrand && frontBrand !== backBrand && backBrand !== 'unknown') {
      console.log(`   ❌ Cross-brand pair: ${p.frontUrl} (${frontBrand}) → ${p.backUrl} (${backBrand})`);
      crossBrandPairs.push(p);
    }
  }
  
  if (crossBrandPairs.length === 0) {
    console.log("   ✅ No cross-brand pairings (all pairs have matching brands)");
  } else {
    console.log(`   ❌ Found ${crossBrandPairs.length} cross-brand pairings (ERROR!)`);
  }
  
  console.log();
  
  // Check for color matching being used
  const colorMatchedPairs = result.pairs.filter(p => 
    p.evidence?.some(ev => ev.toLowerCase().includes('color'))
  );
  if (colorMatchedPairs.length > 0) {
    console.log(`   ✅ Color matching used in ${colorMatchedPairs.length} pairs`);
  } else {
    console.log(`   ℹ️  Color matching not used (no pairs had matching colors)`);
  }
  
  // Check for distributor rescue being used
  const distributorRescuePairs = result.pairs.filter(p => 
    p.evidence?.some(ev => ev.toLowerCase().includes('distributor'))
  );
  if (distributorRescuePairs.length > 0) {
    console.log(`   ✅ Distributor rescue used in ${distributorRescuePairs.length} pairs`);
  } else {
    console.log(`   ℹ️  Distributor rescue not used (no brand mismatches with strong product evidence)`);
  }
  
  console.log("\n" + "=".repeat(80) + "\n");
  
  // Show specific problem cases if any
  if (actualPairs < expectedPairs) {
    console.log("🔎 DEBUGGING UNPAIRED PRODUCTS:\n");
    
    // Find fronts without pairs
    const pairedFronts = new Set(result.pairs.map(p => p.frontUrl.split('/').pop() || p.frontUrl));
    const pairedBacks = new Set(result.pairs.map(p => p.backUrl.split('/').pop() || p.backUrl));
    
    const unpairedFronts = analysis.imageInsights
      .filter((ins: any) => ins.role === 'front')
      .filter((ins: any) => {
        const key = (ins.url || ins.key || '').split('/').pop();
        return !pairedFronts.has(key);
      });
    
    const unpairedBacks = analysis.imageInsights
      .filter((ins: any) => ins.role === 'back')
      .filter((ins: any) => {
        const key = (ins.url || ins.key || '').split('/').pop();
        return !pairedBacks.has(key);
      });
    
    console.log(`Unpaired fronts: ${unpairedFronts.length}`);
    for (const front of unpairedFronts) {
      const url = front.url || front.key;
      const brand = urlToBrand.get(url.split('/').pop() || url);
      console.log(`  - ${url} (brand: ${brand || 'unknown'}, color: ${front.dominantColor || 'none'})`);
    }
    
    console.log(`\nUnpaired backs: ${unpairedBacks.length}`);
    for (const back of unpairedBacks) {
      const url = back.url || back.key;
      const brand = urlToBrand.get(url.split('/').pop() || url);
      console.log(`  - ${url} (brand: ${brand || 'unknown'}, color: ${back.dominantColor || 'none'})`);
    }
    
    console.log("\n" + "=".repeat(80) + "\n");
  }
}

main().catch(err => {
  console.error("\n❌ ERROR:", err.message);
  console.error(err.stack);
  process.exit(1);
});
