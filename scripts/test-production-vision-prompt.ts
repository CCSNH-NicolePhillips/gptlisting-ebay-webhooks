// Test Vision API with LOCAL photos using PRODUCTION prompt
import fs from "fs";
import path from "path";
import { config } from "dotenv";
import OpenAI from "openai";

config();

const PHOTOS_DIR = "testDropbox/EBAY";
const TEST_FILES = ["asd32q.jpg", "azdfkuj.jpg", "rgxbbg.jpg", "dfzdvzer.jpg"];

async function analyzeWithProductionPrompt(client: OpenAI, imagePath: string) {
  const filename = path.basename(imagePath);
  const imageBuffer = fs.readFileSync(imagePath);
  const base64 = imageBuffer.toString("base64");
  
  const prompt = `You are analyzing product photos for inventory management.

Step 1 — ROLE DETECTION (front vs back):
• Faces outward: brand logo/hero image → negative score → 'front'
• Faces inward: ingredient list, nutrition/supplement facts table, barcode, directions, "Distributed by..." → positive score → 'back'
• Score thresholds:
  score ≥ +0.35 → 'back'
  score ≤ −0.35 → 'front'
  |score| < 0.2 → 'other' (low confidence)

Step 2 — TEXT & VISUAL EVIDENCE:
• Extract ALL legible text (preserve case, line breaks). Include brand if visible anywhere (front or back).
• List evidenceTriggers: exact words/visual cues that affected roleScore (e.g., 'Supplement Facts' header, barcode block near bottom-right, large hero logo, 'INGREDIENTS:').

Step 3 — PRODUCT FIELDS:
• Extract: brand, product, variant/flavor, size/servings, best-fit category, categoryPath (parent > child).
• Non-product images: brand='Unknown', product='Unidentified Item'.

STRICT JSON OUTPUT (one image only):
{
  "url": "${filename}",
  "hasVisibleText": true,
  "dominantColor": "...",
  "role": "front" | "back" | "side" | "other",
  "roleScore": 0.00,
  "evidenceTriggers": ["exact texts or visual cues here"],
  "textExtracted": "<ALL visible text>"
}

CRITICAL: textExtracted must contain ALL text, especially:
- For backs: FULL ingredient lists (INCI names like "Dimethicone, Vitis Vinifera...")
- For backs: FULL supplement facts panels
- For fronts: Brand names, product names, variants`;

  console.log(`\n🔍 Analyzing ${filename}...`);
  
  const response = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          {
            type: "image_url",
            image_url: {
              url: `data:image/jpeg;base64,${base64}`
            }
          }
        ]
      }
    ],
    max_tokens: 3000,
    temperature: 0
  });
  
  const content = response.choices[0]?.message?.content || "{}";
  
  // Extract JSON
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.log(`   ❌ No JSON in response`);
    return null;
  }
  
  try {
    const result = JSON.parse(jsonMatch[0]);
    const textLen = result.textExtracted?.length || 0;
    const hasIngredients = /INGREDIENTS:/i.test(result.textExtracted || "");
    const hasSupplementFacts = /SUPPLEMENT FACTS/i.test(result.textExtracted || "");
    
    console.log(`   Role: ${result.role} (score: ${result.roleScore})`);
    console.log(`   Text length: ${textLen} chars`);
    console.log(`   Has INGREDIENTS: ${hasIngredients ? "YES ✅" : "NO ❌"}`);
    console.log(`   Has SUPPLEMENT FACTS: ${hasSupplementFacts ? "YES ✅" : "NO ❌"}`);
    console.log(`   Evidence triggers: ${(result.evidenceTriggers || []).slice(0, 3).join(", ")}`);
    
    return result;
  } catch (err) {
    console.log(`   ❌ Failed to parse JSON: ${err}`);
    console.log(`   Response: ${content.slice(0, 300)}...`);
    return null;
  }
}

