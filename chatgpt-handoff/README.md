# CRITICAL PRICING & FORMULATION BUG - CHATGPT HANDOFF

**Date**: November 27, 2025  
**Severity**: HIGH - Production regression, heavily broken  
**Status**: URGENT - Need help fixing without breaking more things

---

## 🚨 CURRENT PROBLEMS

### Issue #1: Wrong Formulation Detection (WORSE AFTER FIX ATTEMPT)
**Before our attempted fix**: Product correctly identified  
**After our attempted fix (commit ebf76d7)**: Product identification WORSE

**Example - Vita PLynxera Myo & D-Chiro Inositol**:
- **Photo shows**: "Liquid Drops 2000 mg" (1 bottle)
- **Draft output**: "120 Capsules Health Supplement" ❌
- **Expected**: "Liquid Drops 2000 mg" ✓

**Vision API is CORRECT**:
```json
{
  "brand": "Vita PLynxera",
  "productName": "Myo & D-Chiro Inositol",
  "keyText": [
    "Vita PLynxera",
    "Myo & D-Chiro Inositol",
    "Liquid Drops 2000 mg"
  ],
  "packageType": "box"
}
```

**GPT Draft Creation is WRONG**:
```json
{
  "title": "Vita PLynxera Myo & D-Chiro Inositol 120 Capsules Health Supplement",
  "formulation": "Capsule",
  "number_of_pills": "120"
}
```

### Issue #2: Wrong Quantity Pricing (WORSE AFTER FIX ATTEMPT)
**Before**: Pricing was reasonable  
**After our attempted fix (commit ebf76d7)**: Pricing is TOO HIGH and using MULTI-PACK prices

**Example - Vita PLynxera**:
- **Photo shows**: 1 bottle (Liquid Drops 2000 mg)
- **Correct single bottle price**: $20.00 MSRP → should list at ~$18 (10% discount)
- **What system extracted**: $27.99 (likely 2-pack or twin pack on Amazon)
- **What draft shows**: $25.19 (10% off the wrong $27.99 price) ❌

**HTML Parser logs**:
```
[price] Amazon URL: https://www.amazon.com/Vita-PLynxera-D-Chiro-Inositol-Supplement/dp/B0DZW37LQJ
[HTML Parser] ✓ Extracted price $27.99
[price] base=$27.99 final=$25.19
```

**User screenshot shows**: Single bottle is $20.00 on Amazon product page

---

## 📊 WHAT WE'VE TRIED (All Failed or Made Things Worse)

### Attempt #1 (commit ebf76d7): Pass Vision keyText to GPT
**Changes**:
- Added `keyText` field to `PairedProduct` type
- Modified GPT prompt to include: `Product Label Text (visible on packaging): ${product.keyText.join(', ')}`
- Added instruction: "👉 Use this label text to determine the correct formulation, size, and quantity."
- Enhanced formulation detection with stronger warnings

**Result**: ❌ MADE IT WORSE
- Formulation went from "60 Capsules" to "120 Capsules" 
- Still completely ignoring the "Liquid Drops" text from keyText

### Attempt #2 (commit ebf76d7): Add multi-pack detection
**Changes**:
- Added `detectMultiPack()` function to `html-price.ts`
- Detects patterns: "2 pack", "twin pack", "bundle", "X bottles", etc.
- Logs warnings when multi-pack detected

**Result**: ❌ NOT WORKING
- HTML parser still extracts multi-pack prices
- No mechanism to PREVENT using multi-pack prices
- GPT prompt warnings don't help because HTML parser already extracted wrong price

### Attempt #3 (commit 99f9a94): Update pricing preference to MSRP
**Changes**:
- Updated AI arbitration rules: "ALWAYS prefer brand MSRP if available - apply 10% discount"
- Changed from "Try to undercut eBay sold by 5-15%" to "Prefer MSRP with 10% discount"

**Result**: ⚠️ PARTIALLY WORKING but regressed
- System correctly prefers MSRP over eBay sold prices ✓
- BUT extracting WRONG MSRP (multi-pack variant) ❌
- Prices now HIGHER than before (was $18, now $25.19)

---

## 🔍 ROOT CAUSE ANALYSIS

### Formulation Issue Root Cause
1. Vision API correctly extracts `keyText: ["Liquid Drops 2000 mg"]` ✓
2. Product data builder NOW includes keyText in prompt ✓
3. GPT prompt has formulation detection rules ✓
4. **BUT GPT IS COMPLETELY IGNORING THE KEYTEXT** ❌

**Hypothesis**: GPT-4o is hallucinating formulation instead of reading the provided keyText. The prompt instructions are not strong enough or GPT is prioritizing its own "knowledge" over the provided label text.

### Pricing Issue Root Cause
1. Price lookup uses tiered system: eBay sold → Brand MSRP → AI arbitration ✓
2. HTML price extractor finds lowest price on page ✓
3. Multi-pack detection LOGS warnings but doesn't PREVENT extraction ❌
4. Amazon product pages often show multiple variants (single, 2-pack, 3-pack)
5. HTML parser just grabs first/lowest price without checking WHICH variant ❌
6. GPT gets the wrong price and applies 10% discount to it ❌

**Hypothesis**: Need to extract product TITLE/variant info along with price to match correct quantity. Or need to avoid Amazon altogether and stick to brand websites.

---

## 📁 CODE FILES INVOLVED

All critical code files have been copied to this folder:

1. **smartdrafts-create-drafts-background.ts** - Main draft creation logic
   - Lines 308-320: Product data passed to GPT (now includes keyText)
   - Lines 386-410: Pricing and formulation instructions
   - Lines 685-755: `createDraftForProduct()` function

