# SmartDrafts Brand Detection Issue - Full Context for ChatGPT

**Date:** November 16, 2025  
**System:** SmartDrafts Image Pairing System  
**Issue:** Vision API misidentifying brands on supplement back panels

---

## 1. WHAT WE'RE TRYING TO ACCOMPLISH

### Overall Goal
Analyze 26 product photos (13 front + 13 back pairs) and correctly pair them together based on:
- Brand matching
- Product name matching  
- Visual similarity
- Packaging characteristics

### Specific Brand Detection Goals
- **FRONT panels:** Extract brand from logo/hero text → ✅ **Working correctly**
- **BACK panels:** Extract brand from "Manufactured by" / "Distributed by" text → ❌ **FAILING**

### Expected Results for Problem Cases

| Image | Panel | Expected Brand | Getting Instead | Status |
|-------|-------|----------------|-----------------|--------|
| 143143.jpg | Back | RKMD | Stevia | ❌ WRONG |
| 143638.jpg | Back | Prequel | (empty) | ❌ WRONG |
| 143138.jpg | Front | RKMD | RKMD | ✅ OK |
| 143629.jpg | Front | Prequel | Prequel | ✅ OK |

**The Problem:** Vision API sees "Stevia" in the ingredient list on RKMD's back panel and incorrectly uses it as the brand name instead of looking for "Manufactured by RKMD" text.

---

## 2. CURRENT PROCESS (Two-Phase System)

### Phase 1: Individual Vision Analysis
```
For each of 26 images:
  1. Send ONE image to OpenAI GPT-4o Vision with prompt (see below)
  2. ChatGPT returns JSON with: brand, product, role (front/back), etc.
  3. Save to Redis individually
  
Each image analyzed independently - no knowledge of other images
```

### Phase 2: Deterministic Pairing Algorithm  
```
1. Load all 26 vision results from Redis
2. Normalize brands: "Root Wellness" → "root", "Jocko Fuel" → "jocko"
3. Separate fronts (13) from backs (12) + others (1)
4. Score every front-back combination (13 × 12 = 156 combinations)
5. Accept pairs with high score + large gap from second-best
6. Result: 8 pairs accepted, 5 fronts became singletons
```

**Why Only 8/13 Pairs Created:**
- RKMD: Back shows "Stevia" brand → doesn't match front's "RKMD" → rejected
- Prequel: Back has empty brand → can't match front's "Prequel" → rejected  
- Root variants: Multiple backs look similar → gap too small → rejected for safety
- Jocko variants: Same issue → some rejected due to low gap

---

## 3. THE EXACT PROMPT WE'RE SENDING TO CHATGPT VISION

### Complete Vision Analysis Prompt

