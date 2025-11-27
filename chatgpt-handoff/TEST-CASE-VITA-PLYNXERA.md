# Test Case: Vita PLynxera Myo & D-Chiro Inositol

## Product Photos
- **Front panel**: Shows "Vita PLynxera" brand, "Myo & D-Chiro Inositol", "Liquid Drops 2000 mg"
- **Quantity**: 1 bottle visible in photo
- **Package type**: Box with bottle inside

## Vision API Classification (CORRECT) ✅

```json
{
  "brand": "Vita PLynxera",
  "productName": "Myo & D-Chiro Inositol",
  "keyText": [
    "Vita PLynxera",
    "Myo & D-Chiro Inositol",
    "Liquid Drops 2000 mg"
  ],
  "packageType": "box",
  "categoryPath": "Health & Beauty > Vitamins & Supplements"
}
```

## Price Lookup Logs

```
[price] Starting lookup for: "Myo & D-Chiro Inositol" (Vita PLynxera)
[price] Tier 1: Checking eBay sold prices...
[price] ⚠️  eBay sold prices rate limited - skipping to brand MSRP
[price] Tier 2: Checking brand MSRP...
[price] Trying Amazon as fallback...
[price] Amazon URL found: https://www.amazon.com/Vita-PLynxera-D-Chiro-Inositol-Supplement/dp/B0DZW37LQJ
[HTML Parser] Found 1 JSON-LD script(s), attempting extraction...
[HTML Parser] ✓ Extracted price $27.99 from JSON-LD Product
[price] ✓ Brand MSRP from Amazon: $27.99
[price] Tier 3: AI arbitration with 1 candidate(s)...
[price] AI decision: source=brand-msrp base=$27.99 final=$25.19 | Applying 10% discount to MSRP
[price] ✓ Final decision: source=brand-msrp base=$27.99 final=$25.19
```

**PROBLEM**: Amazon URL shows $27.99 but this is likely the 2-pack price, NOT single bottle price.

## GPT Prompt (Excerpt)

```
Product: Myo & D-Chiro Inositol
Brand: Vita PLynxera
Product Label Text (visible on packaging): Vita PLynxera, Myo & D-Chiro Inositol, Liquid Drops 2000 mg
👉 Use this label text to determine the correct formulation, size, and quantity.
Category hint: Health & Beauty > Vitamins & Supplements

COMPETITOR PRICING DATA (USE THESE EXACT VALUES):
- Brand direct price: $27.99

PRICING RULES:
- You MUST use the lowest competitor price from above as your 'price' field
- DO NOT search for prices - the data above is authoritative and current
- DO NOT invent or hallucinate prices
- Return ONLY the number in the 'price' field (e.g., 16.00)

⚠️ CRITICAL: Match the EXACT quantity shown in photos - if photos show 1 bottle, use SINGLE bottle price, NOT 2-pack/3-pack/bundle pricing!

FORMULATION DETECTION (CRITICAL):
⚠️ ALWAYS use 'Product Label Text' provided above - do NOT guess or make assumptions!
Look at the extracted text from product photos to determine formulation:
- If label text mentions 'liquid', 'drops', 'dropper', 'sublingual', 'fl oz', 'ml' → formulation is 'Liquid'
- If label text mentions 'capsule', 'capsules', 'caps', 'vcaps', '60 count', '90 count' → formulation is 'Capsule'
Common mistake: If label says 'Liquid Drops', do NOT output 'Capsule' - use the actual label text!
```

## GPT Response (WRONG) ❌

```json
{
  "categoryId": "180960",
  "title": "Vita PLynxera Myo & D-Chiro Inositol 120 Capsules Health Supplement",
  "description": "Discover Vita PLynxera Myo & D-Chiro Inositol...",
  "bullets": [...],
  "aspects": {
    "Brand": ["Vita PLynxera"],
    "Type": ["Vitamin & Mineral"],
    "Formulation": ["Capsule"],
    "Main Purpose": ["Hormonal Balance"],
    "Number of Pills": ["120"]
  },
  "price": 27.99,
  "condition": "NEW"
}
```

**PROBLEMS**:
1. Formulation: "Capsule" ❌ (should be "Liquid")
2. Number of Pills: "120" ❌ (liquid drops don't have pills)
3. Title: "120 Capsules" ❌ (should be "Liquid Drops")
4. Price: $27.99 → $25.19 after discount ❌ (should be $20 single bottle → $18)

## Expected GPT Response ✅

```json
{
  "categoryId": "180960",
  "title": "Vita PLynxera Myo & D-Chiro Inositol Liquid Drops 2000mg Hormonal Support",
  "description": "Discover Vita PLynxera Myo & D-Chiro Inositol Liquid Drops...",
  "bullets": [...],
  "aspects": {
    "Brand": ["Vita PLynxera"],
    "Type": ["Vitamin & Mineral"],
    "Formulation": ["Liquid"],
    "Main Purpose": ["Hormonal Balance"],
    "Volume": ["2000 mg"]
  },
  "price": 20.00,
  "condition": "NEW"
}
```

With 10% discount applied by pricing system → Final: $18.00

## Amazon Product Page Analysis

**URL**: https://www.amazon.com/Vita-PLynxera-D-Chiro-Inositol-Supplement/dp/B0DZW37LQJ

**Suspected Issue**: Amazon page likely shows:
- **Single bottle**: $20.00 (correct)
- **2 Pack**: $27.99 (what HTML parser grabbed)

HTML parser's JSON-LD extraction is getting the 2-pack variant price instead of single bottle.

## Root Causes

### Formulation Issue
GPT is ignoring the explicit `keyText` that says "Liquid Drops 2000 mg" and hallucinating "120 Capsules" based on:
- Product category (supplements often come as capsules)
- Similar product patterns it has seen
- NOT reading the provided label text despite clear instructions

### Pricing Issue
HTML price extractor is grabbing the first price in JSON-LD, which is the 2-pack variant ($27.99) instead of the single bottle ($20.00).

Amazon JSON-LD likely has multiple offers:
```json
{
  "@type": "Product",
  "offers": [
    { "price": "27.99", "name": "2 Pack" },
    { "price": "20.00", "name": "Single" }
  ]
}
```

Parser takes the first/lowest, which happens to be 2-pack in this case.

## Suggested Fixes

### Fix #1: Stronger GPT Instructions
Current prompt says: "⚠️ ALWAYS use 'Product Label Text' provided above"  
GPT still ignores it.

**Try**: Move keyText to the BEGINNING of the prompt, not buried in product details. Make it the FIRST thing GPT sees:

```
CRITICAL: The following text is EXACTLY what appears on the product label:
"${keyText.join(', ')}"

You MUST use this exact text to determine:
1. Formulation (Liquid/Capsule/Powder/Tablet)
2. Quantity/Size
3. Product name

DO NOT use general knowledge or assumptions about this product category.
USE ONLY THE LABEL TEXT PROVIDED ABOVE.
```

### Fix #2: Skip Amazon for Pricing
Amazon has too many variants (single, 2-pack, 3-pack, subscribe & save, etc.)  
The HTML parser can't reliably extract the correct variant.

**Try**: 
1. Only use brand website for MSRP (skip Amazon entirely)
2. If brand website fails, use estimate
3. Amazon should NEVER be used as pricing source

### Fix #3: Validate Price Against Formulation
If formulation is "Liquid" and price is for "Capsules 120-count", the price is probably wrong.

**Try**: Add validation step that checks if extracted price matches the product type/size seen in photos.
