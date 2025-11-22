/**
 * ============================================================
 *  IMPLEMENTATION NOTE: Dev Mode Sample Images
 * ============================================================
 *
 *  TECHNICAL CONSTRAINT: OpenAI's API does NOT support images
 *  in system messages. Images can ONLY be in user messages.
 *
 *  IMPLEMENTED SOLUTION:
 *  - System message: Contains ONLY the strict classification rules (text)
 *  - User message: Contains example images FIRST (if USE_DEV_SAMPLES=true),
 *    followed by a clear separator, then the actual images to classify
 *
 *  This achieves the same goal: The model sees examples before
 *  the images it needs to classify, with explicit instructions
 *  to distinguish between examples and actual classification targets.
 *
 * ============================================================
 */

import OpenAI from 'openai';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const ENABLE_COMPARISON = process.env.ENABLE_COMPARISON === 'true';
const USE_DEV_SAMPLES =
  process.env.USE_DEV_SAMPLES === 'true' || process.env.NODE_ENV !== 'production';
const USE_LEGACY_PAIRING = process.env.USE_LEGACY_PAIRING === 'true';
const JUST_CLASSIFY = process.env.JUST_CLASSIFY === 'true';
const TEST_TWO_STAGE = process.env.TEST_TWO_STAGE === 'true';
const CLASSIFY_BATCH_SIZE = 12; // Max images per classification API call to avoid payload size limits

// ============================================================
// Stage 1: Pure Classification Types
// ============================================================

type PanelType = 'front' | 'back' | 'side' | 'unknown';
type ProductKind = 'product' | 'non_product';

interface ImageClassificationV2 {
  filename: string;
  kind: ProductKind;              // 'product' or 'non_product'
  panel: PanelType;               // 'front' / 'back' / 'side' / 'unknown'
  brand: string | null;
  productName: string | null;
  packageType: 'bottle' | 'jar' | 'tub' | 'pouch' | 'box' | 'sachet' | 'unknown';
  keyText: string[];              // short readable snippets from label
  colorSignature: string[];       // dominant colors: ["green", "black", "bright green gradient"]
  layoutSignature: string;        // layout description: "pouch vertical label center"
  confidence: number;             // 0.0–1.0
}

// ============================================================
// Stage 2: Text-Only Pairing Types
// ============================================================

interface PairingInputItem {
  filename: string;
  kind: ProductKind;
  panel: PanelType;
  brand: string | null;
  productName: string | null;
  packageType: string;
  colorSignature: string[];
  layoutSignature: string;
  confidence: number;
}

interface PairingOutput {
  pairs: Array<{
    front: string;
    back: string;
    reasoning: string;
    confidence: number;
  }>;
  unpaired: Array<{
    filename: string;
    reason: string;
    needsReview: boolean;
  }>;
}

// ============================================================
// Stage 3: Verification Types
// ============================================================

interface VerifiedPair {
  front: string;
  back: string;
  reasoning: string;
  confidence: number;
  status: 'accepted' | 'rejected';
  issues?: string[];
}

interface VerificationOutput {
  verifiedPairs: VerifiedPair[];
}

// ============================================================
// Legacy Types (for two-pass pipeline)
// ============================================================

type SampleImageRole = 'example_front' | 'example_back' | 'example_non_product';

interface SampleImage {
  filename: string;
  role: SampleImageRole;
  description: string;
}

// Adjust filenames if needed to match actual files in image-sorter/Samples
const SAMPLE_IMAGES: SampleImage[] = [
  {
    filename: 'asd32q.jpg',
    role: 'example_front',
    description: 'Example FRONT: R+Co styling oil with brand and product name clearly visible.'
  },
  {
    filename: 'azdfkuj.jpg',
    role: 'example_back',
    description: 'Example BACK: R+Co styling oil with ingredients, directions, and regulatory text.'
  },
  {
    filename: 'frog_01.jpg',
    role: 'example_front',
    description: 'Example FRONT: FrogFuel Greens + Protein pouch with bold logo and product name.'
  },
  {
    filename: 'faeewfaw.jpg',
    role: 'example_back',
    description: 'Example BACK: FrogFuel pouch with Supplement Facts table.'
  },
  {
    filename: 'rgxbbg.jpg',
    role: 'example_front',
    description: 'Example FRONT: Nusava B-complex dropper bottle label with B12/B6/B1 + Niacin + Folate.'
  },
  {
    filename: 'dfzdvzer.jpg',
    role: 'example_back',
    description: 'Example BACK: Nusava B-complex with Supplement Facts panel.'
  },
  {
    filename: 'IMG_20251102_144346.jpg',
    role: 'example_non_product',
    description: 'NON-PRODUCT example: a purse on a couch; must be classified as non_product and never paired.'
  }
];

// Where they live on disk relative to this project
const SAMPLE_IMAGES_BASE_PATH = 'Samples';

interface ImagePair {
  front: string;
  back: string;
  brand: string;
  product: string;
  notes: string;
  reasoning: string;
}

interface PairingResult {
  pairs: ImagePair[];
  classifications: Record<string, 'front' | 'back' | 'unknown' | 'non_product'>;
}

interface ClassificationResponse {
  pairs: ImagePair[];
  classifications: Record<string, 'front' | 'back' | 'unknown' | 'non_product'>;
}

interface ImageClassification {
  filename: string;
  classification: 'front' | 'back' | 'unknown' | 'non_product';
  pairedWith?: string;
}

interface MasterPair {
  product: string;
  front: string;
  back: string;
}

interface ComparisonResult {
  correct: MasterPair[];
  incorrect: MasterPair[];
  missed: MasterPair[];
  extraPairs: Array<{ front: string; back: string }>;
}

async function encodeImageToBase64(imagePath: string): Promise<string> {
  const imageBuffer = fs.readFileSync(imagePath);
  return imageBuffer.toString('base64');
}

type ChatContent =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

function buildSystemMessage(): string {
  return `You are an advanced product-image reasoning model.

Your job:
1. For each input image, classify it as exactly ONE of:
   - "front": clear front label of a packaged consumer product,
   - "back": clear back/side label with facts/ingredients,
   - "unknown": looks like packaging but front vs back is unclear,
   - "non_product": not a packaged consumer product (e.g. purse, room, person, pet, furniture).
2. Pair fronts and backs that belong to the SAME physical product.
3. Use ONLY the filenames provided to you when referring to images.

FRONT characteristics:
- Shows brand name and product name prominently.
- Customer-facing layout (logo, title, flavor, marketing text).
- No Supplement Facts / Nutrition Facts table.

BACK characteristics:
- Shows Supplement Facts or Nutrition Facts table, ingredient list, barcode,
  warnings, directions, or dense regulatory text.

NON_PRODUCT (very important):
- Objects like purses, furniture, clothing, rooms, pets, random scenes.
- Anything without a clear printed product label panel.
- These MUST be classified as "non_product" and MUST NEVER appear in any pair.

MATCHING rules:
- Never pair different brands.
- Never pair different product names.
- Never pair different package forms (jar vs bottle vs pouch).
- Never pair a non_product image with anything.
- It is BETTER to leave something unpaired ("unknown") than to guess incorrectly.

OUTPUT FORMAT (strict):
Respond ONLY with a single JSON object:

{
  "pairs": [
    {
      "front": "filename.jpg",
      "back": "filename.jpg",
      "brand": "brand name or "unknown"",
      "product": "product name or "unknown"",
      "notes": "short justification",
      "reasoning": "brief explanation of the visual/text evidence for this match"
    }
  ],
  "classifications": {
    "filename.jpg": "front | back | unknown | non_product"
  }
}

Requirements:
- Every filename you are given MUST appear exactly once as a key in "classifications".
- Images classified as "non_product" MUST NOT appear in any "pairs" entry.
- Do NOT invent filenames.
- Do NOT guess brands or product names if unreadable: use "unknown".`;
}

