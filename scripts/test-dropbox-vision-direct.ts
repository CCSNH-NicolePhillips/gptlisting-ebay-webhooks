// Test: Fetch photos from Dropbox API and analyze with Vision API
// This simulates exactly what the production function does
import { config } from "dotenv";
import { Dropbox } from "dropbox";
import fetch from "node-fetch";

config();

const DROPBOX_ACCESS_TOKEN = process.env.DROPBOX_ACCESS_TOKEN;
const VISION_MODEL = process.env.VISION_MODEL || "openai:gpt-4o";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

async function getDropboxFiles(folder: string) {
  if (!DROPBOX_ACCESS_TOKEN) {
    throw new Error("DROPBOX_ACCESS_TOKEN not set in .env");
  }
  
  const dbx = new Dropbox({ accessToken: DROPBOX_ACCESS_TOKEN, fetch: fetch as any });
  
  console.log(`📁 Listing files in Dropbox folder: ${folder}`);
  
  const result = await dbx.filesListFolder({ path: folder });
  const files = result.result.entries.filter((e: any) => 
    e[".tag"] === "file" && 
    /\.(jpg|jpeg|png)$/i.test(e.name) &&
    !e.name.startsWith("IMG_")
  );
  
  console.log(`   Found ${files.length} image files\n`);
  return files;
}

async function getDropboxDirectLink(dbx: Dropbox, path: string): Promise<string> {
  try {
    const result = await dbx.filesGetTemporaryLink({ path });
    return result.result.link;
  } catch (err: any) {
    console.error(`Failed to get link for ${path}:`, err.message);
    throw err;
  }
}

