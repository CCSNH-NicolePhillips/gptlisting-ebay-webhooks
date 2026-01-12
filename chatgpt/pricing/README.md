# Pricing System - ChatGPT Reference

> Generated: January 5, 2026

## Last 10 Commits Analysis

### 1. `3248446` - fix(pricing): disable retail cap - was using wrong products (HEAD)
**Date:** Mon Jan 5, 2026  
**Files Changed:** `src/lib/delivered-pricing.ts`

**What Changed:**
- **Disabled the retail cap feature** in `calculateTargetDelivered()` function
- The retail cap was capping prices at 80% of the lowest retail price (Amazon/Walmart)
- **Problem:** Google Shopping was returning wrong products (different sizes, wrong products), causing incorrect retail caps that made listings uncompetitive
- The code is now commented out with a TODO to re-enable once title matching is improved

**Why It Matters:**
- Previously, if Google Shopping found a similar but different product at $20, our system would cap prices at $16 (80%), even if the actual product should sell for $30
- This was causing widespread underpricing

---

### 2. `a2a977d` - Add admin-set-ebay-token endpoint for restoring eBay connection
**Files Changed:** `netlify/functions/admin-set-ebay-token.ts` (new file)

**What Changed:**
- Added a new admin endpoint to manually set eBay refresh tokens
- Allows restoring eBay connection when OAuth flow is broken
- Secured with admin authentication

**Why It Matters:**
- Operations tool for recovering from eBay token issues without requiring full re-auth

---

### 3. `6ccde5e` - Fix orphan deletion - add forceAllowDeletion flag to bypass deleteInventory guard
**Files Changed:** `netlify/functions/ebay-clean-broken-drafts.ts`

**What Changed:**
- Added `forceAllowDeletion` flag to bypass the safety guard in `deleteInventory`
- The guard was preventing deletion of inventory items that had no offers (orphans)

---

### 4. `083e861` - Add force mode to orphan cleanup + extend timeout
**Files Changed:** `netlify.toml`, `netlify/functions/ebay-clean-broken-drafts.ts`

**What Changed:**
- Extended timeout to 60 seconds for orphan cleanup
- Added force mode that deletes inventory items even if they have no offers

---

### 5. `a3e0219` - Fix line formatting issue in ebay-clean-broken-drafts
**Files Changed:** `netlify/functions/ebay-clean-broken-drafts.ts`

**What Changed:**
- Fixed formatting/linting issues in the cleanup function

---

### 6. `c9d2de6` - Add orphan cleanup mode to delete inventory items with no offers
**Files Changed:** `netlify/functions/ebay-clean-broken-drafts.ts`

**What Changed:**
- Added new `orphans` mode to find and delete inventory items that exist but have no associated offers
- These "orphan" items clutter the inventory without being sellable

---

### 7. `38c10e7` - Add diagnostic logging for invalid SKU detection
**Files Changed:** `netlify/functions/ebay-list-offers.ts`

**What Changed:**
- Enhanced logging to help diagnose issues with SKU validation
- Helps track down why some offers fail to load

---

### 8. `cde1b87` - fix(quick-list): fix draft timeout and cache issues
**Files Changed:** `netlify.toml`, `public/quick-list.html`

**What Changed:**
- Extended timeout for quick-list drafts
- Fixed cache-related issues causing stale data to be shown

---

### 9. `4c3d40d` - fix(quick-list): auto-redirect to onboarding when Dropbox/eBay token expired
**Files Changed:** `public/quick-list.html`

**What Changed:**
- Added auto-redirect to onboarding flow when tokens are expired
- Improves user experience by guiding them to reconnect services

---

### 10. `296b6f4` - feat(pricing): DraftPilot pricing fix - unified offer split ⭐
**Date:** Sun Jan 4, 2026  
**Files Changed:** 11 files, +1168 lines

**This is the major pricing overhaul commit. Key changes:**

#### New Types & Functions
- **`EbayShippingMode`**: `'FREE_SHIPPING' | 'BUYER_PAYS_SHIPPING'`
- **`computeEbayOfferPricingCents()`**: Unified function for splitting delivered price into item + shipping
- **`formatPricingLogLine()`**: One-line debug logging for pricing decisions

#### Core Pricing Logic Fix
The main fix was **preventing double-counting of shipping**:

```typescript
// INVARIANT: itemPriceCents + shippingChargeCents === targetDeliveredTotalCents
// This must ALWAYS be true. No exceptions.

if (effectiveShippingMode === 'FREE_SHIPPING') {
  shippingChargeCents = 0;
  itemPriceCents = targetDeliveredTotalCents;
} else {
  shippingChargeCents = settings.buyerShippingChargeCents;
  itemPriceCents = targetDeliveredTotalCents - shippingChargeCents;
}
```

#### Auto-Switch to Free Shipping
When item price would fall below minimum ($1.99), the system now auto-switches to free shipping:
```typescript
if (itemPriceCents < settings.minItemPriceCents) {
  if (settings.allowAutoFreeShippingOnLowPrice) {
    effectiveShippingMode = 'FREE_SHIPPING';
    shippingChargeCents = 0;
    itemPriceCents = baseDeliveredTargetCents;
    warnings.push('autoSwitchedToFreeShipping');
  }
}
```

#### Title Matching in Google Shopping
Added title matching to prevent using wrong product prices:
```typescript
const isTitleMatch = (resultTitle: string, searchQuery: string): boolean => {
  // Requires 70% of query words to match
  const matchRatio = matchCount / queryWords.length;
  return matchRatio >= 0.7;
};
```

