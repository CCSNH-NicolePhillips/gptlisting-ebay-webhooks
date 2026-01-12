# Pricing Improvement Priority Analysis

> Generated: January 1, 2026

## 🎯 Executive Summary

Based on code analysis, **the most urgent issue is "Finding the Right Product URL"** (Identity Integrity), not parsing. Here's why:

| Problem Category | Current State | Impact |
|------------------|---------------|--------|
| **Identity Integrity** | `netWeight` only used in retry path; `keyText` filtered to category hints only | 🔴 Wrong product found = wrong price |
| **Scraper Precision** | Buy Box selectors exist; pack detection is robust after recent fixes | 🟡 Mostly working, edge cases remain |
| **AI Arbitration** | Clear hierarchy (Amazon > Brand > eBay); bundle detection at 1.8x | 🟢 Solid, minor tuning needed |

---

## 1️⃣ HIGHEST PRIORITY: Identity Integrity 🔍

### Current Gaps in `price-lookup.ts`

#### Gap A: `netWeight` is NOT used in initial search query
```typescript
// Line 1010-1040: netWeight is added ONLY IF it's NOT in a special unit list
if (input.netWeight && input.netWeight.value && input.netWeight.unit) {
  const sizeStr = `${input.netWeight.value} ${input.netWeight.unit}`;
  
  // Only add to query if NOT a count-based size (capsules, tablets, etc.)
  const countUnits = ['capsules', 'tablets', 'softgels', 'gummies', 'pieces', 'sticks', 'packets', 'chews'];
  if (!countUnits.includes(input.netWeight.unit.toLowerCase())) {
    searchQuery += ` ${sizeStr}`;
  }
} else if (input.keyText && input.keyText.length > 0) {
  // Only look for category hints like "hair", "skin", "supplement"
  const categoryHint = input.keyText.find(text => ...);
}
```

**Problem:** For supplements (most products), `netWeight` is "60 capsules" which is EXCLUDED from search. The `keyText` fallback only looks for broad category hints, not specific product identifiers.

#### Gap B: UPC is never used in Amazon search
```typescript
// UPC exists in PriceLookupInput but is NEVER passed to braveFirstUrl
export interface PriceLookupInput {
  upc?: string;  // <- This is available but unused for Amazon search!
  // ...
}
```

**Fix Opportunity:** Amazon search with UPC would be nearly 100% accurate.

#### Gap C: `amazonMatchesProductTerms` 60% threshold is too lenient
```typescript
// Line 270: 60% match allows significant mismatches
const matchRatio = (filteredTerms.length - missing.length) / filteredTerms.length;
const matches = matchRatio >= 0.6 || missing.length === 0;
```

**Problem:** "Fem Dophilus Ultra 50 Billion" matching "Fem Dophilus 5 Billion" could pass at 60%.

### Recommended Fixes (Priority Order)

| Fix | Effort | Impact |
|-----|--------|--------|
| **Add UPC to Amazon search query** | Low | High - near-perfect product matching |
| **Use netWeight in initial search (not just retry)** | Low | High - correct size variant found first time |
| **Strict mode for CFU/strength matching** | Medium | High - prevents 5B vs 50B mismatch |
| **Validate brandWebsite URLs before using** | Medium | Medium - reduces 404s on MSRP lookup |

---

## 2️⃣ MEDIUM PRIORITY: Scraper Precision 📦

### Current State (Mostly Solid After Recent Fixes)

Your recent commit fixed pouch/liposomal products. The remaining gaps:

#### Buy Box vs Other Sellers
```typescript
// html-price.ts line 979: Only ONE Buy Box selector exists
'[data-feature-name="shippingMessageInsideBuyBox"]'  // Only for shipping detection
```

**Current approach:** Uses JSON-LD `Product.offers` first (lines 550-600), then falls back to body text parsing. This is actually more reliable than DOM selectors for Amazon because:
- JSON-LD is structured data, not dependent on CSS classes
- Amazon changes DOM structure frequently but JSON-LD is more stable

**Risk:** If Amazon shows "Other Sellers" prices in JSON-LD, we'd pick them up.

#### Missing "Box of X" Detection
```typescript
// detectPackQty only looks for:
/\b(?:pack|pk)\s*of\s*(\d+)\b/        // "pack of 2"
/\b(\d+)\s*(?:pack|pk|ct)\b/           // "24 pack"
/\b(\d+)\s*(?:bottles?|capsules?...)   // "2 bottles"
```

**Gap:** "Box of 12" or "Case of 24" could slip through.