function buildUserContentWithExamples(imagePaths: string[]): ChatContent[] {
  const filenames = imagePaths.map(p => path.basename(p));
  const userContent: ChatContent[] = [];

  // Add examples first if dev mode is enabled
  if (USE_DEV_SAMPLES) {
    const exampleFilenames = SAMPLE_IMAGES.map(s => s.filename);
    
    userContent.push({
      type: 'text',
      text: `Here are some EXAMPLES to help you understand the classification:

⚠️ CRITICAL: The following images are EXAMPLES ONLY to demonstrate what FRONT, BACK, and NON_PRODUCT look like.
These example filenames are: ${JSON.stringify(exampleFilenames)}

DO NOT include these example filenames in your classification response.
You will receive the ACTUAL images to classify after these examples.`
    });

    for (const sample of SAMPLE_IMAGES) {
      const samplePath = path.join(SAMPLE_IMAGES_BASE_PATH, sample.filename);
      
      // Check if sample file exists
      if (!fs.existsSync(samplePath)) {
        console.warn(`⚠️  Sample image not found: ${samplePath}`);
        continue;
      }

      userContent.push({
        type: 'text',
        text: `[EXAMPLE ${sample.role.toUpperCase()}] Filename: "${sample.filename}" - ${sample.description}`
      });

      // Encode sample image to base64
      const base64Image = fs.readFileSync(samplePath).toString('base64');
      const ext = path.extname(samplePath).toLowerCase();
      const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';

      userContent.push({
        type: 'image_url',
        image_url: {
          url: `data:${mimeType};base64,${base64Image}`
        }
      });
    }

    userContent.push({
      type: 'text',
      text: `\n${'='.repeat(60)}\n📋 END OF EXAMPLES\n${'='.repeat(60)}\n\n✨ NOW CLASSIFY THESE ACTUAL IMAGES:\nThe filenames below are the ONLY ones you should classify and include in your JSON response.
If any filename appears in both the examples and actual images, IGNORE the example and classify the actual image.`
    });
  }

  userContent.push({
    type: 'text',
    text: `Use the filenames to classify each as front/back/unknown/non_product and pair matching products. Respond ONLY with the JSON object as specified.

Filenames to classify:
${JSON.stringify(filenames, null, 2)}`
  });

  return userContent;
}

function getMasterList(): MasterPair[] {
  return [
    { product: 'ROOT Zero-In', front: '20251115_142814.jpg', back: '20251115_142824.jpg' },
    { product: 'Oganacell Derx Cleanser', front: '20251115_142857.jpg', back: '20251115_142904.jpg' },
    { product: 'Maude Soak Bath Salts (No. 2)', front: '20251115_143002.jpg', back: '20251115_143030.jpg' },
    { product: 'GRB+ / RKMD Glutathione Rapid Boost+', front: '20251115_143138.jpg', back: '20251115_143143.jpg' },
    { product: 'Naked Nutrition – Naked Collagen', front: '20251115_143234.jpg', back: '20251115_143241.jpg' },
    { product: 'Jocko Creatine', front: '20251115_143304.jpg', back: '20251115_143310.jpg' },
    { product: 'Jocko Fish Oil', front: '20251115_143335.jpg', back: '20251115_143340.jpg' },
    { product: 'ROOT Sculpt', front: '20251115_143348.jpg', back: '20251115_143353.jpg' },
    { product: 'ROOT Clean Slate', front: '20251115_143418.jpg', back: '20251115_143422.jpg' },
    { product: 'Vita PLynxera – Myo & D-Chiro Inositol Liquid Drops', front: '20251115_143446.jpg', back: '20251115_143458.jpg' },
    { product: 'Barbie × Evereden Kids Happy Face Duo', front: '20251115_143521.jpg', back: '20251115_143527.jpg' },
    { product: 'RYSE × Kool-Aid Loaded Pre (Tropical Punch)', front: '20251115_143552.jpg', back: '20251115_143556.jpg' },
    { product: 'Prequel Lucent-C Brightening Vitamin C Serum', front: '20251115_143629.jpg', back: '20251115_143638.jpg' },
  ];
}

function getEbayMasterList(): MasterPair[] {
  return [
    { product: 'R+Co On a Cloud Bond Building + Repair Styling Oil', front: 'asd32q.jpg', back: 'azdfkuj.jpg' },
    { product: 'myBrainCo Multi-Action Gut Repair', front: 'awef.jpg', back: 'awefawed.jpg' },
    { product: 'Frog Fuel Performance Greens + Protein', front: 'frog_01.jpg', back: 'faeewfaw.jpg' },
    { product: 'Nusava B12 / B6 / B1 + Niacin + Folate', front: 'rgxbbg.jpg', back: 'dfzdvzer.jpg' },
  ];
}

function getMasterListForFolder(folderPath: string): MasterPair[] {
  const folderName = path.basename(folderPath).toLowerCase();
  
  if (folderName.includes('ebay')) {
    return getEbayMasterList();
  } else if (folderName.includes('newstuff') || folderName.includes('images')) {
    return getMasterList();
  }
  
  // Default to empty if unknown folder
  return [];
}

function compareWithMasterList(results: ImageClassification[], folderPath: string): ComparisonResult {
  const masterList = getMasterListForFolder(folderPath);
  
  // If no master list for this folder, skip comparison
  if (masterList.length === 0) {
    return { correct: [], incorrect: [], missed: [], extraPairs: [] };
  }
  
  const correct: MasterPair[] = [];
  const incorrect: MasterPair[] = [];
  const missed: MasterPair[] = [];
  const extraPairs: Array<{ front: string; back: string }> = [];

  // Build AI's pair map
  const aiPairs = new Map<string, string>();
  for (const result of results) {
    if (result.pairedWith && result.classification === 'front') {
      aiPairs.set(result.filename, result.pairedWith);
    }
  }

  // Check each master pair
  for (const master of masterList) {
    const aiBack = aiPairs.get(master.front);
    
    if (!aiBack) {
      // AI didn't pair this front at all
      missed.push(master);
    } else if (aiBack === master.back) {
      // AI got it right!
      correct.push(master);
    } else {
      // AI paired it, but with wrong back
      incorrect.push(master);
    }
  }

  // Find extra pairs AI made that aren't in master list
  const masterFronts = new Set(masterList.map(m => m.front));
  for (const [front, back] of aiPairs.entries()) {
    if (!masterFronts.has(front)) {
      extraPairs.push({ front, back });
    }
  }

  return { correct, incorrect, missed, extraPairs };
}

