/**
 * Pairing V2 Core: Deterministic + LLM Pairing System
 * 
 * This module provides a clean, library-friendly pairing pipeline with three stages:
 * 1. Classification: Classify all images (product/non-product, front/back/side panels)
 * 2. Pairing: Match fronts with backs based on metadata (brand, product, colors, layout)
 * 3. Verification: Independent validation pass to catch mistakes
 * 
 * Ported from the working image-sorter project, optimized for integration with SmartDrafts.
 */

import * as fs from 'fs';
import * as path from 'path';
import { openai } from '../lib/openai.js';

// ============================================================
// Public Types & Interfaces
// ============================================================

export interface PairingResult {
  pairs: Array<{
    front: string;
    back: string;
    confidence: number;
    brand?: string | null;
    brandWebsite?: string | null;
    title?: string | null;
    product?: string | null;
  }>;
  unpaired: Array<{
    imagePath: string;
    reason: string;
    needsReview: boolean;
  }>;
  metrics: {
    totals: {
      images: number;
      fronts: number;
      backs: number;
      candidates: number;
      autoPairs: number;
      modelPairs: number;
      globalPairs: number;
      singletons: number;
    };
    byBrand: Record<string, { fronts: number; paired: number; pairRate: number }>;
    reasons: Record<string, number>;
  };
}

// ============================================================
// Internal Types
// ============================================================

type PanelType = 'front' | 'back' | 'side' | 'unknown';
type ProductKind = 'product' | 'non_product';

interface ImageClassificationV2 {
  filename: string;
  kind: ProductKind;
  panel: PanelType;
  brand: string | null;
  productName: string | null;
  title: string | null; // For books: the book title. For products: null
  brandWebsite: string | null; // Official brand website URL (e.g., "https://myrkmd.com", "https://rootbrands.com")
  packageType: 'bottle' | 'jar' | 'tub' | 'pouch' | 'box' | 'sachet' | 'book' | 'unknown';
  keyText: string[];
  colorSignature: string[];
  layoutSignature: string;
  confidence: number;
}