```
You are a product photo analyst. Analyze EACH image INDIVIDUALLY.

Step 1 — ROLE CLASSIFICATION (Front/Back/Side/Other):
• Compute a backness roleScore ∈ [−1, +1] using these rules:
  BACK +0.35 each: 'Nutrition Facts', 'Supplement Facts', 'Drug Facts', '% Daily Value', 'Serving Size', 'Other Ingredients', 'Inactive Ingredients', 'Directions', 'Warnings', 'Caution', 'Distributed by', 'Manufactured for', 'Lot', 'LOT', 'Batch', 'EXP', 'Expiration', 'Barcode', 'UPC', 'EAN', 'QR code', 'Scan for more'.
  BACK +0.2 each: FDA-style facts table (monochrome box with rows/columns), dense paragraphs in small font, barcode block at bottom/right, multi-language fine print clusters, recycling icons with fine print.
  FRONT −0.35 each: large centered brand logo, large product name as hero text, large flavor/variant text, lifestyle/food imagery, bold marketing badges ('Keto', 'Non-GMO', 'Organic', 'Gluten Free', 'NEW!', 'Vegan').
  FRONT −0.2 each: short punchy marketing lines, diagonal ribbons, foil stamps, hero cluster (logo+name+variant) with Net Wt/fl oz.
• Special case: narrow vertical panel with nutrition or barcode → role='side'.
• Map score to role:
  score ≥ +0.35 → 'back'
  score ≤ −0.35 → 'front'
  +0.2 ≤ score < +0.35 → 'back' (lower confidence)
  −0.35 < score ≤ −0.2 → 'front' (lower confidence)
  |score| < 0.2 → 'other' (low confidence)

Step 2 — TEXT & VISUAL EVIDENCE:
• Extract ALL legible text (preserve case, line breaks).
• List evidenceTriggers: exact words/visual cues that affected roleScore (e.g., 'Supplement Facts' header, barcode block near bottom-right, large hero logo).

Step 3 — PRODUCT FIELDS:
• Extract: brand, product, variant/flavor, size/servings, best-fit category, categoryPath (parent > child), options { Flavor, Formulation, Features, Ingredients, Dietary Feature }, claims[].
• BRAND DETECTION RULES (CRITICAL):
  - For FRONT panels: Extract the main brand/company name from logo or hero text (e.g., 'Jocko Fuel', 'RYSE', 'RKMD', 'Root Brands', 'Naked Nutrition')
  - For BACK panels: Look for brand in 'Manufactured by', 'Distributed by', 'Made by', or company address. DO NOT use ingredient names (like 'Stevia', 'VitaCholine', 'Biotin') as the brand.
  - If back panel has no 'Manufactured by' text, look for brand logo/name if visible, otherwise leave brand empty ('')
  - Brand name variations are OK (e.g., 'Jocko Fuel' and 'Jocko' are the same brand)
• Non-product images (purses, furniture, random objects): brand='Unknown', product='Unidentified Item'.
• If name unclear, set confidence ≤ 0.5.

Step 4 — COLOR & VISUAL DESCRIPTION (REQUIRED):
• hasVisibleText (true/false) — REQUIRED
• dominantColor (specific shade like 'dark-forest-green', 'burgundy', 'tan', 'white', 'blue', 'black', 'amber') — REQUIRED
• visualDescription — REQUIRED, MUST BE A NON-EMPTY STRING FOR EVERY IMAGE
  YOU MUST DESCRIBE THE PHYSICAL PACKAGING IN DETAIL. DO NOT OMIT THIS FIELD.
  Include ALL of these details in a single paragraph:
  - Packaging type: bottle/jar/pouch/tube/canister/dropper-bottle/pump-bottle/spray-bottle/tin/box/blister-pack
  - Container shape: cylindrical/rectangular/oval/square/irregular/flat-pouch/stand-up-pouch
  - Container size impression: small/medium/large/travel-size/family-size
  - Material/finish: plastic-glossy/plastic-matte/glass-clear/glass-frosted/metallic/foil/paper/cardboard
  - Primary color(s): be very specific (e.g., 'deep purple', 'lime green', 'rose gold', 'transparent with white cap')
  - Cap/closure type: screw-cap/flip-top/pump/dropper/spray-nozzle/tear-off/zip/resealable/twist-off
  - Label coverage: full-wrap/front-panel-only/minimal/front-and-back/spot-labels
  - Special features: transparent-window/embossed-logo/holographic-seal/tear-notch/hang-hole/tamper-evident-band
  Example: 'Small cylindrical dropper-bottle, glass-clear material with white dropper cap, deep amber liquid visible inside, full-wrap white label with green accents, tamper-evident band around neck'
  CRITICAL: This field is MANDATORY. If you cannot see packaging details, describe what you CAN see (colors, shapes, text layout).

EXTRA CONTEXT PER IMAGE (filenames, parent folders):
(no hints)

STRICT JSON OUTPUT:
{
  "groups": [{
    "groupId": "...",
    "brand": "...",
    "product": "...",
    "variant": "...",
    "size": "...",
    "category": "...",
    "categoryPath": "...",
    "options": { "Flavor": "...", ... },
    "claims": ["..."],
    "confidence": 0.0-1.0
  }],
  "insights": [{
    "url": "...",
    "groupId": "...",
    "role": "front|back|side|other",
    "roleScore": -1.0 to +1.0,
    "evidenceTriggers": ["...", "..."],
    "hasVisibleText": true|false,
    "dominantColor": "...",
    "visualDescription": "REQUIRED NON-EMPTY STRING",
    "textExtracted": "..."
  }]
}

REQUIREMENTS:
• Every image MUST have a visualDescription - NO EXCEPTIONS
• Use exact category taxonomy when possible
• For unclear brand/product, set confidence ≤ 0.5
• Extract all visible text verbatim
• Map roleScore precisely to role classification
```

---

## 4. WHAT'S ACTUALLY HAPPENING (Actual Results)

### Correct Brand Detections (Fronts - ✅ Working)
```
143138.jpg (front) → brand: "RKMD" ✅
143629.jpg (front) → brand: "Prequel" ✅
143552.jpg (front) → brand: "RYSE" ✅
142814.jpg (front) → brand: "Root" ✅
143304.jpg (front) → brand: "Jocko Fuel" ✅
```

### FAILED Brand Detections (Backs - ❌ Problem)

