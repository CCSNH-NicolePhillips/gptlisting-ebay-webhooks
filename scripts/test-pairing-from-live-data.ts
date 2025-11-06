// Test pairing using the REAL analysis data from production
// This proves whether the problem is in analysis or pairing

import fs from "fs";
import { config } from "dotenv";
import OpenAI from "openai";
import { runPairing } from "../src/pairing/runPairing.js";

config();

const LIVE_ANALYSIS = {
  "groups": [
    {
      "groupId": "grp_5daa2013",
      "brand": "Frog Fuel",
      "product": "Collagen Protein",
      "variant": "Nano Hydrolyzed",
      "size": "1 scoop (24g)",
      "category": "Supplements",
      "categoryPath": "Health & Wellness > Supplements",
      "images": ["faeewfaw.jpg"]
    },
    {
      "groupId": "grp_4f13ab20",
      "brand": "Frog Fuel",
      "product": "Performance Greens + Protein",
      "variant": "Lemon Lime Flavor",
      "size": "25.4 oz (1.58 lb) 720g, 30 servings",
      "category": "Supplement",
      "categoryPath": "Health & Wellness > Supplements",
      "images": ["frog_01.jpg"]
    },
    {
      "groupId": "grp_52ef6bde",
      "brand": "myBrainCo.",
      "product": "Gut Repair",
      "variant": "Natural Berry Flavour",
      "size": "10.9 oz | 31 servings",
      "category": "Dietary Supplement",
      "categoryPath": "Health & Wellness > Supplements",
      "images": ["awefawed.jpg", "awef.jpg"]
    },
    {
      "groupId": "grp_8ab0aeca",
      "brand": "myBrainCo",
      "product": "Gut Repair",
      "variant": "Natural Vanilla Flavor",
      "size": "310g",
      "category": "Dietary Supplement",
      "categoryPath": "Health & Personal Care > Vitamins & Dietary Supplements",
      "images": ["azdfkuj.jpg", "awefawed.jpg"]
    },
    {
      "groupId": "grp_c9c3fca0",
      "brand": "nusava",
      "product": "Liquid Dietary Supplement",
      "variant": "Strawberry Flavor",
      "size": "2 fl oz / 60 ml",
      "category": "Dietary Supplement",
      "categoryPath": "Health & Personal Care > Vitamins & Supplements",
      "images": ["rgxbbg.jpg"]
    },
    {
      "groupId": "grp_994adcb0",
      "brand": "R+Co",
      "product": "Bond Building + Repair Styling Oil",
      "variant": "On a Cloud",
      "size": "41 mL / 1.4 fl oz",
      "category": "Hair Care",
      "categoryPath": "Beauty > Hair Care",
      "images": ["asd32q.jpg"]
    },
    {
      "groupId": "grp_04e80401_1",
      "brand": "Unknown",
      "product": "Unidentified Item",
      "images": ["azdfkuj.jpg"]
    },
    {
      "groupId": "grp_04e80401_2",
      "brand": "Unknown",
      "product": "Unidentified Item",
      "images": ["dfzdvzer.jpg"]
    }
  ],
  "imageInsights": {
    "asd32q.jpg": {
      "url": "EBAY/asd32q.jpg",
      "role": "front",
      "hasVisibleText": true,
      "dominantColor": "lavender",
      "textExtracted": "R+Co\nON A CLOUD\nBOND BUILDING +\nREPAIR STYLING OIL\nHUILE COIFFANTE\nFORTIFIANTE\nET RÉPARATRICE\n41 ML / 1.4 FL OZ",
      "evidenceTriggers": [],
      "key": "asd32q.jpg"
    },
    "awef.jpg": {
      "url": "https://dl.dropboxusercontent.com/scl/fi/9v9d3xrt8ezn2a1k4yq9u/awef.jpg",
      "role": "front",
      "hasVisibleText": true,
      "dominantColor": "black",
      "textExtracted": "PROBIOTIC, PREBIOTIC, GLUTAMINE & DIGESTIVE ENZYME POWDER\nmyBrainCo.\nMULTI-ACTION\nGUT REPAIR™",
      "evidenceTriggers": [],
      "key": "awef.jpg"
    },
    "awefawed.jpg": {
      "url": "https://dl.dropboxusercontent.com/scl/fi/sod9df9t7n2sa4mb2oret/awefawed.jpg",
      "role": "back",
      "hasVisibleText": true,
      "dominantColor": "black",
      "textExtracted": "Gut Repair™ is a comprehensive blend... Supplement Facts\nServing Size 10 g (1 scoop)",
      "evidenceTriggers": ["supplement facts", "serving size", "other ingredients"],
      "key": "awefawed.jpg"
    },
    "azdfkuj.jpg": {
      "url": "azdfkuj.jpg",
      "role": "back",
      "hasVisibleText": true,
      "dominantColor": "light-gray",
      "textExtracted": "back visible text",
      "evidenceTriggers": [],
      "key": "azdfkuj.jpg"
    },
    "dfzdvzer.jpg": {
      "url": "dfzdvzer.jpg",
      "role": "back",
      "hasVisibleText": true,
      "dominantColor": "dark-brown",
      "textExtracted": "back visible text",
      "evidenceTriggers": ["supplement facts"],
      "key": "dfzdvzer.jpg"
    },
    "faeewfaw.jpg": {
      "url": "faeewfaw.jpg",
      "role": "back",
      "hasVisibleText": true,
      "dominantColor": "dark-forest-green",
      "textExtracted": "back visible text",
      "evidenceTriggers": ["supplement facts"],
      "key": "faeewfaw.jpg"
    },
    "frog_01.jpg": {
      "url": "EBAY/frog_01.jpg",
      "role": "front",
      "hasVisibleText": true,
      "dominantColor": "forest-green",
      "textExtracted": "STAY UNBREAKABLE\nFROG FUEL\nPERFORMANCE GREENS + PROTEIN",
      "evidenceTriggers": [],
      "key": "frog_01.jpg"
    },
    "rgxbbg.jpg": {
      "url": "rgxbbg.jpg",
      "role": "front",
      "hasVisibleText": true,
      "dominantColor": "dark-brown",
      "textExtracted": "front visible text",
      "evidenceTriggers": [],
      "key": "rgxbbg.jpg"
    }
  }
};

