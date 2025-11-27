# Example Logs from Production Run

## Working Product: Root Sculpt Weight Loss Support (CORRECT) ✅

```
[Draft] Creating for: prod_2025-11-27_root-sculpt
[Draft] Product data: {
  "brand": "Root",
  "product": "Sculpt Weight Loss Support",
  "brandWebsite": "https://therootbrands.com/"
}

[price] Starting lookup for: "Sculpt Weight Loss Support" (Root)
[price] Tier 1: Checking eBay sold prices...
[price] ⚠️  eBay sold prices rate limited - skipping to brand MSRP
[price] Tier 2: Checking brand MSRP...
[price] Trying Vision API brand website: https://therootbrands.com/
[HTML Parser] Found 2 JSON-LD script(s), attempting extraction...
[HTML Parser] ✓ Extracted price $202.50 from JSON-LD Product
[price] ✓ Brand MSRP from Vision API website: $202.50
[price] Tier 3: AI arbitration with 1 candidate(s)...
[price] AI decision: source=brand-msrp base=$202.50 final=$182.25 | Applying 10% discount to MSRP
[price] ✓ Final decision: source=brand-msrp base=$202.50 final=$182.25

[GPT] Attempt 1/2 - calling OpenAI...
[GPT] Attempt 1 succeeded
[Draft] GPT response: {
  "categoryId": "181007",
  "title": "Root Sculpt Weight Loss Support 60 Capsules, All Natural Supplement",
  "formulation": "Capsule",
  "aspects": {
    "Brand": ["Root"],
    "Type": ["Vitamin & Mineral"],
    "Formulation": ["Capsule"],
    "Number of Pills": ["60"]
  },
  "price": 202.50
}

[Draft] ✓ Created for prod_2025-11-27_root-sculpt: "Root Sculpt Weight Loss Support 60 Capsules, All Natural Supplement"
```

**This one worked correctly!** Brand website had correct price, formulation matched label (60 Capsules visible in photo).

---

## Broken Product: Vita PLynxera Myo & D-Chiro Inositol (WRONG) ❌

