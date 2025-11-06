// Direct test: analyze + pair using real Dropbox photos (no server needed)
// Usage: tsx scripts/test-dropbox-full.ts [folderPath]

import fs from "fs";
import { config } from "dotenv";
import OpenAI from "openai";
import { runSmartDraftScan } from "../src/lib/smartdrafts-scan-core.js";
import { runPairing } from "../src/pairing/runPairing.js";

// Load environment variables
config();

async function main() {
  const folderPath = process.argv[2] || "/EBAY";
  
  console.log(`\n🔍 Step 1: Analyzing folder "${folderPath}" with real Dropbox photos...\n`);
  
  // Step 1: Analyze images using runSmartDraftScan
  const analysisResult = await runSmartDraftScan({
    userId: "test-user",
    folder: folderPath
  });
  
  if (analysisResult.status !== 200 || !analysisResult.body.ok) {
    throw new Error(`Analysis failed: ${analysisResult.body.error || 'Unknown error'}`);
  }
  
  const analysis = {
    groups: analysisResult.body.groups || [],
    imageInsights: Object.values(analysisResult.body.imageInsights || {}),
    folder: analysisResult.body.folder
  };
  
  const insightsCount = Array.isArray(analysis.imageInsights) 
    ? analysis.imageInsights.length 
    : Object.keys(analysis.imageInsights || {}).length;
  
  console.log(`✅ Analysis complete: ${analysis.groups.length} groups, ${insightsCount} insights\n`);
  
  // Save analysis for inspection
  fs.writeFileSync("analysis-live.json", JSON.stringify(analysis, null, 2));
  console.log(`💾 Saved to analysis-live.json\n`);
  
  // Show groups summary
  console.log("📦 GROUPS:");
  for (const g of analysis.groups) {
    console.log(`  ${g.groupId}: ${g.brand} - ${g.product} (${g.images?.length || 0} images)`);
  }
  console.log();
  
  // Show insights summary
  console.log("🔍 IMAGE INSIGHTS:");
  const insights = Array.isArray(analysis.imageInsights) 
    ? analysis.imageInsights 
    : Object.values(analysis.imageInsights || {});
  for (const ins of insights) {
    const key = (ins as any).key || (ins as any).url;
    const hasFacts = ((ins as any).evidenceTriggers || []).length > 0;
    const textLen = ((ins as any).textExtracted || '').length;
    console.log(`  ${key}: role=${(ins as any).role}, evidenceTriggers=${hasFacts ? 'YES' : 'NO'}, textLen=${textLen}`);
  }
  console.log();
  
  console.log(`\n🔗 Step 2: Running pairing...\n`);
  
  // Step 2: Pair images using runPairing
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const { result: pairing, metrics } = await runPairing({ 
    client, 
    analysis,
    model: "gpt-4o-mini" 
  });
  
  console.log(`✅ Pairing complete: ${pairing.pairs?.length || 0} pairs, ${pairing.products?.length || 0} products\n`);
  
  // Save pairing for inspection
  fs.writeFileSync("pairing-live.json", JSON.stringify(pairing, null, 2));
  console.log(`💾 Saved to pairing-live.json\n`);
  
  // Print results
  console.log("📊 PAIRING RESULTS:\n");
  for (const pair of pairing.pairs || []) {
    console.log(`  ✓ ${pair.brand} - ${pair.product}`);
    console.log(`    Front: ${pair.frontUrl}`);
    console.log(`    Back:  ${pair.backUrl}`);
    console.log(`    Score: ${pair.matchScore}`);
    console.log(`    Evidence: ${(pair.evidence || []).join(', ')}\n`);
  }
  
  // Show metrics
  if (metrics) {
    console.log("📈 METRICS:");
    console.log(`  Images: ${metrics.images}`);
    console.log(`  Fronts: ${metrics.fronts}`);
    console.log(`  Backs: ${metrics.backs}`);
    console.log(`  Candidates: ${metrics.candidates}`);
    console.log(`  Auto pairs: ${metrics.autoPairs}`);
    console.log(`  Model pairs: ${metrics.modelPairs}`);
    console.log(`  Singletons: ${metrics.singletons}\n`);
  }
  
  // Final summary
  console.log(`\n✅ COMPLETE: ${pairing.products?.length || 0} products created\n`);
  console.log(`Expected: 4 products (myBrainCo, Frog Fuel, Nusava, R+Co)`);
  console.log(`Got: ${pairing.products?.length || 0} products`);
  
  if (pairing.products?.length !== 4) {
    console.log(`\n⚠️  MISMATCH! Expected 4, got ${pairing.products?.length}\n`);
    console.log(`Check analysis-live.json and pairing-live.json for details.\n`);
    process.exit(1);
  } else {
    console.log(`\n🎉 SUCCESS! All 4 products paired correctly!\n`);
  }
}

main().catch(err => {
  console.error("\n❌ ERROR:", err.message);
  console.error(err.stack);
  process.exit(1);
});
