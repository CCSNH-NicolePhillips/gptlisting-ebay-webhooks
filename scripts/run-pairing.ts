// Copilot: Node CLI that reads analysis.json (with {groups,imageInsights}),
// calls runPairing, prints logs, and writes result to pairing.json.
// After loading analysis.json and before calling runPairing,
// call buildFeatures + buildCandidates and print a compact
// summary count: <frontsWithCandidates>/<totalFronts> have candidates.
//
// Do NOT change how runPairing ultimately calls GPT.
// Just add these pre-call logs so we can inspect pruning.

import fs from "fs";
import OpenAI from "openai";
import { config } from "dotenv";
import { runPairing } from "../src/pairing/runPairing.js";
import { buildFeatures } from "../src/pairing/featurePrep.js";
import { buildCandidates, getCandidateScoresForFront } from "../src/pairing/candidates.js";

// Load environment variables
config();

async function main() {
  const analysisPath = process.argv[2] || "analysis.json";
  const outPath = process.argv[3] || "pairing.json";

  const text = fs.readFileSync(analysisPath, "utf8");
  const analysis = JSON.parse(text);
  
  // Pre-compute features and candidates for summary
  const features = buildFeatures(analysis);
  const candidatesMap = buildCandidates(features, 4);
  
  const totalFronts = Array.from(features.values()).filter(f => f.role === 'front').length;
  const frontsWithCandidates = Object.keys(candidatesMap).length;
  
  console.log(`\nCandidate Summary: frontsWithCandidates=${frontsWithCandidates} / totalFronts=${totalFronts}\n`);
  
  // Print PRE candidate scores for each front (top-3)
  for (const [frontUrl, _] of Object.entries(candidatesMap)) {
    const scores = getCandidateScoresForFront(features, frontUrl).filter(s => s.preScore >= 1.5).slice(0, 3);
    if (scores.length > 0) {
      console.log(`PRE   front=${frontUrl}`);
      for (const s of scores) {
        const proximityFlag = s.proximityBoost > 0 ? ` proximity:+${s.proximityBoost.toFixed(1)}` : '';
        const barcodeFlag = s.barcodeBoost > 0 ? ` barcode:+${s.barcodeBoost.toFixed(1)}` : '';
        console.log(` - ${s.backUrl} preScore=${s.preScore.toFixed(2)} prodJac=${s.prodJac.toFixed(2)} varJac=${s.varJac.toFixed(2)} sizeEq=${s.sizeEq} pkg=${s.packaging} boost=${s.packagingBoost.toFixed(1)} brand=${s.brandFlag}${proximityFlag}${barcodeFlag}`);
      }
    }
  }
  console.log();

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const { result, metrics } = await runPairing({ client, analysis, model: "gpt-4o-mini" });

  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\nWROTE: ${outPath}`);
  
  // Write metrics
  const metricsPath = outPath.replace('.json', '-metrics.json');
  fs.writeFileSync(metricsPath, JSON.stringify(metrics, null, 2));
  console.log(`WROTE: ${metricsPath}`);
  
  console.log(`RESULT: ${result.pairs.length} pairs, ${result.products.length} products (with extras), ${result.singletons.length} singletons`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
