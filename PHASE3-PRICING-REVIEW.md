# Phase 3 Pricing Implementation in taxonomy-map.ts

## ⚠️ CRITICAL: DO NOT MOVE PRICING

**Pricing stays in `taxonomy-map.ts` — do NOT move it.**

The intended architecture is:
- ✅ **Single canonical pricing location**: `taxonomy-map.ts` computes `offer.price` once
- ✅ **`map-group-to-draft.ts`**: Only passes `userId` through to `mapGroupToDraftWithTaxonomy(group, userId)`
- ✅ **`create-ebay-draft-user.ts`**: Uses `draft.offer.price` as-is (no recompute)

This architecture ensures:
1. No double pricing
2. Single source of truth for pricing logic
3. Consistent pricing evidence logging
4. Easier testing and debugging

---

## Overview
The pricing computation has been consolidated into a **single canonical location** in `taxonomy-map.ts`. The old `extractPrice(group)` function has been completely replaced.

---

## 1. Imports (lines 1-6)

```typescript
import { buildItemSpecifics } from "./taxonomy-autofill.js";
import type { CategoryDef } from "./taxonomy-schema.js";
import { pickCategoryForGroup } from "./taxonomy-select.js";
import { computeEbayItemPriceCents } from "./pricing-compute.js";
import { getDefaultPricingSettings, type PricingSettings } from "./pricing-config.js";
import { tokensStore } from "./_blobs.js";
```

---

## 2. Function Signature (line 178)

```typescript
export async function mapGroupToDraftWithTaxonomy(group: Record<string, any>, userId?: string): Promise<TaxonomyMappedDraft>
```

**Note:** Added optional `userId` parameter to load user-specific pricing settings.

---

## 3. Load User Pricing Settings (lines 186-201)

```typescript
// PHASE 3: Load user pricing settings
let pricingSettings: PricingSettings = getDefaultPricingSettings();
if (userId) {
  try {
    const store = tokensStore();
    const settingsKey = `users/${userId}/settings.json`;
    const settingsBlob = await store.get(settingsKey);
    if (settingsBlob) {
      const settingsData = JSON.parse(settingsBlob);
      if (settingsData.pricing) {
        pricingSettings = { ...pricingSettings, ...settingsData.pricing };
      }
    }
  } catch (settingsErr) {
    console.warn(`[taxonomy-map] Failed to load user settings, using defaults:`, settingsErr);
  }
}
```

**What it does:**
- Starts with safe defaults from `getDefaultPricingSettings()`
- If `userId` is provided, loads user-specific settings from Netlify Blobs
- **Merge behavior (line 197)**: `{ ...pricingSettings, ...settingsData.pricing }`
  - User-specified fields override defaults
  - Unspecified fields preserve defaults
  - This is a **shallow merge** - correct for flat PricingSettings object
- Falls back to defaults on error (with warning log)

**Acceptance criteria:**
✅ When user settings exist, they override defaults  
✅ When they don't, defaults are used  
✅ No exceptions thrown if blob missing / invalid JSON  
✅ Partial user settings preserve unspecified defaults  

**Tests:** See `tests/lib/taxonomy-map-settings-merge.test.ts` for comprehensive merge validation

---

## 4. Extract Amazon Pricing Data (lines 203-227)

```typescript
// PHASE 3: Extract Amazon pricing data from group
const priceMeta = group.priceMeta as any;
let amazonItemPriceCents = 0;
let amazonShippingCents = 0;
let amazonShippingAssumedZero = true;

// Try to extract from priceMeta first (set by price-lookup.ts)
if (priceMeta?.chosenSource && priceMeta?.basePrice) {
  amazonItemPriceCents = Math.round(priceMeta.basePrice * 100);
  
  // Check if shipping data is available in candidates
  const chosenCandidate = priceMeta.candidates?.find((c: any) => c.source === priceMeta.chosenSource);
  if (chosenCandidate && typeof chosenCandidate.shippingCents === 'number') {
    amazonShippingCents = chosenCandidate.shippingCents;
    amazonShippingAssumedZero = false;
  }
} else {
  // Fallback: extract from legacy group.pricing.ebay or group.price
  const legacyPrice = Number(group?.pricing?.ebay ?? group?.price ?? 0);
  if (Number.isFinite(legacyPrice) && legacyPrice > 0) {
    amazonItemPriceCents = Math.round(legacyPrice * 100);
  } else {
    throw new Error("Group missing pricing data (no priceMeta and no legacy price)");
  }
}
```

**What it does:**
- **Primary path:** Extracts from `group.priceMeta` (set by `price-lookup.ts`)
  - Gets base item price from `priceMeta.basePrice`
  - Gets shipping cost from chosen candidate's `shippingCents` field
  - Tracks whether shipping was explicitly set or assumed zero
- **Fallback path:** Uses legacy `group.pricing.ebay` or `group.price` fields
  - Assumes free shipping in legacy mode
  - Throws error if no pricing data found at all

---

## 5. Compute eBay Offer Price (lines 230-237)

```typescript
// PHASE 3: Compute eBay offer price using Phase 2 function
const pricingResult = computeEbayItemPriceCents({
  amazonItemPriceCents,
  amazonShippingCents,
  settings: pricingSettings,
});

const price = pricingResult.ebayItemPriceCents / 100; // Convert cents to dollars
```