**Case 1: RKMD Greens Powder**
- Front (143138.jpg): brand = "RKMD" ✅
- Back (143143.jpg): brand = "Stevia" ❌ **WRONG!**
- **What happened:** Vision saw "Stevia" in the ingredient list and used it as the brand
- **What it should do:** Look for "Manufactured by" text showing "RKMD"

**Case 2: Prequel Skin Serum**  
- Front (143629.jpg): brand = "Prequel" ✅
- Back (143638.jpg): brand = "" (empty) ❌ **WRONG!**
- Back (143638.jpg): role = "other" ❌ **Should be "back"**
- **What happened:** Vision couldn't find brand and misclassified the role entirely

**Case 3: Root Brand Supplements (Multiple products)**
- Fronts: brand = "Root" or "Root Wellness" (inconsistent but OK)
- Backs: brand = "Root Wellness" (correct but variant causes issues)
- **What happened:** Brand name variations prevent pairing due to low confidence gap

---

## 5. WHY THE CURRENT PROMPT ISN'T WORKING

### Issue 1: Weak Ingredient Exclusion
Current prompt says:
> "DO NOT use ingredient names (like 'Stevia', 'VitaCholine', 'Biotin') as the brand."

**Problems:**
- Only 3 examples given
- No validation step to verify brand isn't in ingredients
- ChatGPT still uses "Stevia" despite this instruction
- Doesn't emphasize **Supplement Facts = Ingredients, NOT brands**

### Issue 2: No Fallback Guidance
Current prompt says:
> "If back panel has no 'Manufactured by' text, look for brand logo/name if visible, otherwise leave brand empty"

**Problems:**
- Doesn't specify WHERE to look for logo (top? bottom? anywhere?)
- No guidance on what to do if text is unclear
- No emphasis: "When in doubt, prefer empty brand over wrong brand"

### Issue 3: No Self-Validation
Prompt doesn't ask ChatGPT to:
- Double-check extracted brand against ingredient list
- Verify brand makes sense as a company name (not a chemical/vitamin)
- Flag low-confidence brand extractions

---

## 6. EVIDENCE FROM ACTUAL LOGS

### Vision Analysis Results (All 26 Images)
```
Brand detections from Vision API:

FRONTS (mostly correct):
  143521.jpg → "Barbie x Evereden" ✅
  143304.jpg → "Jocko Fuel" ✅
  143335.jpg → "Jocko Fuel" ✅
  143002.jpg → "maude" ✅
  143234.jpg → "Naked Nutrition" ✅
  142857.jpg → "Oganacell" ✅
  143629.jpg → "Prequel" ✅
  143138.jpg → "RKMD" ✅
  143418.jpg → "Root" ✅
  143348.jpg → "Root" ✅
  142814.jpg → "Root" ✅
  143552.jpg → "RYSE" ✅
  143446.jpg → "Vita PLynxera" ✅ (note: strange brand, might be OCR error)

BACKS (problems here):
  143527.jpg → "Barbie x Evereden" ✅
  143310.jpg → "Jocko Fuel" ✅
  143030.jpg → "Maude" ✅
  143241.jpg → "Naked Nutrition" ✅
  142904.jpg → "Oganacell" ✅
  143353.jpg → "Root Wellness" ✅ (variant of "Root")
  142824.jpg → "Root Wellness" ✅
  143422.jpg → "Root Wellness" ✅
  143556.jpg → "RYSE" ✅
  143143.jpg → "Stevia" ❌ WRONG (should be RKMD)
  143340.jpg → (no brand listed in logs)
  143458.jpg → (no brand listed in logs)
  
ROLE MISCLASSIFICATIONS:
  143638.jpg → role: "other" ❌ (should be "back" - Prequel back panel)
```

### Pairing Results (What Happened After)
```
SUCCESSFUL PAIRS (8 total):
  143521 ↔ 143527 (Barbie x Evereden) ✅
  143304 ↔ 143310 (Jocko Fuel) ✅
  143002 ↔ 143030 (maude) ✅
  143234 ↔ 143241 (Naked Nutrition) ✅
  142857 ↔ 142904 (Oganacell) ✅
  142814 ↔ 142824 (Root ↔ Root Wellness - normalized to "root") ✅
  143552 ↔ 143556 (RYSE) ✅
  143446 ↔ 143458 (Vita PLynxera) ✅

REJECTED PAIRS (5 fronts became singletons):
  143335 (Jocko Fuel front) - rejected, gap too small (0.20)
  143629 (Prequel front) - rejected, back misclassified as "other"
  143138 (RKMD front) - rejected, back has "Stevia" brand
  143418 (Root front) - rejected, gap too small (0.50)
  143348 (Root front) - rejected, gap too small (0.80)
```