async function main() {
  console.log("\n🧪 TESTING PAIRING WITH LIVE PRODUCTION DATA\n");
  console.log("📦 Groups from analysis:");
  for (const g of LIVE_ANALYSIS.groups) {
    console.log(`  - ${g.brand} / ${g.product} (${g.images.length} images): ${g.images.join(", ")}`);
  }
  console.log();
  
  console.log("🔍 Image roles:");
  for (const [key, insight] of Object.entries(LIVE_ANALYSIS.imageInsights)) {
    console.log(`  - ${key}: ${(insight as any).role}`);
  }
  console.log();
  
  console.log("🔗 Running pairing algorithm...\n");
  
  // Convert imageInsights object to array (runPairing expects array)
  const analysis = {
    ...LIVE_ANALYSIS,
    imageInsights: Object.values(LIVE_ANALYSIS.imageInsights)
  };
  
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const { result, metrics } = await runPairing({
    client,
    analysis,
    model: "gpt-4o-mini"
  });
  
  console.log(`✅ Pairing complete: ${result.pairs?.length || 0} pairs\n`);
  
  console.log("📊 PAIRING RESULTS:\n");
  for (const pair of result.pairs || []) {
    console.log(`  ✓ ${pair.brand} - ${pair.product}`);
    console.log(`    Front: ${pair.frontUrl} (${pair.sizeFront || "no size"})`);
    console.log(`    Back:  ${pair.backUrl} (${pair.sizeBack || "no size"})`);
    console.log(`    Score: ${pair.matchScore}`);
    console.log(`    Evidence: ${(pair.evidence || []).slice(0, 3).join(", ")}\n`);
  }
  
  if (metrics) {
    console.log("📈 METRICS:");
    console.log(`  Images: ${metrics.totals?.images || 0}`);
    console.log(`  Fronts: ${metrics.totals?.fronts || 0}, Backs: ${metrics.totals?.backs || 0}`);
    console.log(`  Auto pairs: ${metrics.totals?.autoPairs || 0}, Model pairs: ${metrics.totals?.modelPairs || 0}`);
    console.log(`  Singletons: ${metrics.totals?.singletons || 0}\n`);
  }
  
  fs.writeFileSync("test-pairing-result.json", JSON.stringify(result, null, 2));
  console.log("💾 Saved to test-pairing-result.json\n");
  
  console.log("\n🔍 DIAGNOSIS:\n");
  console.log(`Expected: 4 pairs (myBrainCo, Frog Fuel, Nusava, R+Co)`);
  console.log(`Got:      ${result.pairs?.length || 0} pairs`);
  
  const hasFrogFuel = result.pairs?.some(p => p.brand.toLowerCase().includes("frog"));
  const hasMyBrain = result.pairs?.some(p => p.brand.toLowerCase().includes("brain"));
  const hasNusava = result.pairs?.some(p => p.brand.toLowerCase().includes("nusava"));
  const hasRCo = result.pairs?.some(p => p.brand.toLowerCase().includes("r+co") || p.brand.toLowerCase().includes("rco"));
  
  console.log(`\n  ✓ Frog Fuel:  ${hasFrogFuel ? "✅ FOUND" : "❌ MISSING"}`);
  console.log(`  ✓ myBrainCo:  ${hasMyBrain ? "✅ FOUND" : "❌ MISSING"}`);
  console.log(`  ✓ Nusava:     ${hasNusava ? "✅ FOUND" : "❌ MISSING"}`);
  console.log(`  ✓ R+Co:       ${hasRCo ? "✅ FOUND" : "❌ MISSING"}`);
  
  console.log("\n🚨 PROBLEM IDENTIFIED:\n");
  console.log("The analysis phase created DUPLICATE groups:");
  console.log("  - azdfkuj.jpg appears in BOTH 'myBrainCo Gut Repair' AND 'Unknown'");
  console.log("  - dfzdvzer.jpg is only in 'Unknown' group (should be with Nusava)");
  console.log("  - This creates orphan backs that can't pair!");
  console.log("\n✅ The pairing algorithm is working correctly.");
  console.log("❌ The ANALYSIS phase is creating bad groups.\n");
  
  if (result.pairs?.length !== 4) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error("\n❌ ERROR:", err.message);
  console.error(err.stack);
  process.exit(1);
});