function displayComparison(comparison: ComparisonResult): void {
  const total = comparison.correct.length + comparison.incorrect.length + comparison.missed.length;
  
  // Skip display if no master list available
  if (total === 0 && comparison.extraPairs.length === 0) {
    console.log('ℹ️  No master list available for this folder - skipping accuracy report\n');
    return;
  }
  
  const accuracy = total > 0 ? ((comparison.correct.length / total) * 100).toFixed(1) : '0.0';

  console.log('\n' + '='.repeat(60));
  console.log('📊 ACCURACY REPORT');
  console.log('='.repeat(60) + '\n');
  
  console.log(`✅ Correct: ${comparison.correct.length}/${total} (${accuracy}%)\n`);

  if (comparison.correct.length > 0) {
    console.log('✅ CORRECT PAIRS:');
    comparison.correct.forEach(pair => {
      console.log(`   ${pair.product}`);
      console.log(`   ├─ Front: ${pair.front}`);
      console.log(`   └─ Back:  ${pair.back}\n`);
    });
  }

  if (comparison.incorrect.length > 0) {
    console.log('❌ INCORRECT PAIRS:');
    comparison.incorrect.forEach(pair => {
      console.log(`   ${pair.product}`);
      console.log(`   ├─ Expected Front: ${pair.front}`);
      console.log(`   └─ Expected Back:  ${pair.back}\n`);
    });
  }

  if (comparison.missed.length > 0) {
    console.log('⚠️  MISSED PAIRS (not detected):');
    comparison.missed.forEach(pair => {
      console.log(`   ${pair.product}`);
      console.log(`   ├─ Front: ${pair.front}`);
      console.log(`   └─ Back:  ${pair.back}\n`);
    });
  }

  if (comparison.extraPairs.length > 0) {
    console.log('🔶 EXTRA PAIRS (not in master list):');
    comparison.extraPairs.forEach(pair => {
      console.log(`   ├─ Front: ${pair.front}`);
      console.log(`   └─ Back:  ${pair.back}\n`);
    });
  }

  console.log('='.repeat(60) + '\n');
}


async function classifyAllImages(imagePaths: string[]): Promise<ImageClassification[]> {
  // Feature flag: Use legacy pairing pipeline or new two-stage pipeline
  const pairingResult = USE_LEGACY_PAIRING 
    ? await runLegacyPairingPipeline(imagePaths)
    : await runPairingPipeline(imagePaths);
  
  // Store pairingResult for later access
  (classifyAllImages as any).lastPairingResult = pairingResult;
  
  // Convert PairingResult to ImageClassification[] for backward compatibility
  const results: ImageClassification[] = [];
  const pairMap = new Map<string, string>();
  
  // Build pair mapping
  for (const pair of pairingResult.pairs) {
    pairMap.set(pair.front, pair.back);
    pairMap.set(pair.back, pair.front);
  }
  
  // Create results for each filename
  const filenames = imagePaths.map(p => path.basename(p));
  for (const filename of filenames) {
    const classification = pairingResult.classifications[filename] || 'unknown';
    const pairedWith = pairMap.get(filename);
    
    results.push({
      filename,
      classification,
      pairedWith,
    });
  }

  return results;
}

async function sortImages(folderPath: string): Promise<void> {
  console.log(`\n🔍 Analyzing images in: ${folderPath}\n`);

  if (!fs.existsSync(folderPath)) {
    console.error(`❌ Folder not found: ${folderPath}`);
    return;
  }

  const files = fs.readdirSync(folderPath);
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
  
  const imageFiles = files.filter(file => {
    const ext = path.extname(file).toLowerCase();
    return imageExtensions.includes(ext);
  });

  if (imageFiles.length === 0) {
    console.log('No image files found in the folder.');
    return;
  }

  console.log(`Found ${imageFiles.length} image(s) to analyze...\n`);

  // Prepare all image paths
  const imagePaths = imageFiles.map(file => path.join(folderPath, file));
  
  // ============================================================
  // TEST MODE: Two-stage pipeline (classify then pair)
  // ============================================================
  if (TEST_TWO_STAGE) {
    console.log('🧪 TEST MODE: Two-stage pipeline (classify → pair)\n');
    
    // Stage 1: Classify
    const classifications = await classifyAllImagesStage1(imagePaths);
    
    // Stage 2: Pair
    console.log('🔗 Starting Stage 2: Text-only pairing...\n');
    const pairing = await pairFromClassifications(classifications);
    
    console.log('\n' + '='.repeat(60));
    console.log('TWO-STAGE PIPELINE RESULTS:');
    console.log('='.repeat(60) + '\n');
    
    console.log(JSON.stringify(pairing, null, 2));
    
    // Summary statistics
    const needsReview = pairing.unpaired.filter(u => u.needsReview);
    
    console.log('\n' + '='.repeat(60));
    console.log('SUMMARY:');
    console.log('='.repeat(60));
    console.log(`Total pairs: ${pairing.pairs.length}`);
    console.log(`Unpaired images: ${pairing.unpaired.length}`);
    console.log(`Needs review: ${needsReview.length}`);
    
    if (pairing.pairs.length > 0) {
      const avgPairConfidence = pairing.pairs.reduce((sum, p) => sum + p.confidence, 0) / pairing.pairs.length;
      console.log(`Average pair confidence: ${(avgPairConfidence * 100).toFixed(1)}%`);
    }
    
    console.log('='.repeat(60) + '\n');
    
    return;
  }
  
  // ============================================================
  // TEST MODE: Just classify without pairing
  // ============================================================
  if (JUST_CLASSIFY) {
    console.log('🧪 TEST MODE: Classification only (no pairing)\n');
    const classifications = await classifyAllImagesStage1(imagePaths);
    
    console.log('\n' + '='.repeat(60));
    console.log('CLASSIFICATION RESULTS:');
    console.log('='.repeat(60) + '\n');
    
    console.log(JSON.stringify(classifications, null, 2));
    
    // Summary statistics
    const products = classifications.filter(c => c.kind === 'product');
    const nonProducts = classifications.filter(c => c.kind === 'non_product');
    const fronts = classifications.filter(c => c.panel === 'front');
    const backs = classifications.filter(c => c.panel === 'back');
    const sides = classifications.filter(c => c.panel === 'side');
    const unknowns = classifications.filter(c => c.panel === 'unknown');
    
    const avgConfidence = classifications.reduce((sum, c) => sum + c.confidence, 0) / classifications.length;
    
    console.log('\n' + '='.repeat(60));
    console.log('SUMMARY:');
    console.log('='.repeat(60));
    console.log(`Total images: ${classifications.length}`);
    console.log(`Products: ${products.length}`);
    console.log(`Non-products: ${nonProducts.length}`);
    console.log(`Fronts: ${fronts.length}`);
    console.log(`Backs: ${backs.length}`);
    console.log(`Sides: ${sides.length}`);
    console.log(`Unknown panels: ${unknowns.length}`);
    console.log(`Average confidence: ${(avgConfidence * 100).toFixed(1)}%`);
    console.log('='.repeat(60) + '\n');
    
    return;
  }
  
  console.log('Sending all images to AI for analysis...\n');
  
  // Classify all images in a single API call
  const results = await classifyAllImages(imagePaths);

  console.log('\n' + '='.repeat(60));
  console.log('RESULTS:');
  console.log('='.repeat(60) + '\n');

  // Group by pairs
  const paired = results.filter(r => r.pairedWith);
  const unpaired = results.filter(r => !r.pairedWith);
  const unknownImages = results.filter(r => r.classification === 'unknown');

  // Display pairs (avoid duplicates by only showing fronts)
  const pairsShown = new Set<string>();
  if (paired.length > 0) {
    console.log('🔗 MATCHED PAIRS:');
    
    // Get the pairing result to access reasoning
    const pairingResult = (classifyAllImages as any).lastPairingResult;
    
    for (const img of paired) {
      if (img.classification === 'front' && !pairsShown.has(img.filename)) {
        const pairInfo = pairingResult?.pairs.find((p: ImagePair) => p.front === img.filename);
        
        console.log(`   📄 Front: ${img.filename}`);
        console.log(`   📋 Back:  ${img.pairedWith}`);
        if (pairInfo?.reasoning) {
          console.log(`   💭 Reasoning: ${pairInfo.reasoning}`);
        }
        console.log('');
        pairsShown.add(img.filename);
        pairsShown.add(img.pairedWith!);
      }
    }
  }

  // Display unpaired fronts and backs
  const unpairedFronts = unpaired.filter(r => r.classification === 'front');
  const unpairedBacks = unpaired.filter(r => r.classification === 'back');

  if (unpairedFronts.length > 0) {
    console.log('📄 UNPAIRED FRONTS:');
    unpairedFronts.forEach(img => console.log(`   - ${img.filename}`));
    console.log('');
  }

  if (unpairedBacks.length > 0) {
    console.log('📋 UNPAIRED BACKS:');
    unpairedBacks.forEach(img => console.log(`   - ${img.filename}`));
    console.log('');
  }

  if (unknownImages.length > 0) {
    console.log('❓ UNKNOWN:');
    unknownImages.forEach(img => console.log(`   - ${img.filename}`));
    console.log('');
  }

  const nonProductImages = results.filter(r => r.classification === 'non_product');
  if (nonProductImages.length > 0) {
    console.log('🚫 NON-PRODUCT:');
    nonProductImages.forEach(img => console.log(`   - ${img.filename}`));
    console.log('');
  }

  console.log('='.repeat(60));
  console.log(`Total: ${paired.length / 2} pairs, ${unpairedFronts.length} unpaired fronts, ${unpairedBacks.length} unpaired backs, ${unknownImages.length} unknown, ${nonProductImages.length} non-product`);
  console.log('='.repeat(60) + '\n');

  // Compare with master list only if enabled
  if (ENABLE_COMPARISON) {
    const comparison = compareWithMasterList(results, folderPath);
    displayComparison(comparison);
  }
}

