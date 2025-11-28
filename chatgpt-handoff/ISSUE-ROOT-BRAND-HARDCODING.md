# Issue: Hardcoded Root Brand Logic

## Problem
We're currently using hardcoded brand-specific logic to skip Root brand websites during price extraction. This is a band-aid fix that won't scale.

## Current Implementation
In `price-lookup.ts`, we have two places where we explicitly check for `therootbrands.com`:

1. **Vision API URL skip** (lines ~355-365):
```typescript
const isRootBrand = input.brandWebsite.includes('therootbrands.com');

if (isRootBrand) {
  console.log(`[price] ⚠️ Root brand website detected, skipping (shows bundle prices, not individual product pricing)`);
}
```

2. **Brave Search URL skip** (lines ~413-423):
```typescript
const isRootBrand = braveUrl.includes('therootbrands.com');

if (isRootBrand) {
  console.log(`[price] ⚠️ Root brand website from Brave, skipping (shows bundle prices)`);
}
```

## Why This Is a Problem
1. **Doesn't scale**: Every MLM/direct-sales brand will need its own hardcoded check
2. **Maintenance nightmare**: Brand domains change, new brands emerge
3. **Fragile**: Breaks if Root changes their domain or URL structure
4. **Symptoms, not cause**: We're treating the symptom (Root shows wrong prices) instead of the root cause (bundle/subscription pricing detection)

## The Real Issue
Many brands (especially MLM/direct-sales companies) show:
- **Bundle pricing** ($225 for 3-month supply)
- **Subscription pricing** ("Subscribe & Save for $15/month")
- **Starter pack pricing** (multiple products bundled together)
- **Auto-ship pricing** (recurring orders at discounted rates)

Instead of **single-product retail prices**.

## Better Solutions

### Option 1: Pattern-Based Bundle Detection
Detect bundle/subscription language in the HTML before extracting price:
```typescript
function isProbablyBundlePage(html: string): boolean {
  const bundleIndicators = [
    /subscribe\s*(&|and)\s*save/i,
    /auto[-\s]?ship/i,
    /starter\s*(pack|kit|bundle)/i,
    /\d+[-\s]?month\s*supply/i,
    /recurring\s*order/i,
    /subscription/i
  ];
  
  return bundleIndicators.some(pattern => pattern.test(html));
}
```

### Option 2: Multi-Price Detection
When a page has multiple prices, look for "one-time purchase" vs "subscribe":
```typescript
// Find both subscription and one-time prices
const subscriptionPrice = extractPriceNear(html, /subscribe|subscription/i);
const oneTimePrice = extractPriceNear(html, /one[-\s]?time|retail/i);

// Prefer one-time over subscription
return oneTimePrice || subscriptionPrice;
```

### Option 3: Price Validation
Reject prices that seem like bundles:
```typescript
// If brand site price is >3x Amazon price, it's probably a bundle
if (brandPrice > amazonPrice * 3) {
  console.log(`[price] Brand price $${brandPrice} seems like bundle (>3x Amazon $${amazonPrice}), using Amazon`);
  return amazonPrice;
}
```

### Option 4: Category-Based Priority
For supplements/health products, prefer Amazon over brand sites:
```typescript
const isHealthSupplement = category.includes('Vitamins') || category.includes('Supplements');

if (isHealthSupplement && amazonPrice && brandPrice) {
  // MLM supplements are almost always cheaper on Amazon
  return amazonPrice; // Skip brand site entirely for this category
}
```

## Recommended Approach
**Combine Options 1 & 3**:
1. Check for bundle/subscription indicators in HTML
2. If detected, skip that URL and try next source
3. Add price validation as safety net (reject if >3x marketplace price)
4. Remove hardcoded brand checks

This makes the system robust against:
- New MLM brands
- Domain changes
- Different bundle pricing strategies
- False positives (via validation)

## Files to Review
- `src/lib/price-lookup.ts` - Contains the hardcoded Root brand checks
- `src/lib/html-price.ts` - Where price extraction happens (could add bundle detection here)

## Test Cases
Once fixed, should handle:
- ✅ Root Zero-In: Skip therootbrands.com bundle pricing, use Amazon $77.60
- ✅ Root Clean Slate: Skip therootbrands.com, use Amazon or estimate
- ✅ Other MLM brands (Herbalife, Arbonne, etc.) without hardcoding each one
- ✅ Regular brands with bundle pages (e.g., "Buy 3, Get 1 Free" promotions)

## Current Status
**✅ PHASE 1 COMPLETE (Commit 14e0556)**: Generic bundle/subscription page detection implemented
**⚠️ TEMPORARY**: Root brand hardcoded checks remain (with TODO comments) until better MLM detection

### What Was Implemented (Phase 1)
Added `isProbablyBundlePage()` function in `html-price.ts` that:
- Detects bundle/subscription pages by looking for strong signals: "3-month supply", "starter pack", "value pack", etc.
- Whitelists major retailers (Amazon, eBay, Walmart) that offer subscriptions as OPTIONS
- Skips any URL matching bundle patterns BEFORE extracting price
- Returns `null` from `extractPriceFromHtml()` when bundle detected

### What Works Now
✅ Pages with "3-month supply" language are automatically rejected (no brand-specific code needed)
✅ Amazon/eBay pages with "Subscribe & Save" still work (whitelisted)
✅ Root brand still works via hardcoded checks (therootbrands.com detection)
✅ Bundle detection is brand-agnostic for brands using clear multi-month language

### What Doesn't Work Yet (Needs Phase 2+)
❌ Root brand requires hardcoded check because their pages only say "subscription", not "3-month supply"
❌ Other MLM brands without clear bundle language will slip through
❌ Need smarter detection of MLM/direct-sales business models

## Current Status
**TEMPORARY FIX DEPLOYED**: Hardcoded Root brand skip is live and working.
**NEEDS REFACTOR**: Should be replaced with pattern-based detection before shipping to production for other brands.
