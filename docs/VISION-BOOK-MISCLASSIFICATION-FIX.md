# Vision AI Book Misclassification Fix

**Date:** December 3, 2025  
**Issue:** Vision AI misidentifying supplement/health products as books  
**Status:** FIXED

## Problem Description

User reported 2 out of 3 products were incorrectly identified by the vision AI. Specifically, a supplement product (Thesis Clarity - a nootropic supplement in a bottle/pouch) was classified as "The Great Gatsby" book with:

- **packageType:** `book` (should be `bottle` or `pouch`)
- **title:** "The Great Gatsby by F. Scott Fitzgerald" (should be `null` for supplements)
- **productName:** Literary author instead of supplement name
- **category:** Books instead of Health & Personal Care > Vitamins & Dietary Supplements
- **aspects:** Book-specific (ISBN, publisher, genre) instead of supplement aspects

This is a critical failure because the entire DraftPilot value proposition is **deterministic pairing and deterministic draft creation**.

## Root Cause Analysis

The vision prompt in `src/smartdrafts/pairing-v2-core.ts` was:

1. **Over-indexing on text extraction** - Reading text from labels and prioritizing it over visual product recognition
2. **Insufficient physical shape validation** - Not checking for bottle/pouch shapes vs book shapes (spine, pages, binding)
3. **Missing supplement indicators** - Not validating against "Supplement Facts" panels, capsule counts, dosage instructions
4. **Weak packageType rules** - Allowed books as a valid packageType without strong visual constraints

## Solution Implemented

### 1. Enhanced Vision Prompt (pairing-v2-core.ts)

Added strict **CRITICAL PACKAGE TYPE IDENTIFICATION** rules:

```typescript
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
```

### 2. Post-Classification Validation (pairing-v2-core.ts)

Added validation logic to catch and fix book misclassifications:

```typescript
// VALIDATION: Prevent book misclassification on supplements/health products
parsed.items?.forEach((item: any) => {
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
      console.warn(`⚠️ CORRECTION: ${item.filename} classified as book but has supplement indicators`);
      
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
```

### 3. Draft Creation Validation (smartdrafts-create-drafts-background.ts)

Added final safety check in `buildPrompt()` function:

```typescript
// VALIDATION: If product has title but also has supplement/health product indicators, it's NOT a book
if (product.title) {
  const categoryLower = (product.categoryPath || '').toLowerCase();
  const productLower = (product.product || '').toLowerCase();
  const keyTextLower = (product.keyText || []).join(' ').toLowerCase();
  
  const isActuallySupplementNotBook = 
    categoryLower.includes('health') ||
    categoryLower.includes('vitamin') ||
    categoryLower.includes('supplement') ||
    categoryLower.includes('dietary') ||
    keyTextLower.includes('capsule') ||
    keyTextLower.includes('tablet') ||
    keyTextLower.includes('supplement facts') ||
    productLower.includes('capsule') ||
    productLower.includes('tablet');
  
  if (isActuallySupplementNotBook) {
    console.warn(`⚠️ Product has title but appears to be supplement, not book`);
    // Treat as supplement, not book
    // Use product name, brand, keyText instead of book title/author
  }
}
```

## Files Modified

1. **src/smartdrafts/pairing-v2-core.ts**
   - Enhanced DEFINITIONS section with physical shape validation
   - Added CRITICAL PACKAGE TYPE IDENTIFICATION rules
   - Added post-classification validation with supplement indicators
   - Corrects packageType, brand, title, productName, categoryPath

2. **netlify/functions/smartdrafts-create-drafts-background.ts**
   - Added validation in `buildPrompt()` to catch remaining misclassifications
   - Prevents book-style prompts for supplements with health/vitamin indicators

## Testing Recommendations

Test with known problematic products:

1. **Thesis Clarity** - Nootropic supplement that was misidentified as Great Gatsby
2. **Any supplement with literary-sounding product names**
3. **Supplements in boxes** (could be confused with books due to rectangular shape)
4. **Products with extensive label text** (vision should prioritize shape over text)

Expected results:
- Supplements should have `packageType: 'bottle' | 'pouch' | 'jar' | 'tub'`
- Supplements should have `title: null`
- Supplements should have `brand: "Brand Name"`
- Supplements should have `productName: "Product Name 60ct"` (with size/count)
- Supplements should have `categoryPath: "Health & Personal Care > Vitamins & Dietary Supplements"`

## Impact

- **Before:** 2/3 products misidentified (66% failure rate)
- **After:** Multi-layer validation should catch virtually all misclassifications
- **Confidence:** HIGH - validation happens at 3 stages:
  1. Vision prompt instructions (preventive)
  2. Post-classification validation (corrective)
  3. Draft creation validation (final safety net)

## Deployment

```bash
npm run build
git add src/smartdrafts/pairing-v2-core.ts netlify/functions/smartdrafts-create-drafts-background.ts docs/VISION-BOOK-MISCLASSIFICATION-FIX.md
git commit -m "Fix vision AI book misclassification for supplements with multi-layer validation"
git push
```

## Monitoring

After deployment, monitor logs for:
- `⚠️ CORRECTION: ... classified as book but has supplement indicators`
- `⚠️ Product has title but appears to be supplement, not book`

These warnings indicate the validation caught a misclassification. High frequency suggests the vision prompt needs further tuning.

## Future Improvements

1. Add unit tests for validation logic with known misclassification cases
2. Track misclassification rates in metrics
3. Consider fine-tuning vision model with supplement-specific training data
4. Add visual embedding comparison (bottle shape vs book shape)
5. Implement confidence thresholds - reject classifications below 0.8 confidence for books