#### Retail Cap (Now Disabled in 3248446)
Originally added 80% retail cap, but disabled in the latest commit due to wrong product matches.

#### Weight Estimation Improvements
- Enhanced `netWeight` extraction with fallback to title parsing
- Added weight estimation prompts in pairing-v2-core

#### Tests
- Added 23 new tests for pricing-offer-split scenarios
- All 3417 tests pass

---

## File Descriptions

### Core Pricing Files

| File | Purpose |
|------|---------|
| `pricing-compute.ts` | **Central pricing engine**. Contains `computeEbayItemPrice()`, `computeEbayOfferPricingCents()`, `getFinalEbayPrice()`. All eBay item price calculations flow through here. |
| `pricing-config.ts` | **Pricing settings schema**. Defines `PricingSettings`, `EbayShippingMode`, `ShippingStrategy`. User-configurable settings stored per user. |
| `delivered-pricing.ts` | **Delivered-price-first engine**. Prices to "total to door" then backs into item + shipping. Uses Google Shopping for comps. Main function: `getDeliveredPricing()`. |
| `pricing-split.ts` | **Legacy split logic**. Splits eBay target total into item + shipping. Mostly replaced by `computeEbayOfferPricingCents()` but kept for backward compatibility. |
| `price-formula.ts` | **Simple 10% discount formula**. `applyPricingFormula()` - minimal logic, deprecated in favor of new system. |
| `price-lookup.ts` | **Tiered price lookup**. Fetches prices from multiple sources: eBay Sold → Amazon → Brand MSRP → RapidAPI. Contains extensive validation logic. |

### Data Source Files

| File | Purpose |
|------|---------|
| `google-shopping-search.ts` | **Google Shopping API** via SearchAPI.io. Returns structured pricing from Amazon, Walmart, Target, eBay. ~$0.01/search. |
| `ebay-sold-prices.ts` | **eBay sold/completed items**. Fetches sold price statistics for competitive pricing. Uses SearchAPI.io to scrape eBay. |
| `shipping-estimates.ts` | **Shipping cost estimation**. Category-based, size-heuristic, or comp-based shipping estimates. |

### Utility Files

| File | Purpose |
|------|---------|
| `utils-pricing.ts` | **Legacy wrapper**. Simple wrapper that calls `getFinalEbayPrice()`. Deprecated. |

---

## Pricing Architecture Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    PRICING PIPELINE                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. PRODUCT IDENTITY (Vision API)                               │
│     └── pairing-v2-core.ts extracts:                            │
│         brand, productName, netWeight, keyText                   │
│                                                                  │
│  2. PRICE LOOKUP (price-lookup.ts)                              │
│     └── Tiered: eBay Sold → Amazon → RapidAPI → Brand MSRP     │
│                                                                  │
│  3. DELIVERED PRICING (delivered-pricing.ts)                    │
│     └── getDeliveredPricing() → target delivered price          │
│     └── Uses Google Shopping for comps                          │
│                                                                  │
│  4. OFFER SPLIT (pricing-compute.ts)                            │
│     └── computeEbayOfferPricingCents()                          │
│     └── Splits: targetDelivered → itemPrice + shippingCharge    │
│     └── INVARIANT: item + shipping = delivered (always)         │
│                                                                  │
│  5. TAXONOMY MAP (taxonomy-map.ts)                              │
│     └── mapGroupToDraftWithTaxonomy() - SINGLE WRITER           │
│     └── Sets offer.price ONCE, never modified downstream        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Key Concepts

### Shipping Terminology (CRITICAL)
```typescript
// shippingChargeCents = what BUYER pays for shipping (0 if free shipping)
// shippingCostEstimateCents = what WE expect to pay the carrier
// targetDeliveredTotalCents = what buyer pays TOTAL (item + shippingCharge)
```

### Shipping Modes
- **FREE_SHIPPING**: Buyer pays $0 shipping. Item price = full delivered total.
- **BUYER_PAYS_SHIPPING**: Buyer pays item + shipping separately.

### Strategies
- **ALGO_COMPETITIVE_TOTAL**: Discount Amazon total-to-door, then split
- **DISCOUNT_ITEM_ONLY**: Discount item price only, ignore shipping

### Default Settings
```typescript
{
  discountPercent: 10,              // 10% off Amazon
  shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
  templateShippingEstimateCents: 600,  // $6.00
  minItemPriceCents: 199,           // $1.99 floor
  ebayShippingMode: 'BUYER_PAYS_SHIPPING',
  buyerShippingChargeCents: 600,    // $6.00
  allowAutoFreeShippingOnLowPrice: true,
}
```

## Known Issues / TODOs

1. **Retail Cap Disabled**: The 80% retail cap was causing bad prices because Google Shopping returns wrong products. Need better title matching.

2. **UPC Not Used**: `PriceLookupInput.upc` exists but is never passed to Amazon search. Would be near-perfect product matching.

3. **60% Match Threshold Too Lenient**: `amazonMatchesProductTerms` uses 60% match ratio which can allow mismatches like "5 Billion CFU" vs "50 Billion CFU".

---

## See Also

- [PRICING-ARCHITECTURE-ANALYSIS.md](./PRICING-ARCHITECTURE-ANALYSIS.md) - Deep dive into architecture
- [PRICING-OVERHAUL.md](./PRICING-OVERHAUL.md) - Phase 1-4 implementation plan
- [PRICING-IMPROVEMENT-PRIORITY.md](./PRICING-IMPROVEMENT-PRIORITY.md) - Priority analysis
- [docs-pricing.md](./docs-pricing.md) - Main pricing documentation
