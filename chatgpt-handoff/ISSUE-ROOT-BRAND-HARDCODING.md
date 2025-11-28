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
**✅ PHASE 2 COMPLETE (Commit ad259af)**: Price sanity guardrail (3.0x ratio check) implemented
**✅ PHASE 3 COMPLETE (Commit d7c0a9c)**: Removed all brand-specific hardcoding, lowered threshold to 2.5x

### What Was Implemented

**Phase 1 - Bundle Page Detection (html-price.ts)**
- `isProbablyBundlePage()` detects bundle/subscription pages by looking for strong signals
- Searches for: "3-month supply", "starter pack", "value pack", "refill program"
- Whitelists major retailers (Amazon, eBay, Walmart) that offer subscriptions as OPTIONS
- Returns `null` from `extractPriceFromHtml()` when bundle detected

**Phase 2 - Price Sanity Guardrail (price-lookup.ts)**
- `isProbablyBundlePrice()` compares brand prices against marketplace prices
- Filters out brand candidates with ratio > threshold
- Applies BEFORE AI arbitration as safety net
- Catches bundle pricing even when HTML text detection fails
- **Threshold lowered from 3.0x → 2.5x** to catch MLM brands like Root

**Phase 3 - Remove Hardcoding (price-lookup.ts, search.ts)**
- Removed all `isRootBrand` checks from Vision API section
- Removed all `isRootBrand` checks from Brave search section
- Removed `'root': 'therootbrands.com'` from BRAND_DOMAINS mapping
- Modified Amazon logic to **always fetch** (not just fallback) to enable Phase 2 comparison
- Added debug log for troubleshooting price selection
- Updated test scripts to reflect new 2.5x threshold

### What Works Now
✅ Pages with "3-month supply" language automatically rejected (Phase 1)
✅ Amazon/eBay pages with "Subscribe & Save" still work (whitelisted in Phase 1)
✅ Bundle prices >2.5x marketplace automatically filtered (Phase 2)
✅ Normal brands with close prices NOT filtered (1.0x-2.0x kept)
✅ **Root brand now works WITHOUT hardcoding** (2.90x > 2.5x threshold)
✅ Two-layer defense: HTML text + price ratio
✅ **No brand-specific hardcoding required**
✅ Amazon always fetched to provide marketplace comparison

### Test Results
**Phase 1 Tests:**
- Bundle pages with "3-month supply": ✅ Rejected
- Amazon with "Subscribe & Save": ✅ Kept (whitelisted)
- Root pages: ❌ No strong signals found (only "subscription")

**Phase 2 Tests (2.5x threshold):**
- Normal brand (1.02x ratio): ✅ Kept
- Premium brand (2.0x ratio): ✅ Kept
- **Root Zero-In (2.90x ratio): ✅ Filtered → Amazon $77.60 → Final $69.84**
- Higher bundle (3.09x ratio): ✅ Filtered
- Threshold: 2.5x catches Root while preserving normal brands

**Phase 3 Tests:**
- Root Zero-In WITHOUT hardcoding: ✅ $69.84 (was $202.50 before)
- Amazon always fetched: ✅ Provides marketplace price for Phase 2 comparison
- Debug logs: ✅ Show 2 candidates (brand site + Amazon) before filtering

### Tradeoffs & Considerations
- **2.5x threshold**: Catches Root (2.90x) while keeping 2x premium brands
- **False positive risk**: Low - most normal brands are within 1-2x of marketplace
- **MLM detection**: Now works generically without hardcoding specific brands
- **Amazon dependency**: Relies on Amazon being available for comparison (acceptable tradeoff)