---

## 7. SPECIFIC IMAGES TO ANALYZE (If Testing)

### RKMD Greens Powder (Priority #1)

**Front Panel - 143138.jpg:**
- Red cylindrical jar with white text
- Large "RKMD" logo visible
- "Greens Powder" product name
- Vision correctly detected: brand="RKMD", role="front" ✅

**Back Panel - 143143.jpg:**
- Same red jar, rotated to show back
- Supplement Facts table visible
- Ingredient list includes "Stevia" (sweetener)
- Should have "Manufactured by RKMD" or similar text
- Vision INCORRECTLY detected: brand="Stevia", role="back" ❌

**Question for ChatGPT:** Why is Vision extracting "Stevia" (an ingredient) as the brand instead of looking for manufacturer information?

---

### Prequel Serum (Priority #2)

**Front Panel - 143629.jpg:**
- Navy blue rectangular box
- "Prequel" brand name visible
- Vision correctly detected: brand="Prequel", role="front" ✅

**Back Panel - 143638.jpg:**
- Same navy blue box, back side
- Should show product details
- Vision INCORRECTLY detected: brand="" (empty), role="other" ❌
- Should be: brand="Prequel", role="back"

**Question for ChatGPT:** Why is the back panel being classified as "other" role and having empty brand?

---

## 8. WHAT WE NEED FROM YOU (ChatGPT)

### Primary Questions

1. **Why is "Stevia" being extracted as a brand despite explicit prohibition?**
   - Prompt says: "DO NOT use ingredient names (like 'Stevia', 'VitaCholine', 'Biotin') as the brand"
   - Vision still returns brand="Stevia" for image 143143.jpg
   - How can we make this prohibition stronger/clearer?

2. **How can we improve the back panel brand detection?**
   - Should we add more ingredient examples to exclude?
   - Should we add a validation step: "Verify brand is not in ingredient list"?
   - Should we emphasize: "Supplement Facts table contains ingredients, NOT brands"?

3. **What's the best way to handle empty/missing brands on backs?**
   - Should we instruct: "Prefer empty brand over uncertain brand"?
   - Should we ask Vision to flag low-confidence extractions?
   - Should we provide a fallback strategy?

### Suggested Improvements Needed

Please review the prompt and suggest:
- **Stronger brand detection rules** that prevent ingredient extraction
- **Validation steps** to verify brand correctness
- **Clear prioritization** of where to look for brand on backs:
  1. "Manufactured by" / "Distributed by" text
  2. Company address
  3. Brand logo if clearly visible
  4. Empty if none found
- **Explicit ingredient exclusion strategy** beyond just 3 examples

### Success Criteria

After prompt improvements, we expect:
- Image 143143.jpg (RKMD back) → brand="RKMD" (not "Stevia")
- Image 143638.jpg (Prequel back) → brand="Prequel", role="back" (not empty/"other")
- All 13 front/back pairs correctly identified
- Zero ingredient names used as brands

---

## 9. TECHNICAL CONSTRAINTS

### System Limitations
- Each image analyzed **independently** (no cross-image context)
- Vision API called **once per image** (no retry with corrections)
- Results saved to Redis and used by pairing algorithm
- Pairing algorithm **cannot fix** wrong brands from Vision phase

### What We Cannot Change
- Two-phase architecture (Vision → Pairing)
- Individual image analysis (no batch context)
- OpenAI GPT-4o Vision model (already selected)
- JSON output format (required by downstream code)

### What We Can Change
- **Prompt text** (the instructions to Vision API) ← MAIN SOLUTION
- Brand normalization logic (already working: "Root Wellness" → "root")
- Pairing gap thresholds (risky - may cause false pairs)
- Fallback strategies in pairing phase (can infer brand from front)

---

## 10. SUMMARY FOR CHATGPT

**The Core Problem:**  
Vision API is extracting ingredient names from Supplement Facts tables as brands instead of looking for "Manufactured by" text.

**Current Prompt Weakness:**  
Says "DO NOT use ingredient names (like 'Stevia', 'VitaCholine', 'Biotin')" but this is being ignored.

**What We Need:**  
A stronger, clearer prompt that:
1. Prevents ingredient extraction as brands
2. Guides Vision to correct brand location on backs
3. Validates extracted brand isn't an ingredient/chemical
4. Handles edge cases (missing manufacturer text, unclear brands)

**Success Looks Like:**  
All 26 images get correct brand detection → 13/13 pairs created → SmartDrafts works perfectly.

---

**Question:** How would you rewrite the "BRAND DETECTION RULES (CRITICAL)" section to solve these issues?