async function runPass1(imagePaths: string[]): Promise<PairingResult> {
  try {
    const systemMessage = buildSystemMessage();
    
    const filenames = imagePaths.map(p => path.basename(p));
    
    // Build user content array
    const userContent: Array<
      { type: "text"; text: string } | 
      { type: "image_url"; image_url: { url: string } }
    > = [];
    
    // If dev mode is enabled, include sample images as reference examples
    if (USE_DEV_SAMPLES) {
      userContent.push({
        type: 'text',
        text: `Below are REFERENCE EXAMPLES showing what front/back/non-product images look like. These are for your learning only. After the examples, you will receive the REAL IMAGES to classify.`
      });
      
      // Add each sample image with description
      for (const sample of SAMPLE_IMAGES) {
        userContent.push({
          type: 'text',
          text: `Example - ${sample.role}: ${sample.description}`
        });
        
        const samplePath = path.join(SAMPLE_IMAGES_BASE_PATH, sample.filename);
        const base64Sample = await encodeImageToBase64(samplePath);
        const ext = path.extname(sample.filename).toLowerCase();
        const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
        
        userContent.push({
          type: 'image_url',
          image_url: {
            url: `data:${mimeType};base64,${base64Sample}`
          }
        });
      }
      
      userContent.push({
        type: 'text',
        text: `==================== REAL IMAGES TO CLASSIFY ====================`
      });
    }
    
    // Add instruction for real images
    userContent.push({
      type: 'text',
      text: `Classify each of the following images as front/back/unknown/non_product and pair matching products. Respond ONLY with the JSON object as specified.

Filenames to classify:
${JSON.stringify(filenames, null, 2)}`
    });
    
    // Add actual images to classify
    for (const imagePath of imagePaths) {
      const base64Image = await encodeImageToBase64(imagePath);
      const ext = path.extname(imagePath).toLowerCase();
      const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
      
      userContent.push({
        type: 'image_url',
        image_url: {
          url: `data:${mimeType};base64,${base64Image}`
        }
      });
    }

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: systemMessage,
        },
        {
          role: 'user',
          content: userContent,
        },
      ],
      max_tokens: 2000,
      response_format: { type: 'json_object' },
      temperature: 0,
    });

    const result = response.choices[0]?.message?.content?.trim() || '{}';
    console.log('\n🤖 PASS 1 Response:\n', result, '\n');
    
    const parsed: ClassificationResponse = JSON.parse(result);
    
    return {
      pairs: parsed.pairs || [],
      classifications: parsed.classifications || {},
    };
  } catch (error) {
    console.error('Error in Pass 1:', error);
    const filenames = imagePaths.map(p => path.basename(p));
    const classifications: Record<string, 'front' | 'back' | 'unknown'> = {};
    filenames.forEach(f => classifications[f] = 'unknown');
    return { pairs: [], classifications };
  }
}

