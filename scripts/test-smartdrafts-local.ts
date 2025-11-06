// Quick local test: analyze + pair using real Dropbox photos via local Netlify dev server
// Usage: tsx scripts/test-smartdrafts-local.ts [folderPath]
// Make sure "netlify dev" is running in another terminal first!

import fs from "fs";

const BASE_URL = "http://localhost:8888/.netlify/functions";

async function main() {
  const folderPath = process.argv[2] || "/EBAY";
  
  console.log(`\n🔍 Step 1: Analyzing folder "${folderPath}" with real Dropbox photos...\n`);
  
  // Step 1: Analyze images
  const analyzeRes = await fetch(`${BASE_URL}/smartdrafts-analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folder: folderPath, forceRescan: true })
  });
  
  if (!analyzeRes.ok) {
    const err = await analyzeRes.text();
    throw new Error(`Analyze failed: ${analyzeRes.status}\n${err}`);
  }
  
  const analysis = await analyzeRes.json();
  const insightsCount = Array.isArray(analysis.imageInsights) 
    ? analysis.imageInsights.length 
    : Object.keys(analysis.imageInsights || {}).length;
  
  console.log(`✅ Analysis complete: ${analysis.groups?.length || 0} groups, ${insightsCount} insights\n`);
  
  // Save analysis for inspection
  fs.writeFileSync("analysis-live.json", JSON.stringify(analysis, null, 2));
  console.log(`💾 Saved to analysis-live.json\n`);
  
  // Show groups summary
  console.log("📦 GROUPS:");
  for (const g of analysis.groups || []) {
    console.log(`  ${g.groupId}: ${g.brand} - ${g.product} (${g.images?.length || 0} images)`);
  }
  console.log();
  
  // Show insights summary
  console.log("🔍 IMAGE INSIGHTS:");
  const insights = Array.isArray(analysis.imageInsights) 
    ? analysis.imageInsights 
    : Object.values(analysis.imageInsights || {});
  for (const ins of insights) {
    const key = ins.key || ins.url;
    console.log(`  ${key}: role=${ins.role}, hasFacts=${(ins.evidenceTriggers || []).length > 0}`);
  }
  console.log();
  
  console.log(`\n🔗 Step 2: Running pairing...\n`);
  
  // Step 2: Pair images
  const pairingRes = await fetch(`${BASE_URL}/smartdrafts-pairing`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ analysis })
  });
  
  if (!pairingRes.ok) {
    const err = await pairingRes.text();
    throw new Error(`Pairing failed: ${pairingRes.status}\n${err}`);
  }
  
  const pairingData = await pairingRes.json();
  const pairing = pairingData.pairing;
  
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
  
  if (pairing.debug) {
    console.log("\n🐛 DEBUG INFO:\n");
    console.log(`  Total fronts: ${pairing.debug.totalFronts || 0}`);
    console.log(`  Total backs: ${pairing.debug.totalBacks || 0}`);
    console.log(`  Auto pairs: ${pairing.debug.autoPairs || 0}`);
    console.log(`  GPT pairs: ${pairing.debug.gptPairs || 0}\n`);
    
    if (pairing.debug.candidates?.length > 0) {
      console.log("  Candidate Details:");
      for (const c of pairing.debug.candidates) {
        console.log(`    ${c.frontKey} → ${c.bestBackKey}`);
        console.log(`      Score: ${c.bestScore}, Gap: ${c.gap}, Accepted: ${c.accepted} (${c.rule})`);
        console.log(`      Front: ${c.frontBrand} / ${c.frontCategory} / ${c.frontBucket}`);
        console.log(`      Back:  ${c.bestBackBrand} / ${c.bestBackCategory} / ${c.bestBackBucket} / role=${c.bestBackRole} / hasFacts=${c.bestBackHasFacts}\n`);
      }
    }
  }
  
  // Final summary
  console.log(`\n✅ COMPLETE: ${pairing.products?.length || 0} products created\n`);
  console.log(`Expected: 4 products (myBrainCo, Frog Fuel, Nusava, R+Co)`);
  console.log(`Got: ${pairing.products?.length || 0} products`);
  
  if (pairing.products?.length !== 4) {
    console.log(`\n⚠️  Mismatch! Check pairing-live.json for details.\n`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error("\n❌ ERROR:", err.message);
  process.exit(1);
});