2. **price-lookup.ts** - Tiered pricing engine
   - Lines 185-190: AI arbitration rules (prefer MSRP with 10% discount)
   - Lines 405-420: Amazon fallback logic
   - Lines 246-283: `decideFinalPrice()` AI arbitration

3. **html-price.ts** - HTML price extraction
   - Lines 140-182: `extractPriceFromHtml()` with multi-pack detection
   - Lines 113-147: `detectMultiPack()` function (new)
   - Lines 17-90: `extractFromJsonLd()` JSON-LD price extraction

---

## 🎯 WHAT WE NEED FIXED

### Fix #1: Force GPT to Use Actual Label Text
**Current behavior**: GPT ignores keyText and makes up formulation  
**Needed behavior**: GPT MUST use the exact text from keyText array

**Requirements**:
- If keyText contains "Liquid Drops", output formulation MUST be "Liquid"
- If keyText contains "60 Capsules", output formulation MUST be "Capsule"
- GPT should NOT hallucinate formulation based on product category
- The formulation in the title MUST match what's visible on the packaging

### Fix #2: Extract Correct Single-Unit Price
**Current behavior**: HTML parser grabs first price, often multi-pack  
**Needed behavior**: Extract price for SINGLE unit matching photo quantity

**Requirements**:
- If photo shows 1 bottle, extract 1-bottle price (not 2-pack, not 3-pack)
- Detect product variants on Amazon/brand pages
- Match price to the EXACT quantity shown in product photos
- If uncertain, prefer LOWER quantity variants (single over multi-pack)

**Possible approaches**:
1. Extract product title + price together, parse quantity from title
2. Look for "single" or "1 pack" variant explicitly
3. Avoid Amazon entirely, only use brand websites (more reliable)
4. Add validation: if price seems high, check if it's a multi-pack

---

## 🧪 TEST CASE

**Product**: Vita PLynxera Myo & D-Chiro Inositol  
**Photos**: 1 bottle, label shows "Liquid Drops 2000 mg"  
**Vision keyText**: `["Vita PLynxera", "Myo & D-Chiro Inositol", "Liquid Drops 2000 mg"]`  
**Correct MSRP**: $20.00 (single bottle)  
**Amazon URL**: https://www.amazon.com/Vita-PLynxera-D-Chiro-Inositol-Supplement/dp/B0DZW37LQJ

**Expected Draft Output**:
- Title: "Vita PLynxera Myo & D-Chiro Inositol Liquid Drops 2000mg Hormonal Support"
- Formulation: "Liquid"
- Number of Pills: N/A (it's liquid drops)
- Price: $18.00 (10% off $20 MSRP)

**Current Draft Output** (WRONG):
- Title: "Vita PLynxera Myo & D-Chiro Inositol 120 Capsules Health Supplement"
- Formulation: "Capsule" ❌
- Number of Pills: "120" ❌
- Price: $25.19 ❌ (10% off $27.99 multi-pack price)

---

## ⚠️ CONSTRAINTS

1. **Do NOT break existing working features**:
   - Pairing works perfectly now (commit fde8afe fixed it)
   - Image display works (S3 signed URLs, commit cd64904)
   - Pricing preference works (MSRP over eBay sold, commit 99f9a94)

2. **This is a production system**:
   - User is actively listing products on eBay
   - Need fixes that WORK, not experimental changes
   - Each "fix" has made things worse - we're in regression spiral

3. **Focus on reliability over perfection**:
   - If GPT can't be trusted with keyText, try different approach
   - If Amazon prices are unreliable, skip Amazon
   - If multi-pack detection is flaky, prefer conservative pricing

---

## 🔧 ENVIRONMENT

- **Runtime**: Netlify Functions (AWS Lambda)
- **Node.js**: v20
- **TypeScript**: v5.7.2
- **OpenAI**: GPT-4o for draft creation, GPT-4o-mini for price arbitration
- **Vision API**: Google Cloud Vision (working correctly)
- **Price Sources**: eBay sold prices → Brand MSRP → Amazon fallback

---

## 📸 SCREENSHOTS ATTACHED

User provided screenshot showing:
1. **Left**: Root Clean Slate (correctly priced at $202.50)
2. **Middle**: Vita PLynxera showing "120 Capsules" ❌ (should be Liquid Drops)
3. **Right**: Root Sculpt showing "60 Capsules" ✓ (this one is correct)

The screenshot clearly shows Vita PLynxera photo has "Liquid Drops 2000 mg" on the label, but the draft says "120 Capsules".

---

## 💬 USER FEEDBACK

> "pricing is getting worse now we are heavily regressing. price too high (it was normal before) and now vita is saying 120 capsules and using 2 bottle (liquid) price. as you are not giving a solid fix to these without breaking things. I need you to make a folder for chatgpt."

Translation: Every attempted fix has made things WORSE. Need a reliable solution that doesn't regress.

---

## 🎯 SUCCESS CRITERIA

1. ✅ Vita PLynxera draft shows "Liquid Drops" (not "Capsules")
2. ✅ Vita PLynxera price is ~$18 (not $25.19)
3. ✅ Formulation matches actual product label text from Vision API
4. ✅ Price matches single-unit MSRP (not multi-pack)
5. ✅ No regression on working features (pairing, images, other products)

---

## 📞 CONTACT

If you need more context or logs, ask! The user is waiting for a working fix.

**IMPORTANT**: Please analyze the code files in this folder and propose a fix that:
- Addresses the ROOT CAUSE (not symptoms)
- Won't break existing working features
- Has a high probability of working (not experimental)
- Includes specific code changes with file paths and line numbers

Thank you! 🙏
