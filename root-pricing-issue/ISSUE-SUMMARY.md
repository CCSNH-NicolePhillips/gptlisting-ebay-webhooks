# Root Brands Pricing Issue - Analysis Summary

**Date:** November 26, 2024  
**Status:** URGENT - Production pricing bug causing 85% price reduction  

---

## Problem Statement

### Current Behavior
All Root Brands products are being listed at **$12.75** due to incorrect MSRP extraction of **$15**:

- **Root Zero-In**: Extracts $15 → Lists at $12.75 (should be ~$71 based on $84 MSRP)
- **Root Sculpt**: Extracts $15 → Lists at $12.75 (should be ~$71 based on $84 MSRP)  
- **Root Clean Slate**: Extracts $15 → Lists at $12.75 (should be ~$71 based on $84 MSRP)

### Expected Behavior
Root Zero-In shows **$84.00** prominently on the official brand website:
- URL: `https://therootbrands.com/product/zero-in/`
- One-time price: **$84.00**
- Subscription price: **$75.60** (with 10% discount)
- Per-serving: **$1.40 USD/SERVING**

**None of these prices match the extracted $15.**

### Business Impact
- Revenue loss: Listings priced **82% below** actual MSRP
- Incorrect market positioning
- Seller loses ~$58 per unit sold

---

## Technical Root Cause

### Execution Flow

1. **Brave Search** successfully finds correct brand URLs ✅
   ```
   https://therootbrands.com/product/zero-in/
   https://therootbrands.com/product/sculpt/
   https://therootbrands.com/product/clean-slate/
   ```

2. **HTML Parser** attempts JSON-LD extraction ⚠️
   ```log
   [HTML Parser] Found 2 JSON-LD script(s), attempting extraction...
   [HTML Parser] No price found in JSON-LD
   ```

3. **Fallback to body regex** finds mysterious $15 ❌
   ```log
   [price] ✓ Brand MSRP from Brave search: $15.00
   ```

4. **AI arbitration** applies 15% discount
   ```log
   [price] AI decision: source=brand-msrp base=$15.00 final=$12.75
   ```

### The Mystery: Where is $15 coming from?

**Investigation findings:**
- ✅ NOT the one-time price ($84)
- ✅ NOT the subscription price ($75.60)
- ✅ NOT the per-serving price ($1.40)
- ❌ **NOT VISIBLE ANYWHERE in fetched page HTML**

**Hypothesis:** The `extractFromBody()` regex is matching $15 somewhere in:
- Page metadata/scripts
- Related product prices
- Shipping costs
- Promotional text

---

## What We've Already Tried

### Commit 056b037 (Nov 26, 2024)
**Goal:** Extract highest price when multiple offers exist (one-time vs subscription)

**Changes:**
```typescript
// BEFORE: Return first price found
const priceFromOffer = toNumber((offer as any).price) ?? ...;
if (priceFromOffer) {
  return { price: priceFromOffer }; // ← EXIT IMMEDIATELY
}

// AFTER: Collect all prices, return maximum
const allPrices: number[] = [];
for (const offer of offerList) {
  const priceFromOffer = toNumber((offer as any).price) ?? ...;
  if (priceFromOffer) {
    allPrices.push(priceFromOffer); // ← COLLECT
  }
}
if (allPrices.length > 0) {
  const maxPrice = Math.max(...allPrices);
  return { price: maxPrice }; // ← RETURN HIGHEST
}
```

**Result:** ❌ **FAILED**

**Why:** JSON-LD extraction returns `null` (no prices found), so the "highest price" logic never runs. Parser falls back to `extractFromBody()` regex which incorrectly finds $15.

---

## Investigation Needed

### 1. Examine JSON-LD Structure

**Questions:**
- What are the 2 JSON-LD scripts on Root Brands pages?
- Do they contain Product schema?
- If yes, what does the offers structure look like?
- If no, what schemas are present?

**How to test:**
```bash
curl 'https://therootbrands.com/product/zero-in/' | grep -A 100 'application/ld+json'
```

### 2. Identify $15 Source

**Questions:**
- What text in the page contains "$15"?
- Is it in visible HTML or hidden metadata?
- Is it related to shipping, taxes, or other products?

**How to test:**
```typescript
const $ = cheerio.load(html);
const bodyText = $.root().text();
const matches = Array.from(bodyText.matchAll(/\$\s?(\d{1,4}(?:\.\d{2})?)/g));
console.log('All $ amounts found:', matches.map(m => m[1]));
```

### 3. Check Open Graph Tags

**Questions:**
- Does the page have `product:price:amount` meta tags?
- If yes, what value do they contain?

**How to test:**
```typescript
const ogPrice = $('meta[property="product:price:amount"]').attr('content');
console.log('Open Graph price:', ogPrice);
```

---

## Potential Solutions

### Option A: Fix JSON-LD Parsing
If JSON-LD contains the price but in a different structure:

```typescript
// Check for:
// - AggregateOffer vs Offer type
// - priceSpecification.minPrice/maxPrice
// - Currency-prefixed format ("USD 84.00")
// - Nested offers array

const priceFromOffer =
  toNumber((offer as any).price) ??
  toNumber((offer as any).priceSpecification?.price) ??
  toNumber((offer as any).priceSpecification?.minPrice) ?? // NEW
  toNumber((offer as any).priceSpecification?.maxPrice) ?? // NEW
  toNumber((offer as any).lowPrice) ??
  toNumber((offer as any).highPrice); // NEW
```

### Option B: Improve Body Regex
If price is in HTML but regex is matching the wrong one:

