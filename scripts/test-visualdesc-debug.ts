#!/usr/bin/env tsx
/**
 * Debug visualDescription flow through the system
 */

import { runSmartDraftScan } from "../src/lib/smartdrafts-scan-core.js";

async function main() {
  console.log("🔍 Testing visualDescription data flow");
  console.log("=" .repeat(60));

  // Use your test3 folder
  const folderUrl = "https://www.dropbox.com/scl/fo/eqcqbslf6xnb9aaexfttf/AELdgj89mHs09hCiJnQjxOs?rlkey=wawx0vczfq4yjhvxqzf7xqb0u&st=4wfkj3f3&dl=0";
  
  console.log("\n📁 Folder:", folderUrl);
  console.log("🔄 Running scan with force=true (bypass cache)...\n");

  const result = await runSmartDraftScan({
    userId: "test-user",
    folder: folderUrl,
    force: true
  });

  console.log("\n" + "=" .repeat(60));
  console.log("📊 Scan Results:");
  console.log(`  Groups: ${result.body.groups?.length || 0}`);
  console.log(`  Orphans: ${result.body.orphans?.length || 0}`);
  
  const insights = Array.isArray(result.body.imageInsights) 
    ? result.body.imageInsights 
    : Object.values(result.body.imageInsights || {});
    
  console.log(`  Image insights: ${insights.length}`);

  // Check visualDescription presence
  let withVisualDesc = 0;
  let totalVisualLength = 0;

  console.log("\n" + "=" .repeat(60));
  console.log("🔍 Checking visualDescription in imageInsights:");
  console.log("=" .repeat(60));

  for (const insight of insights) {
    const ins = insight as any;
    const key = ins.key || ins.url?.split('/').pop() || '?';
    const hasDesc = !!(ins.visualDescription);
    const descLength = (ins.visualDescription || '').length;
    
    if (hasDesc) {
      withVisualDesc++;
      totalVisualLength += descLength;
    }

    console.log(`\n${key}:`);
    console.log(`  Has visualDescription: ${hasDesc}`);
    console.log(`  Length: ${descLength} chars`);
    if (hasDesc) {
      console.log(`  Preview: "${ins.visualDescription.substring(0, 80)}..."`);
    }
  }

  console.log("\n" + "=" .repeat(60));
  console.log("📈 Summary:");
  console.log(`  Images with visualDescription: ${withVisualDesc}/${insights.length}`);
  console.log(`  Average length: ${withVisualDesc > 0 ? Math.round(totalVisualLength / withVisualDesc) : 0} chars`);
  
  if (withVisualDesc === 0) {
    console.log("\n❌ PROBLEM: No visualDescription fields found!");
    console.log("   Check debug logs above for where data is lost:");
    console.log("   - [scan-core DEBUG] insightList sample");
    console.log("   - [mergeInsight DEBUG]");
    console.log("   - [responsePayload DEBUG]");
  } else if (withVisualDesc < insights.length) {
    console.log(`\n⚠️  WARNING: Only ${withVisualDesc}/${insights.length} images have visualDescription`);
  } else {
    console.log("\n✅ SUCCESS: All images have visualDescription!");
  }
  
  console.log("\n" + "=" .repeat(60));
}

main().catch(err => {
  console.error("\n❌ ERROR:", err.message);
  console.error(err.stack);
  process.exit(1);
});