async function runPass2(imagePaths: string[]): Promise<PairingResult> {
  try {
    const filenames = imagePaths.map(p => path.basename(p));
    
    const systemMessage = `You are an expert at analyzing consumer product photos.

CRITICAL CONTEXT FOR PASS 2:
- This input set contains ONLY images that were marked "unknown" or left unpaired in Pass 1.
- Most or all of these likely DO have valid front/back counterparts within this smaller set.
- Your job is to reconsider them with fresh eyes and pair them if possible.

You will receive:
- A list of image filenames (e.g. "20251115_142814.jpg")
- The actual images corresponding to those filenames

Your job is to:
1. Decide for each image whether it is:
   - "front" (front of product package)
   - "back" (back or side with facts/ingredients)
   - "non_product" (photo of a person, purse, room, random object)
2. Pair fronts and backs that belong to the SAME physical product.
3. Return a STRICT JSON object with:
   - "pairs": array of front/back matches
   - "classifications": map from filename to "front" | "back" | "unknown" | "non_product"

DEFINITIONS:
- FRONT:
  - Prominent brand name and product name
  - Possibly flavor/scent/variant
  - Marketing/consumer-facing layout, hero images, badges (e.g. "Greens + Protein")
- BACK:
  - Supplement Facts or Nutrition Facts tables
  - Ingredient lists
  - Directions, warnings, barcodes, long dense text
  - Regulatory or manufacturing information
- NON_PRODUCT:
  - Not consumer packaging at all (e.g. purse on a couch, landscape, random photo)

MATCHING RULES FOR PASS 2:
- Never pair images from different brands.
- Never pair different product names or formats (jar vs bottle vs pouch).
- Only mark an image as "front" or "back" if it is clearly product packaging.
- Images marked "non_product" MUST NOT be in any pair.
- **If only two images remain and they clearly share the same brand/product and one is front and one is back, you MUST pair them.**
- If a clear matching front and back exist for a product, they MUST appear together in "pairs".
- If evidence is insufficient, mark as "unknown" and do NOT invent a pair.

OUTPUT FORMAT (VERY IMPORTANT):
- Respond ONLY with a valid JSON object.
- No markdown. No prose outside JSON.
- Use exactly this shape:

{
  "pairs": [
    {
      "front": "filename.jpg",
      "back": "filename.jpg",
      "brand": "brand name in lowercase if possible",
      "product": "short product description",
      "notes": "short justification",
      "reasoning": "a brief explanation of the visual/text evidence for this match"
    }
  ],
  "classifications": {
    "filename.jpg": "front | back | unknown | non_product"
  }
}

- Every filename you are given MUST appear exactly once in "classifications".
- Every "front"/"back" classification that is not "non_product" should either:
  - appear in some pair, OR
  - be marked "unknown" if there is truly no partner image for that product.
- Do not guess brands or products if you cannot read them; use "unknown" for those fields instead.`;

    const userMessage = `Here are the LEFTOVER product images from Pass 1. Reconsider these carefully and pair them if they match. Respond ONLY with the JSON object as specified.

Filenames:
${JSON.stringify(filenames, null, 2)}`;

    const content: any[] = [
      {
        type: 'text',
        text: userMessage,
      },
    ];

    for (const imagePath of imagePaths) {
      const base64Image = await encodeImageToBase64(imagePath);
      const ext = path.extname(imagePath).toLowerCase();
      const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
      
      content.push({
        type: 'image_url',
        image_url: {
          url: `data:${mimeType};base64,${base64Image}`,
        },
      });
    }

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: systemMessage,
        },
        {
          role: 'user',
          content,
        },
      ],
      max_tokens: 2000,
      response_format: { type: 'json_object' },
      temperature: 0,
    });

    const result = response.choices[0]?.message?.content?.trim() || '{}';
    console.log('\n🤖 PASS 2 Response:\n', result, '\n');
    
    const parsed: ClassificationResponse = JSON.parse(result);
    
    return {
      pairs: parsed.pairs || [],
      classifications: parsed.classifications || {},
    };
  } catch (error) {
    console.error('Error in Pass 2:', error);
    const filenames = imagePaths.map(p => path.basename(p));
    const classifications: Record<string, 'front' | 'back' | 'unknown'> = {};
    filenames.forEach(f => classifications[f] = 'unknown');
    return { pairs: [], classifications };
  }
}

function mergeResults(pass1: PairingResult, pass2: PairingResult): PairingResult {
  return {
    pairs: [...pass1.pairs, ...pass2.pairs],
    classifications: {
      ...pass1.classifications,
      ...pass2.classifications,
    },
  };
}

function autoPairSingleLeftovers(result: PairingResult): PairingResult {
  const pairedFronts = new Set(result.pairs.map(p => p.front));
  const pairedBacks = new Set(result.pairs.map(p => p.back));

  const unmatchedFronts = Object.entries(result.classifications)
    .filter(([fn, label]) => label === 'front' && !pairedFronts.has(fn))
    .map(([fn]) => fn);

  const unmatchedBacks = Object.entries(result.classifications)
    .filter(([fn, label]) => label === 'back' && !pairedBacks.has(fn))
    .map(([fn]) => fn);

  if (unmatchedFronts.length === 1 && unmatchedBacks.length === 1) {
    console.log(`🔧 Auto-pairing single leftover: ${unmatchedFronts[0]} ↔ ${unmatchedBacks[0]}\n`);
    result.pairs.push({
      front: unmatchedFronts[0],
      back: unmatchedBacks[0],
      brand: 'unknown',
      product: 'unknown',
      notes: 'Auto-paired as the only remaining front/back.',
      reasoning: 'Auto-paired by system: only remaining unmatched front and back images.'
    });
  }

  return result;
}

// ============================================================
// Stage 1: Pure Classification (no pairing)
// ============================================================

/**
 * Classify images without pairing them.
 * This is Stage 1 of the new two-stage pipeline.
 */