interface PairingInputItem {
  filename: string;
  kind: ProductKind;
  panel: PanelType;
  brand: string | null;
  productName: string | null;
  title: string | null;
  brandWebsite: string | null;
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
// Helper Functions
// ============================================================

async function encodeImageToBase64(imagePath: string): Promise<string> {
  const imageBuffer = fs.readFileSync(imagePath);
  return imageBuffer.toString('base64');
}

// ============================================================
// Stage 1: Classification (batched for scalability)
// ============================================================

const CLASSIFY_BATCH_SIZE = 12; // Max images per API call to avoid payload limits
const MAX_RETRIES = 2; // Retry failed API calls up to 2 times
const RETRY_DELAY_MS = 2000; // Wait 2 seconds between retries

export async function classifyImagesBatch(imagePaths: string[], retryAttempt = 0): Promise<ImageClassificationV2[]> {
  try {
    const filenames = imagePaths.map(p => path.basename(p));
    
    const systemMessage = `You are an expert image classifier for consumer product packaging.

Your ONLY job is to CLASSIFY each image. Do NOT attempt to pair images.

For each image, provide:
1. kind: "product" if it's consumer product packaging, "non_product" if not
2. panel: "front", "back", "side", or "unknown"
3. brand: 
   - For supplements/cosmetics/food packaging: the brand name (e.g., "Root", "Jocko", "Natural Stacks")
   - For books: MUST be null (books don't have brands in our system)
   - null if unreadable
4. productName: 
   - For supplements/cosmetics/food packaging: the product name (e.g., "Clean Slate", "Fish Oil", "Dopamine Brain Food")
   - For books: the author name (e.g., "Bobbi Brown", "J.K. Rowling")
   - null if unreadable
5. title:
   - For books ONLY: the book title (e.g., "Still Bobbi", "Harry Potter and the Sorcerer's Stone")
   - For supplements/cosmetics/food packaging: MUST be null
   - null if unreadable
6. brandWebsite:
   - The official brand website URL if you can infer it from the brand name or visible text
   - If a SPECIFIC product URL is visible on packaging (e.g., QR code destination, printed URL), return the full URL including path
   - Otherwise, return just the domain: "https://domainname.com"
   - Examples: "https://robkellermd.com/original-glutathione-supplement.html" (if visible), "https://rootbrands.com" (domain only)
   - null if brand is unknown or you cannot confidently infer the URL
   - Use common patterns for domains: brand name + .com, remove spaces/special chars
7. packageType: bottle/jar/tub/pouch/box/sachet/book/unknown
8. keyText: array of 3-5 short readable text snippets from the label
9. colorSignature: array of dominant colors (e.g., ["green", "black", "bright green gradient"])
10. layoutSignature: brief description of label layout (e.g., "pouch vertical label center", "bottle wraparound")
11. confidence: 0.0-1.0 representing your confidence in the classification
12. rationale: brief explanation of your classification choices

DEFINITIONS:
- PRODUCT: Clear consumer product packaging (supplement, cosmetic, food, book, etc.)
- NON_PRODUCT: Not packaging at all (purse, furniture, room, person, pet, random object)
- FRONT panel: 
  - For packaging: Shows brand + product name prominently, marketing-facing
  - For books: Front cover with title and author
- BACK panel: 
  - For packaging: Shows Supplement/Nutrition Facts, ingredients, barcode, warnings
  - For books: Back cover with description, ISBN, barcode
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
      "productName": "Product Name or Author Name" or null,
      "title": "Book Title (only for books)" or null,
      "brandWebsite": "https://brandname.com" or null,
      "packageType": "bottle | jar | tub | pouch | box | sachet | book | unknown",
      "keyText": ["text1", "text2", "text3"],
      "colorSignature": ["color1", "color2", "pattern"],
      "layoutSignature": "layout description",
      "confidence": 0.95,
      "rationale": "Brief explanation of classification choices"
    }
  ]
}

CRITICAL FIELD MAPPING FOR BOOKS:
- If packageType is "book":
  * brand MUST be null
  * title MUST contain the book title (e.g., "Still Bobbi")
  * productName MUST contain the author name (e.g., "Bobbi Brown")
- If packageType is NOT "book":
  * brand MUST contain the brand name (e.g., "Natural Stacks")
  * title MUST be null
  * productName MUST contain the product name (e.g., "Dopamine Brain Food")

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
          content: content,
        },
      ],
      max_tokens: 4000,
      response_format: { type: 'json_object' },
      temperature: 0,
    });

    const result = response.choices[0]?.message?.content?.trim() || '{}';
    
    // Validate JSON before parsing
    if (!result || result === '{}') {
      throw new Error('GPT returned empty response');
    }
    
    let parsed: { items: ImageClassificationV2[] };
    try {
      parsed = JSON.parse(result);
    } catch (parseError: any) {
      console.error('[pairing-v2] JSON parse error:', parseError.message);
      console.error('[pairing-v2] Response preview:', result.substring(0, 500));
      throw new Error(`Invalid JSON from GPT: ${parseError.message}`);
    }
    
    // HOTFIX: GPT-4o sometimes ignores the title field for books
    // If packageType is book and title is missing, copy productName to title
    parsed.items?.forEach((item: any) => {
      if (item.packageType === 'book' && !item.title && item.productName) {
        console.log(`[pairing-v2] HOTFIX: Moving productName "${item.productName}" to title for book ${item.filename}`);
        item.title = item.productName;
        // Keep productName as author name (it's usually correct)
      }
    });
    
    // Log full classification for debugging
    console.log('[pairing-v2] Classification results:', JSON.stringify(parsed.items, null, 2));
    
    // Log rationale for each classification
    parsed.items?.forEach((item: any) => {
      if (item.rationale) {
        console.log(`[pairing-v2] ${item.filename}: ${item.rationale}`);
      }
    });
    
    return parsed.items || [];
  } catch (error: any) {
    console.error('[pairing-v2] Error in classifyImagesBatch:', error);
    
    // Retry logic for transient GPT API errors
    if (retryAttempt < MAX_RETRIES) {
      const isRetryable = 
        error.message?.includes('JSON') || 
        error.message?.includes('Unterminated') ||
        error.message?.includes('empty response') ||
        error.status === 500 ||
        error.status === 503;
      
      if (isRetryable) {
        console.warn(`[pairing-v2] ⚠️ Retryable error detected (attempt ${retryAttempt + 1}/${MAX_RETRIES})`);
        console.warn(`[pairing-v2] Waiting ${RETRY_DELAY_MS}ms before retry...`);
        
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        
        console.log(`[pairing-v2] 🔄 Retrying classification batch (attempt ${retryAttempt + 2}/${MAX_RETRIES + 1})...`);
        return classifyImagesBatch(imagePaths, retryAttempt + 1);
      }
    }
    
    // If all retries exhausted or non-retryable error, log and fail gracefully
    console.error('[pairing-v2] ❌ Classification failed after retries');
    throw error; // Re-throw to propagate to caller for proper error handling
  }
}

async function classifyAllImagesStage1(imagePaths: string[]): Promise<ImageClassificationV2[]> {
  // For cross-image inference to work, ALL related images must be in the same batch
  // Process all images in a single call (background function has 10min timeout)
  console.log(`[pairing-v2] Classifying all ${imagePaths.length} images in single batch for cross-image inference...`);
  
  const batchStart = Date.now();
  const all = await classifyImagesBatch(imagePaths);
  const batchDuration = ((Date.now() - batchStart) / 1000).toFixed(1);
  
  console.log(`[pairing-v2] Classification complete: ${all.length} total classifications (${batchDuration}s, ${(imagePaths.length / parseFloat(batchDuration)).toFixed(1)} img/s)`);
  
  return all;
}

// ============================================================
// Stage 2: Text-Only Pairing (no images sent)
// ============================================================

export async function pairFromClassifications(items: ImageClassificationV2[]): Promise<PairingOutput> {
  try {
    const payload: PairingInputItem[] = items.map(x => ({
      filename: x.filename,
      kind: x.kind,
      panel: x.panel,
      brand: x.brand,
      productName: x.productName,
      title: x.title,
      brandWebsite: x.brandWebsite,
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
- brand: brand name (null for books) or null
- productName: product name (or author for books) or null
- title: book title (null for products) or null
- packageType: bottle/jar/tub/pouch/box/sachet/book/unknown
- colorSignature: dominant colors array
- layoutSignature: layout description
- confidence: classification confidence (0.0-1.0)

Your ONLY job is to PAIR fronts and backs that belong to the SAME physical product.

PAIRING RULES (STRICT):
1. For products: NEVER pair images from different brands (case-insensitive comparison)
   For books: NEVER pair images from different titles (case-insensitive comparison)
2. STRICT MATCH: If BOTH images have productName, they MUST match
3. SOFT MATCH: If productName is null/missing on ONE side but brand matches AND:
   - Same packageType
   - Similar colorSignature (overlapping colors)
   - Similar layoutSignature
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
    const parsed: PairingOutput = JSON.parse(result);
    
    console.log('[pairing-v2] Pairing results:', JSON.stringify(parsed, null, 2));
    
    return parsed;
  } catch (error) {
    console.error('[pairing-v2] Error in pairFromClassifications:', error);
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
// Stage 3: Verification (independent validation)
// ============================================================

export async function verifyPairs(
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
          title: frontClass.title,
          packageType: frontClass.packageType,
          confidence: frontClass.confidence,
        } : null,
        backMetadata: backClass ? {
          panel: backClass.panel,
          brand: backClass.brand,
          productName: backClass.productName,
          title: backClass.title,
          packageType: backClass.packageType,
          confidence: backClass.confidence,
        } : null,
      };
    });
    
    console.log('[pairing-v2] Verifying', pairing.pairs.length, 'pairs');
    console.log('[pairing-v2] Verification payload:', JSON.stringify(payload, null, 2));
    
    const systemMessage = `You are an expert verification system for product image pairs.

You will receive candidate pairs along with their classification metadata.
Your job is to VERIFY each pair independently.

For each pair, you must:
1. Check if the front metadata matches the back metadata
2. Verify identity:
   - For products (packageType != 'book'): brand must match (case-insensitive)
   - For books (packageType == 'book'): title must match (case-insensitive)
   - IMPORTANT: Books have null brand by design - this is NORMAL and ACCEPTABLE
3. Verify product names match OR one side is null (acceptable for books/products where back doesn't show product name)
4. Verify package types match
5. Check that front is actually a "front" panel
6. Check that back is actually a "back" or "side" panel
7. Verify confidence scores are reasonable (>= 0.5)

VERIFICATION RULES:
- status: "accepted" if the following conditions are met:
  * EITHER brand matches (for products) OR title matches (for books)
  * AND packageType matches
  * AND panels are correct (front with back/side)
  * AND (productName matches OR one is null)
- status: "rejected" if ANY critical check fails, with specific issues listed

Critical checks (MUST pass):
- Identity match:
  * If packageType == 'book': Check if titles match (brand will be null - IGNORE IT)
  * If packageType != 'book': Check if brands match (title will be null - IGNORE IT)
  * NEVER reject a book pair just because brand is null - books don't have brands in our system
  * ONLY reject if the identifying field (brand for products, title for books) is null on BOTH sides
- Package types must match (bottle/jar/box/book/etc)
- Front must be "front" panel
- Back must be "back" or "side" panel
- Confidence >= 0.5 on both sides

Flexible checks (one can be null):
- Product name: Accept if both match OR if one side is null (common for backs/books)

Common reasons to reject:
- Identity mismatch: For products, brands don't match; for books, titles don't match
- Package type mismatch (bottle vs jar vs book)
- Panel type wrong (front paired with front, or back with non-back/side)
- Low confidence (< 0.5 on either side)
- Complete uncertainty: The identifying field (brand for products, title for books) is null on BOTH sides

EXAMPLES:
- Book with packageType='book', brand=null, title='Harry Potter' on both sides: ACCEPT (title matches)
- Product with packageType='bottle', brand='Jocko', title=null on both sides: ACCEPT (brand matches)
- Product with packageType='bottle', brand=null, title=null on both sides: REJECT (no identity)
- Book with packageType='book', brand=null, title=null on both sides: REJECT (no identity)

NEVER reject a book just because brand is null. Books don't use the brand field.

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
    const parsed: VerificationOutput = JSON.parse(result);
    
    return parsed;
  } catch (error) {
    console.error('[pairing-v2] Error in verifyPairs:', error);
    // On error, accept all pairs (fail open to avoid breaking functionality)
    return {
      verifiedPairs: pairing.pairs.map(p => ({
        ...p,
        status: 'accepted' as const,
      })),
    };
  }
}

// ============================================================
// Main Pipeline: Public API
// ============================================================

/**
 * Run the new two-stage pairing pipeline on a set of image paths.
 * 
 * @param imagePaths - Full filesystem paths to existing image files
 * @returns PairingResult with pairs, unpaired items, and metrics
 */
export async function runNewTwoStagePipeline(imagePaths: string[]): Promise<PairingResult> {
  const startTime = Date.now();
  console.log(`[pairing-v2] Starting pipeline on ${imagePaths.length} images`);
  
  // Stage 1: Classify all images (batched for scalability)
  const stage1Start = Date.now();
  const classifications = await classifyAllImagesStage1(imagePaths);
  const stage1Duration = ((Date.now() - stage1Start) / 1000).toFixed(1);
  console.log(`[pairing-v2] ⏱️ Stage 1 (Vision Classification): ${stage1Duration}s for ${imagePaths.length} images`);
  
  // Stage 2: Pair from metadata only (no images sent)
  const stage2Start = Date.now();
  const pairing = await pairFromClassifications(classifications);
  const stage2Duration = ((Date.now() - stage2Start) / 1000).toFixed(1);
  console.log(`[pairing-v2] ⏱️ Stage 2 (Pairing Logic): ${stage2Duration}s`);
  
  // Stage 3: Verify pairs (independent validation)
  const stage3Start = Date.now();
  const verification = await verifyPairs(classifications, pairing);
  const stage3Duration = ((Date.now() - stage3Start) / 1000).toFixed(1);
  console.log(`[pairing-v2] ⏱️ Stage 3 (Verification): ${stage3Duration}s`);
  
  const acceptedPairs = verification.verifiedPairs.filter(p => p.status === 'accepted');
  const rejectedPairs = verification.verifiedPairs.filter(p => p.status === 'rejected');
  
  // Build classification map for metrics
  const classMap = new Map<string, ImageClassificationV2>();
  classifications.forEach(c => classMap.set(c.filename, c));
  
  // Extract brand/product info for each accepted pair
  const pairs = acceptedPairs.map(p => {
    const frontClass = classMap.get(p.front);
    return {
      front: p.front,
      back: p.back,
      confidence: p.confidence,
      brand: frontClass?.brand || null,
      brandWebsite: frontClass?.brandWebsite || null,
      title: frontClass?.title || null,
      product: frontClass?.productName || null,
    };
  });
  
  // Build unpaired list from pairing output + rejected pairs
  const unpaired = [
    ...pairing.unpaired.map(u => ({
      imagePath: u.filename,
      reason: u.reason,
      needsReview: u.needsReview,
    })),
    ...rejectedPairs.flatMap(p => [
      {
        imagePath: p.front,
        reason: `Pair rejected: ${p.issues?.join(', ') || 'verification failed'}`,
        needsReview: true,
      },
      {
        imagePath: p.back,
        reason: `Pair rejected: ${p.issues?.join(', ') || 'verification failed'}`,
        needsReview: true,
      },
    ]),
  ];
  
  // Calculate metrics
  const pairedFilenames = new Set<string>();
  pairs.forEach(p => {
    pairedFilenames.add(p.front);
    pairedFilenames.add(p.back);
  });
  
  const fronts = classifications.filter(c => c.panel === 'front').length;
  const backs = classifications.filter(c => c.panel === 'back' || c.panel === 'side').length;
  
  // Build brand metrics
  const byBrand: Record<string, { fronts: number; paired: number; pairRate: number }> = {};
  classifications.forEach(c => {
    if (c.kind === 'product' && c.panel === 'front' && c.brand) {
      const brandKey = c.brand.toLowerCase();
      if (!byBrand[brandKey]) {
        byBrand[brandKey] = { fronts: 0, paired: 0, pairRate: 0 };
      }
      byBrand[brandKey].fronts++;
      if (pairedFilenames.has(c.filename)) {
        byBrand[brandKey].paired++;
      }
    }
  });
  
  // Calculate pair rates
  Object.keys(byBrand).forEach(brand => {
    const { fronts, paired } = byBrand[brand];
    byBrand[brand].pairRate = fronts > 0 ? paired / fronts : 0;
  });
  
  // Build reason counts
  const reasons: Record<string, number> = {};
  unpaired.forEach(u => {
    reasons[u.reason] = (reasons[u.reason] || 0) + 1;
  });
  
  const metrics = {
    totals: {
      images: imagePaths.length,
      fronts,
      backs,
      candidates: fronts + backs,
      autoPairs: 0, // Not used in this pipeline (no heuristics)
      modelPairs: pairs.length,
      globalPairs: pairs.length,
      singletons: unpaired.length,
    },
    byBrand,
    reasons,
  };
  
  const totalDuration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[pairing-v2] ✅ Pipeline complete: ${pairs.length} pairs, ${unpaired.length} unpaired (total: ${totalDuration}s)`);
  
  return {
    pairs,
    unpaired,
    metrics,
  };
}

// ============================================================
// Debug Helper (NOT exported - internal use only)
// ============================================================

async function debugRunPairingOnPaths(imagePaths: string[]): Promise<void> {
  console.log(`[pairing-v2] Debug run on ${imagePaths.length} images`);
  const result = await runNewTwoStagePipeline(imagePaths);
  console.log('[pairing-v2] Pairs:');
  for (const p of result.pairs) {
    console.log(`  ${path.basename(p.front)} ↔ ${path.basename(p.back)}  (conf ${(p.confidence * 100).toFixed(1)}%)`);
  }
  console.log('[pairing-v2] Singletons:', result.metrics.totals.singletons);
}
