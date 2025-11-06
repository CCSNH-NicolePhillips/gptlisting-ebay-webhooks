// Full test: analyze LOCAL photos + pair them (no Dropbox, no Netlify)
import fs from "fs";
import path from "path";
import { config } from "dotenv";
import OpenAI from "openai";
import { runPairing } from "../src/pairing/runPairing.js";

config();

const PHOTOS_DIR = "testDropbox/EBAY";

async function analyzeImageSimple(client: OpenAI, imagePath: string) {
  const imageBuffer = fs.readFileSync(imagePath);
  const base64 = imageBuffer.toString("base64");
  const ext = path.extname(imagePath).slice(1);
  const mimeType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";
  
  const response = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Analyze this product photo. Return JSON:
{
  "role": "front"|"back"|"side"|"other",
  "brand": "brand name or empty string",
  "product": "product name or empty string",
  "variant": "variant/flavor or empty string",
  "size": "size or empty string",
  "category": "Hair Care"|"Supplement"|"Cosmetic"|"Food"|"Unknown",
  "textExtracted": "all visible text"
}`
          },
          {
            type: "image_url",
            image_url: {
              url: `data:${mimeType};base64,${base64}`
            }
          }
        ]
      }
    ],
    max_tokens: 2000,
    temperature: 0
  });
  
  const content = response.choices[0]?.message?.content || "{}";
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.log(`⚠️  No JSON found in response for ${path.basename(imagePath)}`);
    return null;
  }
  
  return JSON.parse(jsonMatch[0]);
}

async function main() {
  console.log("🔬 FULL LOCAL TEST: Analyze + Pair testDropbox/EBAY photos\n");
  
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const files = fs.readdirSync(PHOTOS_DIR).filter(f => f.endsWith(".jpg") && !f.startsWith("IMG_"));
  
  console.log(`📸 Analyzing ${files.length} photos...\n`);
  
  const insights: any[] = [];
  const groups: any[] = [];
  const productMap = new Map<string, any>();
  
  for (const filename of files) {
    const imagePath = path.join(PHOTOS_DIR, filename);
    const result = await analyzeImageSimple(client, imagePath);
    
    if (!result) continue;
    
    console.log(`  ${filename}: ${result.role} | ${result.brand || "no brand"} - ${result.product || "no product"}`);
    
    // Add to insights
    insights.push({
      url: filename,
      role: result.role,
      hasVisibleText: !!result.textExtracted,
      textExtracted: result.textExtracted,
      key: filename,
      displayUrl: `http://local/${filename}`
    });
    
    // Group fronts by brand+product
    if (result.role === "front" && result.brand && result.product) {
      const key = `${result.brand}|||${result.product}`;
      if (!productMap.has(key)) {
        const group = {
          groupId: `grp_${Math.random().toString(36).substr(2, 8)}`,
          brand: result.brand,
          product: result.product,
          variant: result.variant || "",
          size: result.size || "",
          category: result.category,
          categoryPath: result.category,
          images: [],
          confidence: 0.9
        };
        productMap.set(key, group);
        groups.push(group);
      }
      productMap.get(key).images.push(filename);
    }
    
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  console.log(`\n✅ Analyzed ${insights.length} images into ${groups.length} product groups\n`);
  
  // Add backs to their groups based on proximity (simple: just add all backs to all groups for now)
  const backs = insights.filter(i => i.role === "back");
  for (const group of groups) {
    // Add all backs - pairing will figure out which belong together
    for (const back of backs) {
      if (!group.images.includes(back.key)) {
        group.images.push(back.key);
      }
    }
  }
  
  console.log("📦 Product groups:");
  for (const g of groups) {
    console.log(`  - ${g.brand} / ${g.product} (${g.images.length} images)`);
  }
  console.log();
  
  const analysis = { groups, imageInsights: insights };
  fs.writeFileSync("analysis-local-test.json", JSON.stringify(analysis, null, 2));
  
  console.log("🔗 Running pairing...\n");
  
  const { result, metrics } = await runPairing({
    client,
    analysis,
    model: "gpt-4o-mini"
  });
  
  console.log(`✅ Pairing complete: ${result.pairs?.length || 0} pairs\n`);
  
  console.log("📊 RESULTS:\n");
  for (const pair of result.pairs || []) {
    console.log(`  ✓ ${pair.brand} - ${pair.product}`);
    console.log(`    Front: ${pair.frontUrl}`);
    console.log(`    Back:  ${pair.backUrl}`);
    console.log(`    Score: ${pair.matchScore}, Evidence: ${pair.evidence?.slice(0, 2).join(", ")}\n`);
  }
  
  fs.writeFileSync("pairing-local-test.json", JSON.stringify(result, null, 2));
  
  console.log("\n🎯 EXPECTED vs GOT:");
  console.log(`  Expected: 4 pairs (myBrainCo, Frog Fuel, Nusava, R+Co)`);
  console.log(`  Got:      ${result.pairs?.length || 0} pairs\n`);
  
  const brands = result.pairs?.map(p => p.brand.toLowerCase()) || [];
  console.log(`  myBrainCo: ${brands.some(b => b.includes("brain")) ? "✅" : "❌"}`);
  console.log(`  Frog Fuel: ${brands.some(b => b.includes("frog")) ? "✅" : "❌"}`);
  console.log(`  Nusava:    ${brands.some(b => b.includes("nusava")) ? "✅" : "❌"}`);
  console.log(`  R+Co:      ${brands.some(b => b.includes("r+co") || b.includes("rco")) ? "✅" : "❌"}`);
  
  if (result.pairs?.length !== 4) {
    console.log("\n❌ MISMATCH! Check analysis-local-test.json and pairing-local-test.json\n");
    process.exit(1);
  } else {
    console.log("\n🎉 SUCCESS! All 4 products paired!\n");
  }
}

main().catch(err => {
  console.error("\n❌ ERROR:", err.message);
  console.error(err.stack);
  process.exit(1);
});