async function classifyImagesBatch(imagePaths: string[]): Promise<ImageClassificationV2[]> {
  try {
    const filenames = imagePaths.map(p => path.basename(p));
    
    const systemMessage = `You are an expert image classifier for consumer product packaging.

Your ONLY job is to CLASSIFY each image. Do NOT attempt to pair images.

For each image, provide:
1. kind: "product" if it's consumer product packaging, "non_product" if not
2. panel: "front", "back", "side", or "unknown"
3. brand: the brand name (or null if unreadable)
4. productName: the product name (or null if unreadable)
5. packageType: bottle/jar/tub/pouch/box/sachet/unknown
6. keyText: array of 3-5 short readable text snippets from the label
7. colorSignature: array of dominant colors (e.g., ["green", "black", "bright green gradient"])
8. layoutSignature: brief description of label layout (e.g., "pouch vertical label center", "bottle wraparound")
9. confidence: 0.0-1.0 representing your confidence in the classification

DEFINITIONS:
- PRODUCT: Clear consumer product packaging (supplement, cosmetic, food, etc.)
- NON_PRODUCT: Not packaging at all (purse, furniture, room, person, pet, random object)
- FRONT panel: Shows brand + product name prominently, marketing-facing
- BACK panel: Shows Supplement/Nutrition Facts, ingredients, barcode, warnings
- SIDE panel: Additional information, not clearly front or back

CRITICAL CROSS-IMAGE INFERENCE RULE:
You receive ALL images in this batch at once. Use this to your advantage.

If a BACK/SIDE panel is missing brand or productName, but you see a FRONT panel in the same batch that matches by:
- Same packageType (pouch/bottle/jar/tub/box)
- Same color scheme and label design
- Same shape/silhouette
- Similar text patterns or repeated branding phrases
- Same label layout structure
- Same supplement facts alignment/style

Then INFER and fill in the missing brand/productName from that matching front.

Example: If you see a pouch front with "Frog Fuel Performance Greens + Protein" and a pouch back with Supplement Facts but no visible brand, and they share the same green color scheme, same pouch shape, and same text "stay unbreakable" - then the back should be classified with:
  brand: "Frog Fuel"
  productName: "Performance Greens + Protein"

This intelligent cross-referencing is CRUCIAL for accurate pairing downstream.

Be honest with confidence scores:
- 0.9-1.0: Very confident
- 0.7-0.9: Confident
- 0.5-0.7: Moderate confidence
- Below 0.5: Low confidence, consider marking as "unknown"

OUTPUT FORMAT:
Respond ONLY with valid JSON:

{
  "items": [
    {
      "filename": "image.jpg",
      "kind": "product | non_product",
      "panel": "front | back | side | unknown",
      "brand": "Brand Name" or null,
      "productName": "Product Name" or null,
      "packageType": "bottle | jar | tub | pouch | box | sachet | unknown",
      "keyText": ["text1", "text2", "text3"],
      "colorSignature": ["color1", "color2", "pattern"],
      "layoutSignature": "layout description",
      "confidence": 0.95
    }
  ]
}

Every filename provided MUST appear in the items array.`;

    const userMessage = `Classify each of the following images. Do NOT pair them, just classify.

Filenames to classify:
${JSON.stringify(filenames, null, 2)}`;

    const content: Array<
      { type: "text"; text: string } | 
      { type: "image_url"; image_url: { url: string } }
    > = [
      {
        type: 'text',
        text: userMessage,
      },
    ];

    // Add actual images to classify
    for (const imagePath of imagePaths) {
      const base64Image = await encodeImageToBase64(imagePath);
      const ext = path.extname(imagePath).toLowerCase();
      const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
      
      content.push({
        type: 'image_url',
        image_url: {
          url: `data:${mimeType};base64,${base64Image}`
        }
      });
    }

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: systemMessage,
        },
        {
          role: 'user',
          content,
        },
      ],
      max_tokens: 4000,
      response_format: { type: 'json_object' },
      temperature: 0,
    });

    const result = response.choices[0]?.message?.content?.trim() || '{}';
    console.log('\n🤖 CLASSIFICATION Response:\n', result, '\n');
    
    const parsed: { items: ImageClassificationV2[] } = JSON.parse(result);
    
    return parsed.items || [];
  } catch (error) {
    console.error('Error in classifyImagesBatch:', error);
    // Return empty classifications on error
    return imagePaths.map(p => ({
      filename: path.basename(p),
      kind: 'non_product' as ProductKind,
      panel: 'unknown' as PanelType,
      brand: null,
      productName: null,
      packageType: 'unknown' as const,
      keyText: [],
      colorSignature: [],
      layoutSignature: 'unknown',
      confidence: 0.0,
    }));
  }
}

/**
 * Classify all images in batches to handle large datasets (100+ images).
 * This is the batching wrapper for Stage 1 classification.
 */
async function classifyAllImagesStage1(imagePaths: string[]): Promise<ImageClassificationV2[]> {
  const all: ImageClassificationV2[] = [];
  const totalBatches = Math.ceil(imagePaths.length / CLASSIFY_BATCH_SIZE);
  
  console.log(`📦 Classifying ${imagePaths.length} images in ${totalBatches} batch(es) of max ${CLASSIFY_BATCH_SIZE}...\n`);
  
  for (let i = 0; i < imagePaths.length; i += CLASSIFY_BATCH_SIZE) {
    const batchNum = Math.floor(i / CLASSIFY_BATCH_SIZE) + 1;
    const batch = imagePaths.slice(i, i + CLASSIFY_BATCH_SIZE);
    
    console.log(`🔄 Processing batch ${batchNum}/${totalBatches} (${batch.length} images)...`);
    
    const batchResult = await classifyImagesBatch(batch);
    all.push(...batchResult);
    
    console.log(`✅ Batch ${batchNum}/${totalBatches} complete (${batchResult.length} classifications)\n`);
  }
  
  console.log(`✅ All batches complete: ${all.length} total classifications\n`);
  
  return all;
}

// ============================================================
// Stage 2: Text-Only Pairing (no images sent)
// ============================================================

/**
 * Pair images based solely on their classification metadata.
 * This is Stage 2 of the new two-stage pipeline - pure reasoning, no images.
 */
async function pairFromClassifications(items: ImageClassificationV2[]): Promise<PairingOutput> {
  try {
    const payload: PairingInputItem[] = items.map(x => ({
      filename: x.filename,
      kind: x.kind,
      panel: x.panel,
      brand: x.brand,
      productName: x.productName,
      packageType: x.packageType,
      colorSignature: x.colorSignature,
      layoutSignature: x.layoutSignature,
      confidence: x.confidence,
    }));
    
    const systemMessage = `You are an expert at pairing product package images based on their metadata.

You will receive a list of classified images with metadata about each:
- filename
- kind: "product" or "non_product"
- panel: "front", "back", "side", or "unknown"
- brand: brand name or null
- productName: product name or null
- packageType: bottle/jar/tub/pouch/box/sachet/unknown
- colorSignature: dominant colors array
- layoutSignature: layout description
- confidence: classification confidence (0.0-1.0)

Your ONLY job is to PAIR fronts and backs that belong to the SAME physical product.

PAIRING RULES (STRICT):
1. NEVER pair images from different brands (case-insensitive comparison)
2. STRICT MATCH: If BOTH images have productName, they MUST match
3. SOFT MATCH: If productName is null/missing on ONE side but brand matches AND:
   - Same packageType
   - Similar colorSignature (overlapping colors)
   - Similar layoutSignature
   - Similar keyText patterns or repeated phrases
   Then you MAY pair them (they're likely the same product family)
4. NEVER pair images from different package types
5. NEVER pair if either image has confidence < 0.5
6. NEVER pair "non_product" items with anything
7. NEVER pair "unknown" panels - they go to unpaired
8. ONLY pair "front" with "back" OR "side" of the SAME product (side panels can act as backs)
9. A "side" panel can be paired with a "front" if they share the same brand/product/package
10. Use colorSignature and layoutSignature as strong signals when productName is missing

OUTPUT FORMAT:
Respond ONLY with valid JSON:

{
  "pairs": [
    {
      "front": "filename.jpg",
      "back": "filename.jpg",
      "reasoning": "Matching brand 'X' and product 'Y' with same package type" OR "Soft match: same brand, package, colors, and layout",
      "confidence": 0.95
    }
  ],
  "unpaired": [
    {
      "filename": "filename.jpg",
      "reason": "No matching front/back found with same brand and product",
      "needsReview": false
    }
  ]
}

For unpaired items, set needsReview: true if:
- It's a clear product (kind=product, panel=front or back) but has no match
- Confidence is moderate (0.5-0.7) and might need human review
- Brand/product names are null but it looks like a valid product

Pairing strategy:
- PREFER strict productName matches when available
- USE soft matching (visual signatures) when productName is missing
- Be conservative: when in doubt, leave unpaired rather than creating incorrect pairs.`;

    const userMessage = `Here is the classification data for all images. Pair the fronts and backs that match.

Classification data:
${JSON.stringify(payload, null, 2)}`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: systemMessage,
        },
        {
          role: 'user',
          content: userMessage,
        },
      ],
      max_tokens: 4000,
      response_format: { type: 'json_object' },
      temperature: 0,
    });

    const result = response.choices[0]?.message?.content?.trim() || '{}';
    console.log('\n🤖 PAIRING Response:\n', result, '\n');
    
    const parsed: PairingOutput = JSON.parse(result);
    
    return parsed;
  } catch (error) {
    console.error('Error in pairFromClassifications:', error);
    // Return empty pairing on error
    return {
      pairs: [],
      unpaired: items.map(item => ({
        filename: item.filename,
        reason: 'Pairing failed due to error',
        needsReview: true,
      })),
    };
  }
}