### Recommended Fixes

| Fix | Effort | Impact |
|-----|--------|--------|
| **Add "Box of X", "Case of X" patterns** | Low | Medium - catches wholesale listings |
| **Add Buy Box container check** | Medium | Low - JSON-LD already handles most cases |
| **Headless browser fallback** | High | Medium - only helps JS-heavy brand sites |

---

## 3️⃣ LOWER PRIORITY: AI Arbitration Logic ⚖️

### Current State (Working Well)

The arbitration in `decideFinalPrice()` (lines 653-850) has:
- ✅ Clear hierarchy: Amazon > Brand MSRP > eBay Sold
- ✅ Bundle detection at 1.8x ratio
- ✅ Minimum $5 sanity check
- ✅ $8 floor for marketplace prices

### Potential Improvements

| Fix | Effort | Impact |
|-----|--------|--------|
| **Weight eBay Sold higher for used items** | Low | Medium - better pricing for used condition |
| **Cross-source sanity check** | Medium | Low - already have bundle detection |
| **Confidence scoring from Amazon match quality** | High | Medium - would help with edge cases |

---

## 🛠️ Concrete Implementation Plan

### Phase 1: Quick Wins (1-2 hours each)

#### 1A. Add UPC to Amazon Search
```typescript
// In price-lookup.ts, around line 1010
let searchQuery = `${input.brand} ${input.title}`;

// NEW: Add UPC if available (most reliable identifier)
if (input.upc) {
  searchQuery = `${input.upc} ${input.brand}`;
  console.log(`[price-debug] Using UPC in search: ${input.upc}`);
}
```

#### 1B. Use netWeight in Initial Search (Not Just Retry)
```typescript
// Move netWeight logic BEFORE the Brave search, not as fallback
if (input.netWeight?.value && input.netWeight?.unit) {
  const sizeStr = `${input.netWeight.value} ${input.netWeight.unit}`;
  // Include even for count units - helps differentiate "60 capsules" vs "120 capsules"
  searchQuery += ` ${sizeStr}`;
}
```

#### 1C. Add Strict Mode for Strength Matching
```typescript
// In amazonMatchesProductTerms(), special handling for strength indicators
const strengthTerms = ourTerms.filter(t => /\d+billion|\d+million|\d+mg|\d+mcg/.test(t));
if (strengthTerms.length > 0) {
  // Strength terms MUST match exactly (no 60% threshold)
  const strengthMissing = strengthTerms.filter(term => !normalizedAmazon.includes(term));
  if (strengthMissing.length > 0) {
    console.log(`[price] ❌ Strict mode: strength mismatch - ${strengthMissing.join(', ')}`);
    return { matches: false, missing: strengthMissing };
  }
}
```

### Phase 2: Scraper Hardening (2-4 hours)

#### 2A. Add "Box/Case of X" Detection
```typescript
// In detectPackQty() in html-price.ts
// Add these patterns:
/\b(?:box|case)\s*of\s*(\d+)\b/i,      // "Box of 12", "Case of 24"
/\b(\d+)\s*(?:box|case|carton)\b/i,    // "12 box", "24 case"
```

### Phase 3: Arbitration Refinement (4-8 hours)

#### 3A. Pass Match Confidence to Arbitration
```typescript
interface PriceSourceDetail {
  source: PriceSource;
  price: number;
  // NEW: Add confidence score from matching
  matchConfidence?: 'high' | 'medium' | 'low';
  matchEvidence?: string[];  // What terms matched
}
```

---

## 📊 Decision: Where to Start?

**Answer: Start with Identity Integrity (1A and 1B above)**

**Reasoning:**
1. If you find the WRONG product, no amount of parsing precision helps
2. UPC search is near-guaranteed to find the exact product
3. These are ~30 min fixes with high impact
4. Your scraper is already solid after the pouch/liposomal fix

**Test Case:** After implementing 1A, test with a product that has a UPC. The Amazon search should hit the exact ASIN immediately.

---

## 📁 Files to Modify

| Priority | File | Changes |
|----------|------|---------|
| 1A | `src/lib/price-lookup.ts` | Add UPC to search query (line ~1010) |
| 1B | `src/lib/price-lookup.ts` | Move netWeight to initial search (line ~1010) |
| 1C | `src/lib/price-lookup.ts` | Add strict mode in `amazonMatchesProductTerms` (line ~250) |
| 2A | `src/lib/html-price.ts` | Add Box/Case patterns to `detectPackQty` (line ~120) |
