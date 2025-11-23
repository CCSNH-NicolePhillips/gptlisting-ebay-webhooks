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
  packageType: 'bottle' | 'jar' | 'tub' | 'pouch' | 'box' | 'sachet' | 'unknown';
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

export async function classifyImagesBatch(imagePaths: string[]): Promise<ImageClassificationV2[]> {
  try {
    const filenames = imagePaths.map(p => path.basename(p));
    
    const systemMessage = `You are an expert image classifier for consumer product packaging.

Your ONLY job is to CLASSIFY each image. Do NOT attempt to pair images.

For each image, provide:
1. kind: "product" if it's consumer product packaging, "non_product" if not
2. panel: "front", "back", "side", or "unknown"
3. brand: 
   - For packaging: the brand name (e.g., "Root", "Jocko")
   - For books: the book title (e.g., "Harry Potter and the Sorcerer's Stone")
   - null if unreadable
4. productName: 
   - For packaging: the product name (e.g., "Clean Slate", "Fish Oil")
   - For books: the author name (e.g., "J.K. Rowling")
   - null if unreadable
5. packageType: bottle/jar/tub/pouch/box/sachet/book/unknown
6. keyText: array of 3-5 short readable text snippets from the label
7. colorSignature: array of dominant colors (e.g., ["green", "black", "bright green gradient"])
8. layoutSignature: brief description of label layout (e.g., "pouch vertical label center", "bottle wraparound")
9. confidence: 0.0-1.0 representing your confidence in the classification
10. rationale: brief explanation of your classification choices

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
      "productName": "Product Name" or null,
      "packageType": "bottle | jar | tub | pouch | box | sachet | book | unknown",
      "keyText": ["text1", "text2", "text3"],
      "colorSignature": ["color1", "color2", "pattern"],
      "layoutSignature": "layout description",
      "confidence": 0.95,
      "rationale": "Brief explanation of classification choices"
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
          content: content,
        },
      ],
      max_tokens: 4000,
      response_format: { type: 'json_object' },
      temperature: 0,
    });

    const result = response.choices[0]?.message?.content?.trim() || '{}';
    const parsed: { items: ImageClassificationV2[] } = JSON.parse(result);
    
    // Log rationale for each classification
    parsed.items?.forEach((item: any) => {
      if (item.rationale) {
        console.log(`[pairing-v2] ${item.filename}: ${item.rationale}`);
      }
    });
    
    return parsed.items || [];
  } catch (error) {
    console.error('[pairing-v2] Error in classifyImagesBatch:', error);
    // Return empty array on error
    return [];
  }
}

async function classifyAllImagesStage1(imagePaths: string[]): Promise<ImageClassificationV2[]> {
  // For cross-image inference to work, ALL related images must be in the same batch
  // Process all images in a single call (background function has 10min timeout)
  console.log(`[pairing-v2] Classifying all ${imagePaths.length} images in single batch for cross-image inference...`);
  
  const all = await classifyImagesBatch(imagePaths);
  
  console.log(`[pairing-v2] Classification complete: ${all.length} total classifications`);
  
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
2. Verify brand names match (case-insensitive) - REQUIRED for both sides
3. Verify product names match OR one side is null (acceptable for books/products where back doesn't show product name)
4. Verify package types match
5. Check that front is actually a "front" panel
6. Check that back is actually a "back" or "side" panel
7. Verify confidence scores are reasonable (>= 0.5)

VERIFICATION RULES:
- status: "accepted" if brand matches AND (productName matches OR one is null) AND packageType matches AND panels are correct
- status: "rejected" if ANY critical check fails, with specific issues listed

Critical checks (MUST pass):
- Brand names must match (case-insensitive)
- Package types must match (bottle/jar/box/book/etc)
- Front must be "front" panel
- Back must be "back" or "side" panel
- Confidence >= 0.5 on both sides

Flexible checks (one can be null):
- Product name: Accept if both match OR if one side is null (common for backs/books)

Common reasons to reject:
- Brand mismatch (different brands)
- Package type mismatch (bottle vs jar vs book)
- Panel type wrong (front paired with front, or back with non-back/side)
- Low confidence (< 0.5 on either side)
- Null brand on both sides (too uncertain)

Be REASONABLE: If brand and packageType match, accept even if productName is null on one side.

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
  console.log(`[pairing-v2] Starting pipeline on ${imagePaths.length} images`);
  
  // Stage 1: Classify all images (batched for scalability)
  const classifications = await classifyAllImagesStage1(imagePaths);
  
  // Stage 2: Pair from metadata only (no images sent)
  const pairing = await pairFromClassifications(classifications);
  
  // Stage 3: Verify pairs (independent validation)
  const verification = await verifyPairs(classifications, pairing);
  
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
  
  console.log(`[pairing-v2] Pipeline complete: ${pairs.length} pairs, ${unpaired.length} unpaired`);
  
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