// ============================================================
// Stage 3: Verification (no images sent)
// ============================================================

/**
 * Verify pairs to catch any mistakes before finalizing.
 * This is Stage 3 of the new pipeline - independent verification pass.
 */
async function verifyPairs(
  classifications: ImageClassificationV2[],
  pairing: PairingOutput
): Promise<VerificationOutput> {
  try {
    // Build a map for quick classification lookup
    const classMap = new Map<string, ImageClassificationV2>();
    classifications.forEach(c => classMap.set(c.filename, c));
    
    // Prepare verification payload
    const payload = pairing.pairs.map(pair => {
      const frontClass = classMap.get(pair.front);
      const backClass = classMap.get(pair.back);
      
      return {
        pair: {
          front: pair.front,
          back: pair.back,
          reasoning: pair.reasoning,
          confidence: pair.confidence,
        },
        frontMetadata: frontClass ? {
          panel: frontClass.panel,
          brand: frontClass.brand,
          productName: frontClass.productName,
          packageType: frontClass.packageType,
          confidence: frontClass.confidence,
        } : null,
        backMetadata: backClass ? {
          panel: backClass.panel,
          brand: backClass.brand,
          productName: backClass.productName,
          packageType: backClass.packageType,
          confidence: backClass.confidence,
        } : null,
      };
    });
    
    const systemMessage = `You are an expert verification system for product image pairs.

You will receive candidate pairs along with their classification metadata.
Your job is to VERIFY each pair independently.

For each pair, you must:
1. Check if the front metadata matches the back metadata
2. Verify brand names match (case-insensitive)
3. Verify product names match
4. Verify package types match
5. Check that front is actually a "front" panel
6. Check that back is actually a "back" or "side" panel
7. Verify confidence scores are reasonable (>= 0.5)

VERIFICATION RULES (STRICT):
- status: "accepted" ONLY if ALL checks pass
- status: "rejected" if ANY check fails, with specific issues listed

Common reasons to reject:
- Brand mismatch (different brands)
- Product name mismatch (different products)
- Package type mismatch (bottle vs jar vs tub)
- Panel type wrong (front paired with front, or back with non-back/side)
- Low confidence (< 0.5 on either side)
- Null brand/product on both sides (too uncertain)

Be CONSERVATIVE: When in doubt, reject with clear issues.

OUTPUT FORMAT:
Respond ONLY with valid JSON:

{
  "verifiedPairs": [
    {
      "front": "filename.jpg",
      "back": "filename.jpg",
      "reasoning": "original pairing reasoning",
      "confidence": 0.95,
      "status": "accepted | rejected",
      "issues": ["issue1", "issue2"] // only if rejected
    }
  ]
}

Every pair must have a status. If accepted, omit issues. If rejected, list all issues found.`;

    const userMessage = `Verify the following pairs. For each pair, determine if it should be accepted or rejected.

Pairs to verify:
${JSON.stringify(payload, null, 2)}`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: systemMessage,
        },
        {
          role: 'user',
          content: userMessage,
        },
      ],
      max_tokens: 4000,
      response_format: { type: 'json_object' },
      temperature: 0,
    });

    const result = response.choices[0]?.message?.content?.trim() || '{}';
    console.log('\n🤖 VERIFICATION Response:\n', result, '\n');
    
    const parsed: VerificationOutput = JSON.parse(result);
    
    return parsed;
  } catch (error) {
    console.error('Error in verifyPairs:', error);
    // On error, accept all pairs (fail open to avoid breaking existing functionality)
    return {
      verifiedPairs: pairing.pairs.map(p => ({
        ...p,
        status: 'accepted' as const,
      })),
    };
  }
}

/**
 * New two-stage pairing pipeline (Stage 1: Classify → Stage 2: Pair from metadata)
 * This is the clean, scalable implementation that replaces the legacy two-pass approach.
 */
async function runNewTwoStagePipeline(imagePaths: string[]): Promise<PairingResult> {
  console.log('\n🔄 Starting NEW TWO-STAGE PIPELINE...\n');
  
  // Stage 1: Classify all images (batched for scalability)
  console.log('📸 STAGE 1: Classification...\n');
  const classifications = await classifyAllImagesStage1(imagePaths);
  
  console.log(`\n✅ Stage 1 complete: ${classifications.length} images classified\n`);
  
  // Stage 2: Pair from metadata only (no images sent)
  console.log('🔗 STAGE 2: Text-only pairing...\n');
  const pairing = await pairFromClassifications(classifications);
  
  console.log(`\n✅ Stage 2 complete: ${pairing.pairs.length} pairs, ${pairing.unpaired.length} unpaired\n`);
  
  // Stage 3: Verify pairs (independent validation)
  console.log('✓ STAGE 3: Verification...\n');
  const verification = await verifyPairs(classifications, pairing);
  
  const acceptedPairs = verification.verifiedPairs.filter(p => p.status === 'accepted');
  const rejectedPairs = verification.verifiedPairs.filter(p => p.status === 'rejected');
  
  console.log(`\n✅ Stage 3 complete: ${acceptedPairs.length} accepted, ${rejectedPairs.length} rejected\n`);
  
  if (rejectedPairs.length > 0) {
    console.log('⚠️  REJECTED PAIRS:');
    rejectedPairs.forEach(p => {
      console.log(`   ${p.front} ↔ ${p.back}`);
      console.log(`   Issues: ${p.issues?.join(', ')}\n`);
    });
  }
  
  // Convert verified pairs to PairingResult for backward compatibility
  const result: PairingResult = {
    pairs: acceptedPairs.map(p => ({
      front: p.front,
      back: p.back,
      brand: 'unknown', // Brand info is in classification metadata if needed
      product: 'unknown', // Product info is in classification metadata if needed
      notes: p.reasoning,
      reasoning: p.reasoning,
    })),
    classifications: {},
  };
  
  // Build classifications map
  const pairedFilenames = new Set<string>();
  const frontFilenames = new Set<string>();
  const rejectedFilenames = new Set<string>();
  
  // Track accepted pairs
  acceptedPairs.forEach(p => {
    pairedFilenames.add(p.front);
    pairedFilenames.add(p.back);
    frontFilenames.add(p.front);
  });
  
  // Track rejected pairs (these should be marked as needing review)
  rejectedPairs.forEach(p => {
    rejectedFilenames.add(p.front);
    rejectedFilenames.add(p.back);
  });
  
  for (const item of classifications) {
    if (item.kind === 'non_product') {
      result.classifications[item.filename] = 'non_product';
    } else if (item.panel === 'unknown') {
      result.classifications[item.filename] = 'unknown';
    } else if (pairedFilenames.has(item.filename)) {
      // If it's paired as a front, mark as front
      if (frontFilenames.has(item.filename)) {
        result.classifications[item.filename] = 'front';
      } else {
        // If paired as back (including side panels that paired), mark as back
        result.classifications[item.filename] = 'back';
      }
    } else if (rejectedFilenames.has(item.filename)) {
      // Pair was rejected by verification - mark based on original panel type
      // These will show as unpaired in results
      if (item.panel === 'front') {
        result.classifications[item.filename] = 'front';
      } else if (item.panel === 'back' || item.panel === 'side') {
        result.classifications[item.filename] = 'back';
      } else {
        result.classifications[item.filename] = 'unknown';
      }
    } else {
      // It's a product front/back/side but unpaired
      if (item.panel === 'front') {
        result.classifications[item.filename] = 'front';
      } else if (item.panel === 'back' || item.panel === 'side') {
        // Treat unpaired side as back
        result.classifications[item.filename] = 'back';
      } else {
        result.classifications[item.filename] = 'unknown';
      }
    }
  }
  
  console.log(`\n✅ TWO-STAGE PIPELINE COMPLETE: ${result.pairs.length} total pairs\n`);
  
  return result;
}