async function main() {
  console.log("🧪 TESTING VISION API WITH PRODUCTION PROMPT\n");
  console.log("Using LOCAL photos from testDropbox/EBAY\n");
  console.log("=".repeat(80) + "\n");
  
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const results: Record<string, any> = {};
  
  for (const filename of TEST_FILES) {
    const imagePath = path.join(PHOTOS_DIR, filename);
    
    if (!fs.existsSync(imagePath)) {
      console.log(`\n⚠️  ${filename} not found, skipping...`);
      continue;
    }
    
    const result = await analyzeWithProductionPrompt(client, imagePath);
    results[filename] = result;
    
    // Delay between API calls
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  
  console.log("\n" + "=".repeat(80));
  console.log("\n📊 DIAGNOSIS:\n");
  
  const asd32q = results["asd32q.jpg"];
  const azdfkuj = results["azdfkuj.jpg"];
  const rgxbbg = results["rgxbbg.jpg"];
  const dfzdvzer = results["dfzdvzer.jpg"];
  
  console.log("🧴 R+Co Product:");
  console.log(`  Front (asd32q.jpg): Text length = ${asd32q?.textExtracted?.length || 0}`);
  console.log(`  Back (azdfkuj.jpg):  Text length = ${azdfkuj?.textExtracted?.length || 0}`);
  
  const hasRCoInci = azdfkuj?.textExtracted?.includes("INGREDIENTS:") || azdfkuj?.textExtracted?.includes("Ingredients:");
  console.log(`  → Can pair via INCI? ${hasRCoInci ? "YES ✅" : "NO ❌ (missing ingredient list)"}`);
  
  console.log("\n💊 Nusava Product:");
  console.log(`  Front (rgxbbg.jpg):    Text length = ${rgxbbg?.textExtracted?.length || 0}`);
  console.log(`  Back (dfzdvzer.jpg):   Text length = ${dfzdvzer?.textExtracted?.length || 0}`);
  
  const hasNusavaFacts = dfzdvzer?.textExtracted?.includes("SUPPLEMENT FACTS") || dfzdvzer?.textExtracted?.includes("Supplement Facts");
  console.log(`  → Can pair via supplement facts? ${hasNusavaFacts ? "YES ✅" : "NO ❌ (missing supplement panel)"}`);
  
  console.log("\n🔍 ROOT CAUSE:\n");
  
  if (!hasRCoInci) {
    console.log("❌ azdfkuj.jpg is missing INGREDIENTS in textExtracted");
    console.log("   → The AUTOPAIR[hair] logic in runPairing() requires INCI detection");
    console.log("   → This is why R+Co doesn't pair");
    if (azdfkuj?.textExtracted) {
      console.log(`\n   Preview of extracted text:`);
      console.log(`   "${azdfkuj.textExtracted.slice(0, 200)}..."`);
    }
  }
  
  if (!hasNusavaFacts) {
    console.log("❌ dfzdvzer.jpg is missing SUPPLEMENT FACTS in textExtracted");
    console.log("   → The pairing logic requires supplement facts panel for backs");
    console.log("   → This is why Nusava doesn't pair");
    if (dfzdvzer?.textExtracted) {
      console.log(`\n   Preview of extracted text:`);
      console.log(`   "${dfzdvzer.textExtracted.slice(0, 200)}..."`);
    }
  }
  
  fs.writeFileSync("vision-test-results.json", JSON.stringify(results, null, 2));
  console.log("\n💾 Full results saved to vision-test-results.json\n");
  
  if (hasRCoInci && hasNusavaFacts) {
    console.log("✅ Vision API is extracting text correctly - pairing should work!\n");
  } else {
    console.log("❌ Vision API is NOT extracting enough text - this is the root problem!\n");
    console.log("Solutions:");
    console.log("  1. Increase max_tokens in Vision API call (currently 3000)");
    console.log("  2. Use a different Vision model (try gpt-4o-mini or claude-3-5-sonnet)");
    console.log("  3. Split the prompt to focus only on text extraction\n");
  }
}

main().catch(err => {
  console.error("\n❌ ERROR:", err.message);
  console.error(err.stack);
  process.exit(1);
});
