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
    side1?: string;  // Optional third image (side panel)
    side2?: string;  // Optional fourth image (additional side/angle)
    confidence: number;
    brand?: string | null;
    brandWebsite?: string | null;
    title?: string | null;
    product?: string | null;
    keyText?: string[];
    categoryPath?: string | null;
    photoQuantity?: number; // Max quantityInPhoto across front/back images
  }>;
  unpaired: Array<{
    imagePath: string;
    reason: string;
    needsReview: boolean;
    panel?: string; // 'front' | 'back' | 'side' | 'unknown'
    brand?: string | null;
    product?: string | null;
    title?: string | null;
    brandWebsite?: string | null;
    keyText?: string[];
    categoryPath?: string | null;
    photoQuantity?: number; // quantityInPhoto from vision (for single-image products)
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
  categoryPath: string | null; // Vision API category path (e.g., "Health & Personal Care > Vitamins & Dietary Supplements")
  colorSignature: string[];
  layoutSignature: string;
  confidence: number;
  quantityInPhoto: number; // How many of this product are visible in the photo (1-10)
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
    side1?: string;  // Optional third image
    side2?: string;  // Optional fourth image
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
  side1?: string;  // Optional third image
  side2?: string;  // Optional fourth image
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
   - The brand is the MARKETING/SELLING brand name (the name consumers search for), which may differ from manufacturer names on the label
   - Example: "Gashee" products may show "Dr. U Gro" as manufacturer, but the brand is "Gashee" (use the product line name as the brand)
   - For books: MUST be null (books don't have brands in our system)
   - null if unreadable
4. productName: 
   - For supplements/cosmetics/food packaging: the FULL product name INCLUDING SIZE/UNIT (e.g., "Clean Slate 2oz", "Fish Oil 60 softgels", "Dopamine Brain Food 720g")
   - CRITICAL: Always include the size/unit/count if visible on the label (oz, g, ml, fl oz, capsules, tablets, softgels, etc.)
   - For books: the author name (e.g., "Bobbi Brown", "J.K. Rowling")
   - DO NOT put literary titles or book names here for supplements (e.g., if a supplement is called "Clarity", productName is "Clarity", NOT a book title)
   - null if unreadable
5. title:
   - For books ONLY: the book title (e.g., "Still Bobbi", "Harry Potter and the Sorcerer's Stone")
   - For supplements/cosmetics/food packaging: MUST ALWAYS be null
   - NEVER put supplement product names in the title field
   - If packageType is NOT "book", title MUST be null
   - null if unreadable
6. brandWebsite:
   - Return the official ecommerce URL where this exact product can be purchased (ideally the specific product page with variant parameters if present)
   - If you can see the product name and brand, construct the likely product URL using common patterns:
     * Brand domain + slugified product name: "https://brandname.com/product-name.html"
     * Example: "RKMD Glutathione Rapid Boost" → "https://robkellermd.com/glutathione-rapid-boost.html"
   - Prefer the storefront domain actually used for checkout, even if it's different from the marketing site.
     * Example: "bettr. Morning Strawberry Mango" tubs are sold at https://performbettr.com/products/morning-strawberry-mango.html — return that performbettr.com URL (not bettr.com)
     * Example: "BetterAlt TESTO PRO" is sold at https://thebetteralt.com/pages/boost-testosterone-naturally-with-testo-pro — return that thebetteralt.com URL (not betteralt.com)
     * Example: "Gashee Natural Botanical Hair Serum" (brand: Gashee, may show "Dr. U Gro" on label) is sold at https://gashee.com/products/gashee-botanical-hair-serum-rapunzel — return that gashee.com URL
   - If a specific product URL is visible on packaging (QR code, printed URL), use that exact URL INCLUDING query/variant parameters (do not truncate ?variant=...)
   - If you cannot confidently construct a product URL, return just the domain: "https://domainname.com"
   - Common URL patterns: lowercase, hyphens for spaces, .html extension (but also try without), /pages/ or /products/ paths
   - null if brand is unknown or you cannot confidently infer any URL
7. packageType: bottle/jar/tub/pouch/box/sachet/book/unknown
8. keyText: array of 3-5 short readable text snippets from the label
9. categoryPath: hierarchical product category (e.g., "Health & Personal Care > Vitamins & Dietary Supplements", "Beauty > Skin Care > Face Moisturizers")
   - Infer from the product type, claims, and visible text
   - For supplements: "Health & Personal Care > Vitamins & Dietary Supplements"
   - For cosmetics: "Beauty > [specific category]"
   - For books: "Books > [genre/topic]"
   - null if cannot determine
10. colorSignature: array of dominant colors (e.g., ["green", "black", "bright green gradient"])
11. layoutSignature: brief description of label layout (e.g., "pouch vertical label center", "bottle wraparound")
12. confidence: 0.0-1.0 representing your confidence in the classification
13. rationale: brief explanation of your classification choices
14. quantityInPhoto: How many of this specific product are visible in the photo (1-10)
   - Count distinct bottles/jars/boxes of the SAME product
   - If you see 2 identical bottles side-by-side → quantityInPhoto: 2
   - If you see 1 bottle (even if photo shows front + back in separate images) → quantityInPhoto: 1
   - DO NOT confuse with label text like "60 capsules", "90 count", or "2-pack" printed on packaging
   - This is about PHYSICAL items visible in THIS SPECIFIC PHOTO, not what's written on the label
   - If the photo shows front panel of a bottle → that's 1 bottle
   - If the photo shows back panel of a bottle → that's still 1 bottle (same bottle, different angle)
   - Only count as 2+ if you see multiple DISTINCT physical products in the same photo
   - Range: 1-10 (if more than 10, use 10)

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

CRITICAL PACKAGE TYPE IDENTIFICATION:
You MUST use visual cues to determine packageType FIRST, before reading text:

1. PHYSICAL SHAPE DETERMINES PACKAGE TYPE:
   - Bottle = cylindrical container with cap/lid (vitamins, supplements, lotions)
   - Pouch = flexible bag/packet (powders, supplements, snacks)
   - Box = rectangular rigid container
   - Book = rectangular flat object with spine, pages visible on edge
   
2. DO NOT classify as "book" unless:
   - You can see a SPINE with binding
   - You can see PAGE EDGES (not just printed cardstock)
   - The object is FLAT and RECTANGULAR like a book
   - It has typical book features: ISBN on back, publisher info, copyright page
   
3. SUPPLEMENTS/HEALTH PRODUCTS are NEVER books even if they have:
   - Product names that sound literary
   - Taglines or marketing copy
   - Printed cardstock boxes
   - Barcodes (books have ISBN, supplements have UPC)
   
4. VISUAL INDICATORS FOR SUPPLEMENTS:
   - Bottle shapes (cylindrical, oval, rectangular bottles)
   - Pouch shapes (flexible bags with resealable tops)
   - "Supplement Facts" panel on back (NOT "Nutrition Facts")
   - Dosage instructions ("Take 2 capsules daily")
   - Health claims ("Supports cognitive function", "Promotes clarity")
   - Capsule/tablet count ("60 capsules", "30 servings")

If you see a BOTTLE, POUCH, or JAR shape → packageType CANNOT be "book"
If you see "Supplement Facts" label → packageType CANNOT be "book"
If you see capsule/tablet count → packageType CANNOT be "book"

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
      "categoryPath": "Category > Subcategory" or null,
      "colorSignature": ["color1", "color2", "pattern"],
      "layoutSignature": "layout description",
      "confidence": 0.95,
      "rationale": "Brief explanation of classification choices",
      "quantityInPhoto": 1
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
    
    // CHUNK 1: Default quantityInPhoto to 1 if missing from model output
    parsed.items?.forEach((item: any) => {
      if (typeof item.quantityInPhoto !== 'number' || item.quantityInPhoto < 1) {
        item.quantityInPhoto = 1;
      }
    });
    
    // HOTFIX: GPT-4o sometimes ignores the title field for books
    // If packageType is book and title is missing, copy productName to title
    parsed.items?.forEach((item: any) => {
      if (item.packageType === 'book' && !item.title && item.productName) {
        console.log(`[pairing-v2] HOTFIX: Moving productName "${item.productName}" to title for book ${item.filename}`);
        item.title = item.productName;
        // Keep productName as author name (it's usually correct)
      }
    });
    
    // VALIDATION: Prevent book misclassification on supplements/health products
    parsed.items?.forEach((item: any) => {
      // If classified as book but has supplement indicators, correct it
      if (item.packageType === 'book') {
        const keyTextLower = (item.keyText || []).join(' ').toLowerCase();
        const categoryLower = (item.categoryPath || '').toLowerCase();
        const productNameLower = (item.productName || '').toLowerCase();
        
        const supplementIndicators = [
          'supplement facts',
          'capsules',
          'tablets',
          'softgels',
          'servings',
          'dietary supplement',
          'health & personal care',
          'vitamins',
          'supports',
          'promotes',
          'cognitive',
          'brain',
          'clarity',
          'focus',
          'energy',
          'wellness'
        ];
        
        const hasSupplementIndicators = supplementIndicators.some(indicator => 
          keyTextLower.includes(indicator) || 
          categoryLower.includes(indicator) ||
          productNameLower.includes(indicator)
        );
        
        if (hasSupplementIndicators) {
          console.warn(`[pairing-v2] ⚠️ CORRECTION: ${item.filename} classified as book but has supplement indicators`);
          console.warn(`[pairing-v2] KeyText: ${item.keyText?.join(', ')}`);
          console.warn(`[pairing-v2] Category: ${item.categoryPath}`);
          console.warn(`[pairing-v2] Correcting packageType from 'book' to 'bottle'`);
          
          // Move title to productName (it's the product name, not a book title)
          if (item.title && !item.productName) {
            item.productName = item.title;
          }
          
          // Clear title (supplements don't have titles)
          item.title = null;
          
          // Correct packageType - default to bottle for supplements
          item.packageType = 'bottle';
          
          // Set brand if it was null (books have null brand)
          if (!item.brand && item.productName) {
            // Try to extract brand from productName or keyText
            const firstKeyText = item.keyText?.[0];
            if (firstKeyText && firstKeyText.length < 30) {
              item.brand = firstKeyText;
            }
          }
          
          // Fix categoryPath
          if (categoryLower.includes('book')) {
            item.categoryPath = 'Health & Personal Care > Vitamins & Dietary Supplements';
          }
        }
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
  // Split into smaller batches to avoid hitting Vision API output token limits
  // Large batches (>12 images) can cause truncated JSON responses
  const totalImages = imagePaths.length;
  
  if (totalImages <= CLASSIFY_BATCH_SIZE) {
    console.log(`[pairing-v2] Classifying all ${totalImages} images in single batch...`);
    const batchStart = Date.now();
    const all = await classifyImagesBatch(imagePaths);
    const batchDuration = ((Date.now() - batchStart) / 1000).toFixed(1);
    console.log(`[pairing-v2] Classification complete: ${all.length} total classifications (${batchDuration}s, ${(imagePaths.length / parseFloat(batchDuration)).toFixed(1)} img/s)`);
    return all;
  }
  
  // Process in batches to prevent token limit truncation
  console.log(`[pairing-v2] Classifying ${totalImages} images in batches of ${CLASSIFY_BATCH_SIZE}...`);
  const allClassifications: ImageClassificationV2[] = [];
  const overallStart = Date.now();
  
  for (let i = 0; i < imagePaths.length; i += CLASSIFY_BATCH_SIZE) {
    const batch = imagePaths.slice(i, i + CLASSIFY_BATCH_SIZE);
    const batchNum = Math.floor(i / CLASSIFY_BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(imagePaths.length / CLASSIFY_BATCH_SIZE);
    
    console.log(`[pairing-v2] Processing batch ${batchNum}/${totalBatches} (${batch.length} images)...`);
    const batchStart = Date.now();
    const results = await classifyImagesBatch(batch);
    const batchDuration = ((Date.now() - batchStart) / 1000).toFixed(1);
    console.log(`[pairing-v2] Batch ${batchNum}/${totalBatches} complete: ${results.length} classifications (${batchDuration}s)`);
    
    allClassifications.push(...results);
  }
  
  const overallDuration = ((Date.now() - overallStart) / 1000).toFixed(1);
  console.log(`[pairing-v2] Classification complete: ${allClassifications.length} total classifications (${overallDuration}s, ${(totalImages / parseFloat(overallDuration)).toFixed(1)} img/s)`);
  
  return allClassifications;
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

PAIRING RULES (BE AGGRESSIVE - PAIR MORE, REJECT LESS):
1. CONFLICTING identity: NEVER pair if brands are DIFFERENT non-null values (e.g., "Nike" vs "Adidas")
   For books: NEVER pair if titles are DIFFERENT non-null values
2. STRICT MATCH: If BOTH images have productName with actual values, they MUST match
3. SOFT MATCH (PREFERRED): If productName OR brand is null/missing on ONE or BOTH sides:
   - Same or similar packageType (bottle/jar are similar, pouch/sachet are similar)
   - Overlapping colorSignature (at least 1 color in common)
   - Similar layoutSignature patterns
   Then PAIR THEM - they're very likely the same product (backs often have no brand/product visible)
4. Package types: Accept if exact match OR similar types (bottle≈jar, pouch≈sachet, box≈unknown)
5. Confidence: Accept if >= 0.4 (lowered to be more lenient - classification isn't perfect)
6. NEVER pair "non_product" items with anything
7. Unknown panels: CAN be paired if visual signatures match (don't auto-reject unknowns)
8. VALID PANEL COMBINATIONS (all acceptable):
   a) "front" + "back" (ideal case)
   b) "front" + "side" (ALWAYS valid - side panels show additional info)
   c) "side" + "back" (valid)
   d) "side" + "side" (valid if different information)
   e) "front" + "unknown" (valid if visual match)
   f) "unknown" + "back" (valid if visual match)
9. CRITICAL: Prioritize visual matching (colors, layout, package type) over text matching
   - Many backs have NO visible brand/product text
   - Visual signatures are MORE reliable than text for matching
10. When in doubt, PAIR IT - verification stage will catch serious mistakes
11. Goal: Maximize pairing rate - unpaired images require manual work

OUTPUT FORMAT:
Respond ONLY with valid JSON:

{
  "pairs": [
    {
      "front": "filename.jpg",
      "back": "filename.jpg",
      "side1": "filename.jpg",
      "side2": "filename.jpg",
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

GROUPING RULES (up to 4 images per product):
- Every group MUST have a "front" image (required - the hero/main image)
- "back" is optional but highly recommended for products with ingredient lists
- "side1" is optional - attach side panels that match the same product
- "side2" is optional - attach additional side/angle images that match
- IMPORTANT: Only attach side images if they clearly belong to the same product (same brand, colors, package type)
- When a side image matches multiple products, leave it unpaired rather than guessing
- Prioritize front+back pairing first, then attach matching sides

For unpaired items, set needsReview: true if:
- It's a clear product (kind=product, panel=front or back) but has no match
- Confidence is moderate (0.5-0.7) and might need human review
- Brand/product names are null but it looks like a valid product

EXAMPLES:
✅ PAIR: Front shows "Root Clean Slate" bottle, back shows supplement facts with no brand → Same colors, same bottle shape → PAIR
✅ PAIR: Front shows orange "Jocko" box, back shows ingredients on orange box → Same package type and colors → PAIR  
✅ PAIR: Both images show blue bottles with similar label → Brand visible on one, not on other → PAIR based on visual match
✅ PAIR: productName="Fish Oil 60ct" on front, productName=null on back, same bottle → PAIR (backs often have no product name)
✅ PAIR: Book with title="Harry Potter" on both sides, brand=null on both → PAIR (books don't have brands)
❌ REJECT: Front has brand="Nike", back has brand="Adidas" → CONFLICTING brands → DON'T PAIR
❌ REJECT: Front shows red box, back shows blue bottle → Different package types and colors → DON'T PAIR
❌ REJECT: productName="Vitamin C" on front, productName="Fish Oil" on back → CONFLICTING products → DON'T PAIR

Pairing strategy:
- PRIORITIZE visual matching (colors + layout + package) when text is missing
- ACCEPT null/missing brand or product on back panels (VERY common)
- Be AGGRESSIVE about pairing - aim for 80%+ pair rate
- Only reject when there's clear evidence of a mismatch`;

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
    
    console.log('[pairing-v2] Pass 1 (strict) results:', JSON.stringify(parsed, null, 2));
    
    // PASS 2: Lenient visual matching for leftovers
    // If we still have unpaired items, try aggressive visual matching
    if (parsed.unpaired.length > 0) {
      console.log(`[pairing-v2] Running Pass 2 (lenient visual matching) on ${parsed.unpaired.length} unpaired items...`);
      
      const unpairedItems = items.filter(item => 
        parsed.unpaired.some(u => u.filename === item.filename)
      );
      
      if (unpairedItems.length >= 2) {
        const pass2Result = await pairVisuallyAggressive(unpairedItems);
        
        // Merge pass 2 results into pass 1
        parsed.pairs.push(...pass2Result.pairs);
        parsed.unpaired = pass2Result.unpaired;
        
        console.log(`[pairing-v2] Pass 2 created ${pass2Result.pairs.length} additional pairs`);
      }
    }
    
    console.log('[pairing-v2] Final pairing results:', JSON.stringify(parsed, null, 2));
    
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

// Pass 2: Aggressive visual matching for items that didn't pair in Pass 1
async function pairVisuallyAggressive(items: ImageClassificationV2[]): Promise<PairingOutput> {
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
    
    const systemMessage = `You are doing AGGRESSIVE VISUAL MATCHING for product images that failed strict pairing.

These items didn't pair because text info (brand/product) is missing or unclear.
Your job: Pair them PURELY by VISUAL SIMILARITY - ignore missing text.

CRITICAL RULES:
1. Same bottle/jar/box shape + same colors = PAIR (even if brand/product are null)
2. If you see TWO images that look like the SAME physical product, PAIR THEM
3. Focus on: packageType match, color overlap, similar layout
4. Ignore missing brand/productName - back panels often have NO readable text
5. Only reject if colors/package are CLEARLY different

Example: 
- Teal bottle front + teal bottle back with supplement facts = PAIR (same bottle, same color)
- Orange box + orange box = PAIR (same package, same color)

OUTPUT FORMAT (same as before):
{
  "pairs": [
    {
      "front": "filename.jpg",
      "back": "filename.jpg", 
      "reasoning": "Same teal bottle, same supplement facts layout - visual match",
      "confidence": 0.85
    }
  ],
  "unpaired": [
    {
      "filename": "filename.jpg",
      "reason": "No visual match found",
      "needsReview": true
    }
  ]
}`;

    const userMessage = `Pair these leftover images using VISUAL MATCHING ONLY.
Return your response as valid JSON matching the OUTPUT FORMAT.

${JSON.stringify(payload, null, 2)}`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemMessage },
        { role: 'user', content: userMessage },
      ],
      max_tokens: 2000,
      response_format: { type: 'json_object' },
      temperature: 0,
    });

    const result = response.choices[0]?.message?.content?.trim() || '{}';
    return JSON.parse(result);
    
  } catch (error) {
    console.error('[pairing-v2] Error in pairVisuallyAggressive:', error);
    return {
      pairs: [],
      unpaired: items.map(item => ({
        filename: item.filename,
        reason: 'Visual matching failed',
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
      const side1Class = pair.side1 ? classMap.get(pair.side1) : null;
      const side2Class = pair.side2 ? classMap.get(pair.side2) : null;
      
      return {
        pair: {
          front: pair.front,
          back: pair.back,
          side1: pair.side1,
          side2: pair.side2,
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
        side1Metadata: side1Class ? {
          panel: side1Class.panel,
          brand: side1Class.brand,
          productName: side1Class.productName,
          title: side1Class.title,
          packageType: side1Class.packageType,
          confidence: side1Class.confidence,
        } : null,
        side2Metadata: side2Class ? {
          panel: side2Class.panel,
          brand: side2Class.brand,
          productName: side2Class.productName,
          title: side2Class.title,
          packageType: side2Class.packageType,
          confidence: side2Class.confidence,
        } : null,
      };
    });
    
    console.log('[pairing-v2] 🔍 Verifying', pairing.pairs.length, 'pairs');
    
    // Log each pair being verified with key details
    payload.forEach((p, idx) => {
      const sideInfo = [p.pair.side1, p.pair.side2].filter(Boolean).join(', ');
      console.log(`[pairing-v2] Pair ${idx + 1}: ${p.pair.front} + ${p.pair.back}${sideInfo ? ` + [${sideInfo}]` : ''}`);
      console.log(`  Front: panel=${p.frontMetadata?.panel}, brand="${p.frontMetadata?.brand}", product="${p.frontMetadata?.productName}", pkg=${p.frontMetadata?.packageType}`);
      console.log(`  Back:  panel=${p.backMetadata?.panel}, brand="${p.backMetadata?.brand}", product="${p.backMetadata?.productName}", pkg=${p.backMetadata?.packageType}`);
      if (p.side1Metadata) console.log(`  Side1: panel=${p.side1Metadata.panel}, brand="${p.side1Metadata.brand}", product="${p.side1Metadata.productName}"`);
      if (p.side2Metadata) console.log(`  Side2: panel=${p.side2Metadata.panel}, brand="${p.side2Metadata.brand}", product="${p.side2Metadata.productName}"`);
      console.log(`  Reasoning: ${p.pair.reasoning}`);
    });
    
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
  * EITHER brand matches (for products) OR title matches (for books) OR productName matches (when brand is missing on one side)
  * AND packageType matches
  * AND panels are correct (front with back/side/other)
  * AND (productName matches OR one is null)
- status: "rejected" if ANY critical check fails, with specific issues listed

CRITICAL VERIFICATION PHILOSOPHY:
Be LENIENT and TRUST the pairing stage. Only reject pairs with OBVIOUS problems.
The pairing stage already did the hard work - verification is just a sanity check.

Critical checks (MUST pass):
- Identity match (VERY FLEXIBLE - accept if ANY of these is true):
  * For books (packageType == 'book'): Accept if title matches on EITHER side OR both sides
  * For products (packageType != 'book'): Accept if ANY of:
    - brand matches (case-insensitive) on both sides
    - brand matches on ONE side and other side is null/empty (COMMON for backs)
    - productName matches (case-insensitive) on both sides
    - productName matches on ONE side and other side is null/empty (COMMON for backs)
  * IMPORTANT: Many back panels ONLY show supplement facts - they have NO brand/product visible
  * ONLY reject if there's a CLEAR MISMATCH (e.g., brand="Nike" on one, brand="Adidas" on other)
  * NEVER reject just because back panel has null brand/product - that's NORMAL
- Package types: Accept if they match OR if one is 'unknown' OR if similar (bottle/jar are similar, pouch/sachet are similar)
- Panel types: Accept as long as it's not both front or both back
- Confidence: Accept if >= 0.4 on both sides (lowered from 0.5 to be more lenient)

Flexible checks (one can be null - THIS IS NORMAL):
- Product name: Accept if both match OR if one side is null (VERY common for backs)
- Brand: Accept if both match OR if one side is null/empty (VERY common for backs)
- Package type: Accept if match OR if one is 'unknown' OR if similar types

ONLY reject for these SERIOUS issues:
- CONFLICTING identity: brand="Nike" on one side, brand="Adidas" on other (different non-null values)
- CONFLICTING product: productName="Vitamin C" on one, productName="Fish Oil" on other (different non-null values)
- COMPLETELY UNKNOWN: ALL of brand, productName, and title are null on BOTH sides
- VERY low confidence: < 0.4 on either side
- Panel logic error: both are front, both are back, or other impossible combination

DO NOT REJECT FOR:
- Null/missing brand on back panel (NORMAL - backs often only show ingredients)
- Null/missing productName on back panel (NORMAL)
- Package type slightly different (bottle vs jar) - visual classification is imperfect
- One side has data, other is null (EXPECTED for backs)

EXAMPLES:
- Book with packageType='book', brand=null, title='Harry Potter' on both sides: ACCEPT (title matches)
- Product with packageType='bottle', brand='Jocko', title=null on both sides: ACCEPT (brand matches)
- Product with packageType='box', brand='Prequel' on front, brand='' on back, productName='Vitamin C Serum' on both: ACCEPT (productName matches, brand missing on back is OK)
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
    
    // Log verification results
    const accepted = parsed.verifiedPairs.filter(p => p.status === 'accepted');
    const rejected = parsed.verifiedPairs.filter(p => p.status === 'rejected');
    
    console.log(`[pairing-v2] ✅ Verification complete: ${accepted.length} accepted, ${rejected.length} rejected`);
    
    if (rejected.length > 0) {
      console.log('[pairing-v2] ❌ Rejected pairs:');
      rejected.forEach(p => {
        console.log(`  ${p.front} + ${p.back}: ${p.issues?.join(', ')}`);
      });
    }
    
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
    const backClass = classMap.get(p.back);
    const side1Class = p.side1 ? classMap.get(p.side1) : null;
    const side2Class = p.side2 ? classMap.get(p.side2) : null;
    
    // CHUNK 3: Calculate photoQuantity as max across all images in the group
    // Reason: some angles hide duplicates; max is safer than min
    const frontQty = frontClass?.quantityInPhoto || 1;
    const backQty = backClass?.quantityInPhoto || 1;
    const side1Qty = side1Class?.quantityInPhoto || 1;
    const side2Qty = side2Class?.quantityInPhoto || 1;
    const photoQuantity = Math.max(frontQty, backQty, side1Qty, side2Qty);
    
    console.log(`[pairing-v2] photoQuantity calculation: front=${frontQty}, back=${backQty}, side1=${side1Qty}, side2=${side2Qty}, max=${photoQuantity} (brand: ${frontClass?.brand})`);
    
    return {
      front: p.front,
      back: p.back,
      side1: p.side1,
      side2: p.side2,
      confidence: p.confidence,
      brand: frontClass?.brand || null,
      brandWebsite: frontClass?.brandWebsite || null,
      title: frontClass?.title || null,
      product: frontClass?.productName || null,
      keyText: frontClass?.keyText || [],
      categoryPath: frontClass?.categoryPath || null,
      photoQuantity,
    };
  });
  
  // Build unpaired list from pairing output + rejected pairs
  const pairedFilenames = new Set<string>();
  pairs.forEach(p => {
    pairedFilenames.add(p.front);
    pairedFilenames.add(p.back);
    if (p.side1) pairedFilenames.add(p.side1);
    if (p.side2) pairedFilenames.add(p.side2);
  });
  
  const unpaired = [
    ...pairing.unpaired.map(u => {
      const classification = classMap.get(u.filename);
      return {
        imagePath: u.filename,
        reason: u.reason,
        needsReview: u.needsReview,
        panel: classification?.panel || 'unknown',
        brand: classification?.brand || null,
        product: classification?.productName || null,
        title: classification?.title || null,
        brandWebsite: classification?.brandWebsite || null,
        keyText: classification?.keyText || [],
        categoryPath: classification?.categoryPath || null,
        photoQuantity: classification?.quantityInPhoto || 1, // CHUNK 3: Single image products
      };
    }),
    ...rejectedPairs.flatMap(p => {
      const frontClass = classMap.get(p.front);
      const backClass = classMap.get(p.back);
      return [
        {
          imagePath: p.front,
          reason: `Pair rejected: ${p.issues?.join(', ') || 'verification failed'}`,
          needsReview: true,
          panel: frontClass?.panel || 'unknown',
          brand: frontClass?.brand || null,
          product: frontClass?.productName || null,
          title: frontClass?.title || null,
          brandWebsite: frontClass?.brandWebsite || null,
          keyText: frontClass?.keyText || [],
          categoryPath: frontClass?.categoryPath || null,
          photoQuantity: frontClass?.quantityInPhoto || 1, // CHUNK 3
        },
        {
          imagePath: p.back,
          reason: `Pair rejected: ${p.issues?.join(', ') || 'verification failed'}`,
          needsReview: true,
          panel: backClass?.panel || 'unknown',
          brand: backClass?.brand || null,
          product: backClass?.productName || null,
          title: backClass?.title || null,
          brandWebsite: backClass?.brandWebsite || null,
          keyText: backClass?.keyText || [],
          categoryPath: backClass?.categoryPath || null,
          photoQuantity: backClass?.quantityInPhoto || 1, // CHUNK 3
        },
      ];
    }),
  ];
  
  // Calculate metrics
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