```typescript
// Priority-based matching:
// 1. Look for price near "MSRP" or "List Price"
// 2. Look for price in specific HTML classes (e.g., .product-price)
// 3. Return HIGHEST price found, not FIRST

function extractFromBody($: cheerio.CheerioAPI): number | null {
  // Try targeted selector first
  const priceElement = $('.product-price, .price, [data-price]').first();
  if (priceElement.length) {
    const priceText = priceElement.text();
    const match = priceText.match(/\$\s?(\d{1,4}(?:\.\d{2})?)/);
    if (match) return toNumber(match[1]);
  }
  
  // Collect ALL prices from body
  const bodyText = $.root().text();
  const matches = Array.from(bodyText.matchAll(/\$\s?(\d{1,4}(?:\.\d{2})?)/g));
  const prices = matches.map(m => toNumber(m[1])).filter(p => p !== null);
  
  // Return highest price (likely the MSRP)
  return prices.length > 0 ? Math.max(...prices) : null;
}
```

### Option C: Check for JavaScript-Rendered Content
If price is rendered by JavaScript and not in initial HTML:

```typescript
// Look for price in script variables or data attributes:
const scriptText = $('script:not([src])').text();
const dataPrice = $('[data-price], [data-product-price]').attr('data-price');
```

---

## Files for ChatGPT Analysis

This folder contains:
1. **ISSUE-SUMMARY.md** (this file) - Problem context
2. **html-price.ts** - Core HTML parsing logic
3. **price-lookup.ts** - Tiered pricing orchestration
4. **search.ts** - Brand domain mapping (for reference)
5. **sample-logs.txt** - Actual test output showing $15 extraction
6. **test-html-snippet.txt** - Key HTML sections from Root Brands pages

---

## Next Steps for ChatGPT

1. **Fetch and examine** actual JSON-LD content from `https://therootbrands.com/product/zero-in/`
2. **Identify** where $15 is coming from in the page
3. **Determine** why $84 is not being extracted
4. **Propose fix** based on actual page structure
5. **Implement** fix in `html-price.ts` with proper error handling

---

## Key Code Sections

### Current JSON-LD Parser (lines 18-70 in html-price.ts)
```typescript
function extractFromJsonLd($: cheerio.CheerioAPI): ExtractedData {
  const scripts = $('script[type="application/ld+json"]').toArray();
  
  if (scripts.length === 0) {
    console.log(`[HTML Parser] No JSON-LD scripts found`);
    return { price: null };
  }
  
  console.log(`[HTML Parser] Found ${scripts.length} JSON-LD script(s), attempting extraction...`);
  
  const allPrices: number[] = [];
  
  for (const node of scripts) {
    try {
      const raw = $(node).text().trim();
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const type = String((item as any)["@type"] || "").toLowerCase();
        if (!type.includes("product")) continue;  // ← MUST MATCH "Product" SCHEMA
        
        const offers = (item as any).offers;
        if (!offers) continue;
        const offerList = Array.isArray(offers) ? offers : [offers];
        
        for (const offer of offerList) {
          if (!offer || typeof offer !== "object") continue;
          
          const priceFromOffer =
            toNumber((offer as any).price) ??
            toNumber((offer as any).priceSpecification?.price) ??
            toNumber((offer as any).lowPrice);
          
          if (priceFromOffer) {
            allPrices.push(priceFromOffer);
          }
        }
      }
    } catch (err) {
      continue;
    }
  }
  
  if (allPrices.length === 0) {
    console.log(`[HTML Parser] No price found in JSON-LD`);
    return { price: null };
  }
  
  const maxPrice = Math.max(...allPrices);
  console.log(`[HTML Parser] ✓ Extracted price $${maxPrice} from JSON-LD Product (found ${allPrices.length} price(s): ${allPrices.join(', ')})`);
  return { price: maxPrice };
}
```

### Current Body Fallback (lines 86-95 in html-price.ts)
```typescript
function extractFromBody($: cheerio.CheerioAPI): number | null {
  const bodyText = $.root().text().replace(/\s+/g, " ");
  
  // Try targeted search near "price", "buy", "order", "sale" keywords
  const targeted = bodyText.match(/(?:price|buy|order|sale)[^$]{0,60}\$\s?(\d{1,4}(?:\.\d{2})?)/i);
  if (targeted) {
    return toNumber(targeted[1]);
  }
  
  // Fallback: first $ amount found anywhere
  const match = bodyText.match(/\$\s?(\d{1,4}(?:\.\d{2})?)/);
  return match ? toNumber(match[1]) : null;  // ← RETURNS $15 HERE
}
```

### Pricing Orchestration (lines 260-280 in price-lookup.ts)
```typescript
// Tier 2: Brand MSRP from Brave search
if (!brandPrice && input.brand) {
  const braveUrl = await braveFirstUrlForBrandSite(
    input.brand,
    input.title,
    undefined
  );
  
  if (braveUrl) {
    brandPrice = await priceFrom(braveUrl);  // ← CALLS extractPriceFromHtml()
    if (brandPrice) {
      brandUrl = braveUrl;
      console.log(`[price] ✓ Brand MSRP from Brave search: $${brandPrice.toFixed(2)}`);
    }
  }
}
```

---

## Expected Outcome

After the fix:
```log
[HTML Parser] Found 2 JSON-LD script(s), attempting extraction...
[HTML Parser] ✓ Extracted price $84.00 from JSON-LD Product (found 2 price(s): 75.60, 84.00)
[price] ✓ Brand MSRP from Brave search: $84.00
[price] AI decision: source=brand-msrp base=$84.00 final=$71.40 | Brand MSRP with 15% competitive discount
```

Root Zero-In listing price: **$71.40** ✅  
(Instead of current: **$12.75** ❌)
