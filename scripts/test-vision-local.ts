// Test Vision API directly on local photos to see what text is extracted
import fs from "fs";
import path from "path";
import { config } from "dotenv";
import OpenAI from "openai";

config();

const PHOTOS_DIR = "testDropbox/EBAY";
const PROBLEM_IMAGES = ["azdfkuj.jpg", "dfzdvzer.jpg", "asd32q.jpg", "rgxbbg.jpg"];

async function analyzeImage(client: OpenAI, imagePath: string) {
  const imageBuffer = fs.readFileSync(imagePath);
  const base64 = imageBuffer.toString("base64");
  const ext = path.extname(imagePath).slice(1);
  const mimeType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";
  
  console.log(`\n📸 Analyzing ${path.basename(imagePath)}...`);
  
  const response = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `You are analyzing a product photo. Extract ALL visible text exactly as it appears.
            
Return a JSON object with:
{
  "role": "front" | "back" | "side" | "other",
  "brand": "brand name if visible",
  "product": "product name if visible", 
  "allText": "every single word visible on the image",
  "hasInciList": true/false (ingredient list with chemical names),
  "hasSupplementFacts": true/false,
  "category": "Hair Care" | "Supplement" | "Cosmetic" | "Food" | "Unknown"
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
  
  try {
    const result = JSON.parse(content);
    console.log(`✅ Role: ${result.role}`);
    console.log(`   Brand: ${result.brand || "NONE"}`);
    console.log(`   Product: ${result.product || "NONE"}`);
    console.log(`   Category: ${result.category || "Unknown"}`);
    console.log(`   Has INCI: ${result.hasInciList || false}`);
    console.log(`   Has Supplement Facts: ${result.hasSupplementFacts || false}`);
    console.log(`   Text length: ${result.allText?.length || 0} chars`);
    if (result.allText && result.allText.length < 500) {
      console.log(`   Preview: ${result.allText.slice(0, 200)}...`);
    }
    return result;
  } catch (err) {
    console.log(`❌ Failed to parse response:\n${content}`);
    return null;
  }
}

async function main() {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  
  console.log("🔍 Testing Vision API on LOCAL photos from testDropbox/EBAY\n");
  console.log("Focus: The 4 images that should pair but don't:\n");
  console.log("  - asd32q.jpg (R+Co front) → should pair with azdfkuj.jpg (R+Co back)");
  console.log("  - rgxbbg.jpg (Nusava front) → should pair with dfzdvzer.jpg (Nusava back)");
  console.log("\n" + "=".repeat(80) + "\n");
  
  const results: Record<string, any> = {};
  
  for (const filename of PROBLEM_IMAGES) {
    const imagePath = path.join(PHOTOS_DIR, filename);
    if (!fs.existsSync(imagePath)) {
      console.log(`⚠️  ${filename} not found, skipping...`);
      continue;
    }
    
    const result = await analyzeImage(client, imagePath);
    results[filename] = result;
    
    // Small delay between API calls
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  console.log("\n" + "=".repeat(80));
  console.log("\n📊 SUMMARY:\n");
  
  const asd32q = results["asd32q.jpg"];
  const azdfkuj = results["azdfkuj.jpg"];
  const rgxbbg = results["rgxbbg.jpg"];
  const dfzdvzer = results["dfzdvzer.jpg"];
  
  console.log("🧴 R+Co Product:");
  console.log(`  Front (asd32q.jpg): ${asd32q?.brand || "?"} - ${asd32q?.product || "?"}`);
  console.log(`  Back (azdfkuj.jpg):  ${azdfkuj?.brand || "?"} - ${azdfkuj?.product || "?"}`);
  console.log(`  Match: ${asd32q?.brand && azdfkuj?.brand && asd32q.brand.toLowerCase().includes("co") && azdfkuj.hasInciList ? "✅ Should pair via INCI" : "❌ Missing data"}`);
  
  console.log("\n💊 Nusava Product:");
  console.log(`  Front (rgxbbg.jpg):    ${rgxbbg?.brand || "?"} - ${rgxbbg?.product || "?"}`);
  console.log(`  Back (dfzdvzer.jpg):   ${dfzdvzer?.brand || "?"} - ${dfzdvzer?.product || "?"}`);
  console.log(`  Match: ${rgxbbg?.brand && dfzdvzer?.hasSupplementFacts ? "✅ Should pair via supplement facts" : "❌ Missing data"}`);
  
  console.log("\n🔍 DIAGNOSIS:\n");
  
  if (!azdfkuj?.brand && !azdfkuj?.hasInciList) {
    console.log("❌ azdfkuj.jpg (R+Co back) has NO brand and NO INCI list detected");
    console.log("   → Vision API failed to extract ingredient list");
    console.log("   → This is why it gets grouped as 'Unknown'");
  }
  
  if (!dfzdvzer?.brand && !dfzdvzer?.hasSupplementFacts) {
    console.log("❌ dfzdvzer.jpg (Nusava back) has NO brand and NO supplement facts detected");
    console.log("   → Vision API failed to extract supplement panel");
    console.log("   → This is why it gets grouped as 'Unknown'");
  }
  
  fs.writeFileSync("vision-test-results.json", JSON.stringify(results, null, 2));
  console.log("\n💾 Saved to vision-test-results.json\n");
}

main().catch(err => {
  console.error("\n❌ ERROR:", err.message);
  console.error(err.stack);
  process.exit(1);
});