```
[Draft] Creating for: prod_2025-11-27_vita-plynxera
[Draft] Product data: {
  "brand": "Vita PLynxera",
  "product": "Myo & D-Chiro Inositol",
  "brandWebsite": null
}

[price] Starting lookup for: "Myo & D-Chiro Inositol" (Vita PLynxera)
[price] Tier 1: Checking eBay sold prices...
[price] ⚠️  eBay sold prices rate limited - skipping to brand MSRP
[price] Tier 2: Checking brand MSRP...
[price] Vision API brand website: null
[price] Trying brand-map for Vita PLynxera Myo & D-Chiro Inositol...
[price] No curated URL found in brand-map
[price] Trying Amazon as fallback...
[search] Brave search: "Vita PLynxera Myo & D-Chiro Inositol" site:amazon.com
[search] Brave returned: https://www.amazon.com/Vita-PLynxera-D-Chiro-Inositol-Supplement/dp/B0DZW37LQJ
[price] Amazon URL found: https://www.amazon.com/Vita-PLynxera-D-Chiro-Inositol-Supplement/dp/B0DZW37LQJ
[HTML Parser] Found 1 JSON-LD script(s), attempting extraction...
[HTML Parser] ✓ Extracted price $27.99 from JSON-LD Product
[HTML Parser] ⚠️ WARNING: Detected multi-pack product - price may not be for single unit!
[price] ✓ Brand MSRP from Amazon: $27.99
[price] Tier 3: AI arbitration with 1 candidate(s)...

[AI Arbitration Prompt]:
PRODUCT INFORMATION:
- Title: Myo & D-Chiro Inositol
- Brand: Vita PLynxera

AVAILABLE PRICE DATA:
1. brand-msrp: $27.99 (Official brand site MSRP)

PRICING RULES:
1. **ALWAYS prefer brand MSRP if available** - apply 10% discount to compete with retail
...

[AI Response]:
{
  "chosenSource": "brand-msrp",
  "basePrice": 27.99,
  "recommendedListingPrice": 25.19,
  "reasoning": "Applied 10% discount to brand MSRP for competitive pricing"
}

[price] AI decision: source=brand-msrp base=$27.99 final=$25.19 | Applied 10% discount to brand MSRP for competitive pricing
[price] ✓ Final decision: source=brand-msrp base=$27.99 final=$25.19

[Draft] Prompt length: 4523 chars
[Draft] Prompt preview:
Product: Myo & D-Chiro Inositol
Brand: Vita PLynxera
Product Label Text (visible on packaging): Vita PLynxera, Myo & D-Chiro Inositol, Liquid Drops 2000 mg
👉 Use this label text to determine the correct formulation, size, and quantity.
Category hint: Health & Beauty > Vitamins & Supplements

COMPETITOR PRICING DATA (USE THESE EXACT VALUES):
- Brand direct price: $27.99

FORMULATION DETECTION (CRITICAL):
⚠️ ALWAYS use 'Product Label Text' provided above - do NOT guess or make assumptions!
Look at the extracted text from product photos to determine formulation:
- If label text mentions 'liquid', 'drops', 'dropper', 'sublingual', 'fl oz', 'ml' → formulation is 'Liquid'
- If label text mentions 'capsule', 'capsules', 'caps', 'vcaps', '60 count', '90 count' → formulation is 'Capsule'
Common mistake: If label says 'Liquid Drops', do NOT output 'Capsule' - use the actual label text!

[GPT] Attempt 1/2 - calling OpenAI...
[GPT] Attempt 1 succeeded
[Draft] GPT response: {
  "categoryId": "180960",
  "title": "Vita PLynxera Myo & D-Chiro Inositol 120 Capsules Health Supplement",
  "description": "Discover the powerful benefits of Vita PLynxera Myo & D-Chiro Inositol, a premium dietary supplement designed to support hormonal balance and overall wellness. This expertly formulated product combines myo-inositol and d-chiro-inositol in an optimal 40:1 ratio, making it an ideal choice for women seeking to enhance their reproductive health, manage PCOS symptoms, and improve metabolic function...",
  "bullets": [
    "Supports hormonal balance with optimal 40:1 ratio of myo and d-chiro inositol",
    "Promotes reproductive health and may help manage PCOS symptoms",
    "120 capsules per bottle for a 2-month supply",
    "Non-GMO, gluten-free, and suitable for vegetarians",
    "Manufactured in a GMP-certified facility for quality assurance"
  ],
  "aspects": {
    "Brand": ["Vita PLynxera"],
    "Type": ["Vitamin & Mineral"],
    "Formulation": ["Capsule"],
    "Main Purpose": ["Hormonal Balance"],
    "Ingredients": ["Myo-Inositol", "D-Chiro Inositol"],
    "Features": ["Non-GMO", "Gluten-Free", "GMP"],
    "Number of Pills": ["120"]
  },
  "price": 27.99,
  "condition": "NEW"
}

[Draft] ✓ Created for prod_2025-11-27_vita-plynxera: "Vita PLynxera Myo & D-Chiro Inositol 120 Capsules Health Supplement"
```

**PROBLEMS VISIBLE IN LOGS**:

1. ✅ Multi-pack detection WORKED: `[HTML Parser] ⚠️ WARNING: Detected multi-pack product`
   - But the warning was IGNORED by downstream code

2. ❌ GPT COMPLETELY IGNORED keyText: "Liquid Drops 2000 mg"
   - Despite prompt saying: "⚠️ ALWAYS use 'Product Label Text' provided above"
   - GPT output: "120 Capsules" (made up)
   - Even made up bullets: "120 capsules per bottle for a 2-month supply" (complete hallucination)

3. ❌ Price used multi-pack variant: $27.99 instead of $20.00 single bottle
   - AI arbitration got wrong base price from HTML parser
   - Applied 10% discount to wrong price: $27.99 → $25.19

4. ❌ No validation happened:
   - No check that "Liquid Drops" keyText conflicts with "120 Capsules" output
   - No check that price seems high for single liquid drops bottle
   - System blindly accepted GPT hallucination

---

## Key Observations

### What's Working:
- Vision API classification: 100% accurate
- Multi-pack detection: Correctly identifies 2-pack products
- AI pricing arbitration: Correctly prefers MSRP and applies 10% discount
- Prompt includes correct keyText data

### What's Broken:
- GPT ignores keyText and hallucinates formulation
- HTML parser grabs wrong price variant (multi-pack instead of single)
- No validation between Vision data and GPT output
- Multi-pack warnings logged but not acted upon

### Why It's Getting Worse:
Every "fix" adds more complexity without solving the core issue:
1. Added keyText to prompt → GPT still ignores it
2. Added multi-pack detection → Warning logged but not used
3. Added stronger pricing rules → Applied to wrong base price

**The fixes are symptoms-based, not root-cause-based.**