**What it does:**
- Calls the pure function `computeEbayItemPriceCents()` from `pricing-compute.ts`
- Passes extracted Amazon pricing data and user settings
- Converts result from cents to dollars for eBay API
- This is the **ONLY** place where offer.price is computed

---

## 6. Log PRICING_EVIDENCE (lines 240-252)

```typescript
// PHASE 3: Log PRICING_EVIDENCE (CRITICAL: Do not log tokens/PII)
console.log(`[taxonomy-map] PRICING_EVIDENCE for SKU ${sku}:`, {
  sku,
  amazonItemPriceCents,
  amazonShippingCents,
  amazonShippingAssumedZero,
  discountPercent: pricingSettings.discountPercent,
  shippingStrategy: pricingSettings.shippingStrategy,
  templateShippingEstimateCents: pricingSettings.templateShippingEstimateCents,
  targetDeliveredTotalCents: pricingResult.targetDeliveredTotalCents,
  ebayItemPriceCents: pricingResult.ebayItemPriceCents,
  shippingSubsidyAppliedCents: pricingResult.evidence.shippingSubsidyAppliedCents,
  finalOfferPriceDollars: price,
});
```

**What it does:**
- Logs comprehensive pricing evidence for debugging/auditing
- **Critical:** Does NOT log PII, user tokens, or sensitive data
- Shows all inputs and outputs of pricing computation
- Appears once per listing in production logs

**Example output:**
```
[taxonomy-map] PRICING_EVIDENCE for SKU TTmjav0k66liw: {
  sku: 'TTmjav0k66liw',
  amazonItemPriceCents: 5700,
  amazonShippingCents: 0,
  amazonShippingAssumedZero: false,
  discountPercent: 10,
  shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
  templateShippingEstimateCents: 600,
  targetDeliveredTotalCents: 5130,
  ebayItemPriceCents: 4530,
  shippingSubsidyAppliedCents: 600,
  finalOfferPriceDollars: 45.3
}
```

---

## 7. Set offer.price in Returned Object (lines 345-365)

```typescript
return {
  sku,
  inventory: {
    condition,
    product: {
      title,
      description,
      imageUrls: images,
      aspects,
    },
  },
  offer: {
    sku,
    marketplaceId,
    categoryId,
    price,  // <-- THE SINGLE CANONICAL PRICING VALUE
    quantity,
    condition: offerCondition,
    fulfillmentPolicyId,
    paymentPolicyId,
    returnPolicyId,
    merchantLocationKey,
    description,
  },
  _meta: {
    selectedCategory: matched ? { id: matched.id, slug: matched.slug, title: matched.title } : null,
    missingRequired,
    marketplaceId,
    categoryId,
    price,
  },
};
```

**What it does:**
- Sets `offer.price` to the computed value (line 349)
- This price flows to `create-ebay-draft-user.ts` unchanged
- Also sets `_meta.price` for reference/debugging

---

## Key Verification Points

✅ **Single pricing location:** `computeEbayItemPriceCents()` called ONLY in `taxonomy-map.ts` (line 232)

✅ **No double pricing:** `create-ebay-draft-user.ts` does NOT compute pricing anymore

✅ **No double pricing:** `map-group-to-draft.ts` does NOT compute pricing (only passes userId)

✅ **Evidence logging:** `PRICING_EVIDENCE` logged ONLY in `taxonomy-map.ts` (line 241)

✅ **Tests passing:** All 54 taxonomy-map tests passing with Phase 3 pricing

---

## Data Flow

```
1. price-lookup.ts → sets group.priceMeta { basePrice, candidates[] }
                  ↓
2. taxonomy-map.ts → extracts amazonItemPriceCents, amazonShippingCents
                  ↓
3. taxonomy-map.ts → loads user PricingSettings from Netlify Blobs
                  ↓
4. taxonomy-map.ts → calls computeEbayItemPriceCents()
                  ↓
5. taxonomy-map.ts → logs PRICING_EVIDENCE
                  ↓
6. taxonomy-map.ts → sets offer.price = ebayItemPriceCents / 100
                  ↓
7. create-ebay-draft-user.ts → uses draft.offer.price as-is (no modification)
                  ↓
8. eBay Inventory API → receives final offer.price
```

---

## Removed Code

The old `extractPrice(group)` function has been **completely removed** and replaced with the Phase 3 implementation above. There is no longer any code that:
- Directly reads `group.pricing.ebay` or `group.price` and uses it as final price
- Computes pricing outside of `taxonomy-map.ts`
- Modifies `offer.price` after `mapGroupToDraftWithTaxonomy()` returns

---

## Testing

Phase 3 pricing is validated by:
- **54 taxonomy-map tests** (all passing)
- **15 pricing-compute tests** (Phase 2 pure function tests)
- **20 pricing-config tests** (Phase 1 settings tests)
- **Integration test**: `tests/integration/create-ebay-draft-pricing.test.ts`

Example test scenarios:
- Amazon item $57, free shipping → eBay $45.30 (ALGO strategy with $6 subsidy)
- Amazon item $57, $5.99 shipping → eBay $50.69 (includes shipping in calculation)
- Minimum price floor: $1 item → eBay $1.99 (enforces minItemPriceCents)
- Legacy fallback: `group.price` → computed pricing (backward compatible)