async function analyzeWithVision(imageUrl: string, filename: string) {
  console.log(`🔍 Analyzing ${filename} with Vision API (${VISION_MODEL})...`);
  
  const [provider, model] = VISION_MODEL.split(":");
  
  if (provider !== "openai") {
    throw new Error(`Only openai provider supported in this test, got: ${provider}`);
  }
  
  const prompt = `Analyze this product photo. Return ONLY valid JSON (no markdown):
{
  "role": "front"|"back"|"side"|"other",
  "brand": "brand name or empty string",
  "product": "product name or empty string",
  "category": "Hair Care"|"Supplement"|"Cosmetic"|"Food"|"Unknown",
  "textExtracted": "ALL visible text on image"
}`;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: model || "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: imageUrl } }
          ]
        }
      ],
      max_tokens: 2000,
      temperature: 0
    })
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Vision API failed: ${response.status} ${error}`);
  }
  
  const data = await response.json() as any;
  const content = data.choices[0]?.message?.content || "{}";
  
  // Try to extract JSON from response (may have markdown wrapper)
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.log(`   ⚠️  No JSON found in response`);
    console.log(`   Response preview: ${content.slice(0, 200)}...`);
    return null;
  }
  
  try {
    const result = JSON.parse(jsonMatch[0]);
    const textLen = result.textExtracted?.length || 0;
    console.log(`   ✅ Role: ${result.role}, Brand: ${result.brand || "NONE"}, TextLen: ${textLen}`);
    return result;
  } catch (err) {
    console.log(`   ❌ Failed to parse JSON`);
    return null;
  }
}

async function main() {
  console.log("🧪 TESTING DROPBOX + VISION API (Production Simulation)\n");
  console.log("This simulates exactly what happens when you click 'Analyze' in SmartDrafts\n");
  console.log("=".repeat(80) + "\n");
  
  // Step 1: Get files from Dropbox
  const files = await getDropboxFiles("/EBAY");
  
  const dbx = new Dropbox({ accessToken: DROPBOX_ACCESS_TOKEN!, fetch: fetch as any });
  
  // Step 2: Focus on the problem images
  const problemFiles = ["asd32q.jpg", "azdfkuj.jpg", "rgxbbg.jpg", "dfzdvzer.jpg"];
  const filesToTest = files.filter((f: any) => problemFiles.includes(f.name));
  
  console.log(`🎯 Testing ${filesToTest.length} critical images:\n`);
  
  const results: Record<string, any> = {};
  
  for (const file of filesToTest) {
    const filename = (file as any).name;
    const path = (file as any).path_lower;
    
    try {
      // Get temporary download link
      const link = await getDropboxDirectLink(dbx, path);
      
      // Analyze with Vision API
      const result = await analyzeWithVision(link, filename);
      results[filename] = result;
      
      console.log();
      
      // Small delay between API calls
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (err: any) {
      console.error(`   ❌ Error: ${err.message}\n`);
      results[filename] = { error: err.message };
    }
  }
  
  console.log("=".repeat(80));
  console.log("\n📊 SUMMARY:\n");
  
  const asd32q = results["asd32q.jpg"];
  const azdfkuj = results["azdfkuj.jpg"];
  const rgxbbg = results["rgxbbg.jpg"];
  const dfzdvzer = results["dfzdvzer.jpg"];
  
  console.log("🧴 R+Co Product:");
  console.log(`  Front (asd32q.jpg):`);
  console.log(`    Brand: ${asd32q?.brand || "MISSING"}`);
  console.log(`    Product: ${asd32q?.product || "MISSING"}`);
  console.log(`    Text length: ${asd32q?.textExtracted?.length || 0} chars`);
  console.log(`  Back (azdfkuj.jpg):`);
  console.log(`    Brand: ${azdfkuj?.brand || "MISSING"}`);
  console.log(`    Has INCI: ${azdfkuj?.textExtracted?.includes("INGREDIENTS:") || azdfkuj?.textExtracted?.includes("Ingredients:") ? "YES" : "NO"}`);
  console.log(`    Text length: ${azdfkuj?.textExtracted?.length || 0} chars`);
  
  console.log("\n💊 Nusava Product:");
  console.log(`  Front (rgxbbg.jpg):`);
  console.log(`    Brand: ${rgxbbg?.brand || "MISSING"}`);
  console.log(`    Product: ${rgxbbg?.product || "MISSING"}`);
  console.log(`    Text length: ${rgxbbg?.textExtracted?.length || 0} chars`);
  console.log(`  Back (dfzdvzer.jpg):`);
  console.log(`    Brand: ${dfzdvzer?.brand || "MISSING"}`);
  console.log(`    Has Supplement Facts: ${dfzdvzer?.textExtracted?.includes("SUPPLEMENT FACTS") || dfzdvzer?.textExtracted?.includes("Supplement Facts") ? "YES" : "NO"}`);
  console.log(`    Text length: ${dfzdvzer?.textExtracted?.length || 0} chars`);
  
  console.log("\n🔍 DIAGNOSIS:\n");
  
  let hasIssues = false;
  
  if (!azdfkuj?.textExtracted?.includes("INGREDIENTS") && !azdfkuj?.textExtracted?.includes("Ingredients")) {
    console.log("❌ azdfkuj.jpg (R+Co back) - NO ingredient list extracted");
    console.log("   → Pairing will fail because AUTOPAIR[hair] requires INCI detection");
    hasIssues = true;
  }
  
  if (!dfzdvzer?.textExtracted?.includes("SUPPLEMENT FACTS") && !dfzdvzer?.textExtracted?.includes("Supplement Facts")) {
    console.log("❌ dfzdvzer.jpg (Nusava back) - NO supplement facts extracted");
    console.log("   → Pairing will fail because no supplement panel detected");
    hasIssues = true;
  }
  
  if (!rgxbbg?.brand || rgxbbg?.brand === "") {
    console.log("❌ rgxbbg.jpg (Nusava front) - NO brand extracted");
    console.log("   → Will be grouped as 'Unknown', can't pair with back");
    hasIssues = true;
  }
  
  if (!hasIssues) {
    console.log("✅ All images have sufficient data for pairing!");
  }
  
  console.log("\n💾 Full results saved to vision-dropbox-test.json\n");
  
  const fs = await import("fs");
  fs.writeFileSync("vision-dropbox-test.json", JSON.stringify(results, null, 2));
}

main().catch(err => {
  console.error("\n❌ FATAL ERROR:", err.message);
  console.error(err.stack);
  process.exit(1);
});
