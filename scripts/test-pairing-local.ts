#!/usr/bin/env node
/**
 * Test the new pairing system locally with your current photos
 * 
 * Usage:
 *   npx tsx scripts/test-pairing-local.ts [analysis-file.json]
 * 
 * This script:
 * 1. Loads analysis from JSON file (from browser Network tab or Redis export)
 * 2. Runs the NEW pairing system with color matching, distributor rescue, role override
 * 3. Shows detailed results including what pairs and why
 * 4. No server needed - runs entirely locally
 */

import { config } from "dotenv";
import fs from "fs";
import OpenAI from "openai";
import { runPairing } from "../src/pairing/runPairing.js";

config();

async function main() {
  console.log("\n🧪 TESTING NEW PAIRING SYSTEM LOCALLY\n");
  
  // Get analysis file from command line or use default
  const analysisFile = process.argv[2] || "analysis.json";
  console.log(`📁 Loading analysis from: ${analysisFile}\n`);
  
  if (!fs.existsSync(analysisFile)) {
    console.error(`❌ File not found: ${analysisFile}`);
    console.error("💡 Options:");
    console.error("   1. Export analysis from browser Network tab (Response payload)");
    console.error("   2. Use existing analysis.json in project root");
    console.error("   3. Specify a different file:");
    console.error(`      npx tsx scripts/test-pairing-local.ts path/to/analysis.json\n`);
    process.exit(1);
  }
  
  const analysisData = JSON.parse(fs.readFileSync(analysisFile, 'utf-8'));
  console.log(`✅ Loaded analysis data\n`);
  
  // Convert to format expected by runPairing (array not object)
  const analysis = {
    groups: analysisData.groups || [],
    imageInsights: Array.isArray(analysisData.imageInsights)
      ? analysisData.imageInsights
      : Object.values(analysisData.imageInsights || {})
  };
  
  console.log("📦 Analysis summary:");
  console.log(`   Groups: ${analysis.groups.length}`);
  console.log(`   Images: ${analysis.imageInsights.length}`);
  
  // Count roles
  const roleCounts = { front: 0, back: 0, other: 0 };
  for (const ins of analysis.imageInsights) {
    const role = ins.role || 'other';
    roleCounts[role as keyof typeof roleCounts] = (roleCounts[role as keyof typeof roleCounts] || 0) + 1;
  }
  console.log(`   Fronts: ${roleCounts.front}, Backs: ${roleCounts.back}, Other: ${roleCounts.other}\n`);
  
  // Show what we're looking for
  console.log("🎯 Expected products (from groups):");
  const uniqueBrands = new Set<string>();
  for (const g of analysis.groups) {
    const brand = g.brand || 'Unknown';
    const product = g.product || 'Unknown';
    if (brand !== 'Unknown' && !product.includes('Unidentified')) {
      console.log(`   - ${brand} / ${product}`);
      uniqueBrands.add(brand.toLowerCase());
    }
  }
  const expectedPairs = uniqueBrands.size;
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
  
  // Check for cross-brand pairing (wrong!)
  const crossBrandPairs = result.pairs.filter(p => {
    const frontBrand = (p.brand || '').toLowerCase();
    // Find back brand from insights
    const backInsight = analysis.imageInsights.find((ins: any) => 
      (ins.url || '').includes(p.backUrl) || (ins.key || '') === p.backUrl
    );
    // Try to find back brand from groups
    let backBrand = '';
    for (const g of analysis.groups) {
      if ((g.images || []).some((img: string) => img.includes(p.backUrl))) {
        backBrand = (g.brand || '').toLowerCase();
        break;
      }
    }
    
    if (backBrand && frontBrand && backBrand !== frontBrand) {
      console.log(`   ❌ Cross-brand pair: ${p.frontUrl} (${frontBrand}) → ${p.backUrl} (${backBrand})`);
      return true;
    }
    return false;
  });
  
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
    console.log(`   ⚠️  Color matching not used (no color evidence found)`);
  }
  
  console.log("\n" + "=".repeat(80) + "\n");
}

main().catch(err => {
  console.error("\n❌ ERROR:", err.message);
  console.error(err.stack);
  process.exit(1);
});