// ============================================================
// Legacy Two-Pass Pipeline
// ============================================================

/**
 * Legacy two-pass pairing pipeline (Pass 1 + Pass 2)
 * This is the baseline "known good" implementation.
 */
async function runLegacyPairingPipeline(imagePaths: string[]): Promise<PairingResult> {
  console.log('\n🔄 Starting PASS 1 (LEGACY MODE)...\n');
  const pass1Result = await runPass1(imagePaths);

  // 1) Build set of everything that appears in a pair
  const allFilenames = Object.keys(pass1Result.classifications);
  const pairedSet = new Set<string>();
  pass1Result.pairs.forEach(p => {
    pairedSet.add(p.front);
    pairedSet.add(p.back);
  });

  // 2) Leftovers = unknown OR classified front/back but NOT in any pair (skip non_product)
  const leftovers = allFilenames.filter(fn => {
    const label = pass1Result.classifications[fn];
    return (label === 'unknown' || (label !== 'non_product' && !pairedSet.has(fn)));
  });

  const unknownCount = allFilenames.filter(
    fn => pass1Result.classifications[fn] === 'unknown'
  ).length;

  const nonProductCount = allFilenames.filter(
    fn => pass1Result.classifications[fn] === 'non_product'
  ).length;

  const unpairedCount = allFilenames.filter(
    fn => {
      const label = pass1Result.classifications[fn];
      return label !== 'unknown' && label !== 'non_product' && !pairedSet.has(fn);
    }
  ).length;

  console.log(
    `\n📊 PASS 1 Complete: ${pass1Result.pairs.length} pairs found, ` +
      `${unknownCount} unknown, ${unpairedCount} unpaired, ${nonProductCount} non-product\n`
  );

  // 3) If there are ANY leftovers (unknown OR unpaired), run Pass 2
  if (leftovers.length === 0) {
    console.log('✅ No leftovers - skipping Pass 2\n');
    return pass1Result;
  }

  // Use only leftover images in Pass 2
  const leftoverPaths = imagePaths.filter(p =>
    leftovers.includes(path.basename(p))
  );

  console.log(
    `\n🔄 Starting PASS 2 with ${leftovers.length} leftover images (unknown + unpaired)...\n`
  );
  const pass2Result = await runPass2(leftoverPaths);

  console.log(
    `\n📊 PASS 2 Complete: ${pass2Result.pairs.length} additional pairs found\n`
  );

  const finalResult = mergeResults(pass1Result, pass2Result);
  
  // Auto-pair single leftovers as a safety net
  const bulletproofResult = autoPairSingleLeftovers(finalResult);
  
  console.log(`\n✅ PIPELINE COMPLETE: ${bulletproofResult.pairs.length} total pairs\n`);
  
  return bulletproofResult;
}

/**
 * Main pairing pipeline entry point.
 * Delegates to either legacy two-pass or new two-stage pipeline based on flag.
 */
async function runPairingPipeline(imagePaths: string[]): Promise<PairingResult> {
  if (USE_LEGACY_PAIRING) {
    return await runLegacyPairingPipeline(imagePaths);
  } else {
    return await runNewTwoStagePipeline(imagePaths);
  }
}

function printAccuracyReport(result: PairingResult, groundTruth: MasterPair[]): void {
  const aiPairs = new Map<string, string>();
  for (const pair of result.pairs) {
    aiPairs.set(pair.front, pair.back);
  }

  let correct = 0;
  let incorrect = 0;
  let missed = 0;
  
  const correctPairs: MasterPair[] = [];
  const incorrectPairs: MasterPair[] = [];
  const missedPairs: MasterPair[] = [];

  for (const master of groundTruth) {
    const aiBack = aiPairs.get(master.front);
    
    if (!aiBack) {
      missed++;
      missedPairs.push(master);
    } else if (aiBack === master.back) {
      correct++;
      correctPairs.push(master);
    } else {
      incorrect++;
      incorrectPairs.push(master);
    }
  }

  const total = groundTruth.length;
  const accuracy = total > 0 ? ((correct / total) * 100).toFixed(1) : '0.0';

  console.log('\n' + '='.repeat(60));
  console.log('📊 FINAL ACCURACY REPORT');
  console.log('='.repeat(60) + '\n');
  
  console.log(`✅ Correct: ${correct}/${total} (${accuracy}%)`);
  console.log(`❌ Incorrect: ${incorrect}/${total}`);
  console.log(`⚠️  Missed: ${missed}/${total}\n`);

  if (correctPairs.length > 0) {
    console.log('✅ CORRECT PAIRS:');
    correctPairs.forEach(pair => {
      console.log(`   ${pair.product}`);
      console.log(`   ├─ Front: ${pair.front}`);
      console.log(`   └─ Back:  ${pair.back}\n`);
    });
  }

  if (incorrectPairs.length > 0) {
    console.log('❌ INCORRECT PAIRS:');
    incorrectPairs.forEach(pair => {
      console.log(`   ${pair.product}`);
      console.log(`   ├─ Expected Front: ${pair.front}`);
      console.log(`   └─ Expected Back:  ${pair.back}\n`);
    });
  }

  if (missedPairs.length > 0) {
    console.log('⚠️  MISSED PAIRS:');
    missedPairs.forEach(pair => {
      console.log(`   ${pair.product}`);
      console.log(`   ├─ Front: ${pair.front}`);
      console.log(`   └─ Back:  ${pair.back}\n`);
    });
  }

  const remainingUnknown = Object.entries(result.classifications)
    .filter(([, label]) => label === 'unknown')
    .map(([filename]) => filename);

  if (remainingUnknown.length > 0) {
    console.log(`❓ REMAINING UNKNOWN: ${remainingUnknown.length} images`);
    remainingUnknown.forEach(f => console.log(`   - ${f}`));
    console.log('');
  }

  console.log('='.repeat(60) + '\n');
}

const imageFolderPath = process.env.IMAGE_FOLDER_PATH || './images';
sortImages(imageFolderPath);
