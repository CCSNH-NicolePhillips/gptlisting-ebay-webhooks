# Pricing Regression Analysis - January 2026

## Summary
After deploying crypto import fixes (commit 7461b50), pricing for ebay09 products is incorrect. All prices are lower than expected Amazon retail prices.

## Test Results (ebay09 folder)

### Expected vs Actual Prices

| Product | Expected (Amazon) | Actual Listed | Error | Root Cause |
|---------|------------------|---------------|-------|------------|
| **Root Sculpt** | $109.00 | $9.10 | -91% | Amazon rejected, used eBay sold |
| **JYM Pre-Workout** | $54.99 | $48.89 | -11% | Used RapidAPI, applied 10% discount |
| **Hermon Jock Itch** | $19.53 | $19.19 | -2% | Amazon rejected, used eBay sold + discount |
| **Prime Black Seed Oil** | $19.99 | $17.39 | -13% | Amazon rejected (bundle), used eBay sold + discount |
| **FÜM** | N/A | NOT FOUND | N/A | Brand was found! Extracted as "FÜM" |

## Root Causes Identified

### 1. Amazon Matching Too Strict

Amazon pages are being rejected with "missing key terms" errors:

```
[price] ⚠️ Amazon missing distinguishing terms: 7oz, preworkoutjuicyorange
[price] ❌ Amazon result rejected - missing key terms
```

**Example - Hermon Jock Itch:**
- Amazon URL found: `https://www.amazon.com/Hermon-Antifungal-Jock-Itch-Cream/dp/B0G18GS261`
- Price extracted: $19.95
- REJECTED: "missing key terms: 3.4floz, jockitchringworm"
- Fallback: eBay sold $13.34 (30% lower)
- Final: $11.81 after discount

**Example - Prime Natural Black Seed:**
- Amazon URL found: `https://www.amazon.com/PRIME-NATURAL-Organic-Black-Castor/dp/B0CS65MFPM`
- Price extracted: $39.99
- REJECTED: "bundle/multipack page"
- Fallback: eBay sold $16.99 (57% lower)
- Final: $14.89 after discount

### 2. Discount Applied to Final Prices

The AI is using `ALGO_COMPETITIVE_TOTAL` strategy with 10% discount:

```
[price] 🎯 PRICING EVIDENCE: retail=$54.99 | discount=10% | final=$43.49
[price] AI decision: source=brave-fallback base=$54.99 final=$43.49
```

**This means:**
- Even when correct price is found, 10% is subtracted
- JYM: $54.99 → $48.89 (should be $54.99)
- Prime: $19.99 → $17.39 (should be $19.99)

### 3. eBay Sold Preferred Over Amazon

When Amazon is rejected, AI chooses eBay sold prices which are often liquidation/wholesale:

```
[price] DEBUG: Price selection summary {
  candidates: [
    { source: 'ebay-sold', price: 13.34 },
    { source: 'brand-msrp', price: 21.99 }
  ]
}
[price] AI decision: source=ebay-sold base=$13.34 final=$6.01
```

eBay sold includes:
- Liquidation lots
- Used items
- Wholesale quantities
- Damaged box sales

These are NOT retail prices and shouldn't be used.

## Technical Details

### Changes That May Have Caused Regression

**Commit ba7a687** - "Extract and use Amazon product weight for eBay shipping calculations"
- Added weight extraction logic
- Modified `price-lookup.ts` lines 994, 1110, 1491-1494
- May have changed matching logic

**Commit 7461b50** - "Fix TypeScript build errors"
- Changed `node:crypto` to `crypto`
- Allowed stale code to finally deploy
- Previous good behavior may have been from old cached builds

### Code Locations

**Amazon matching validation:**
- `src/lib/price-lookup.ts:1107-1120` - Product match check
- Uses `extractDistinguishingTerms()` which creates strict token matching

**Discount application:**
- `src/lib/price-lookup.ts:668-820` - `decideFinalPrice()`
- Line 774-805: AI arbitration applies `computeEbayItemPrice()` with discount
- `src/lib/compute-ebay-price.ts` - Discount calculation

**eBay sold prioritization:**
- `src/lib/price-lookup.ts:828-845` - Fallback decision logic
- eBay sold is PRIORITY 1, Amazon is PRIORITY 2

## Recommended Fixes

### Fix 1: Relax Amazon Matching (CRITICAL)
Amazon products should match if:
- Brand matches
- Category matches
- Size is within 10% tolerance
- NOT reject for "missing key terms" on minor details

### Fix 2: Stop Applying Discount to Amazon Prices (CRITICAL)
When Amazon retail price is found:
- Use it directly without discount
- Amazon IS the competitive marketplace price
- Discount should only apply to brand MSRP

### Fix 3: Deprioritize eBay Sold Prices
eBay sold should be:
- Last resort, not first choice
- Used only for validation ("is price reasonable?")
- Never used if Amazon or brand MSRP available

### Fix 4: Add Regression Tests
Create test suite with known products:
- JYM Pre-Workout → must match $54.99
- Hermon Jock Itch → must match $19.53
- Prime Black Seed → must match $19.99
- Fail if prices drift >5% from Amazon

## Test Evidence

### Full Test Run Output
See: `ebay09-full-test.txt`

### Key Log Excerpts

**JYM - Correct Amazon found, but discounted:**
```
[Brave] Query: "JYM Pre-Workout Juicy Orange 31.7 oz" → 
  https://www.amazon.com/JYM-Supplement-Science-Pre-Workout-Nootropics/dp/B0DY8B7D7V
[HTML Parser] Extracted price: $54.99
[price] ✅ RapidAPI found: $54.99 (high confidence)
[price] ✅ Brand MSRP: $49.99
[price] AI decision: source=brave-fallback base=$54.99 final=$43.49
❌ WRONG: Should be $54.99, not $43.49
```

**Hermon - Amazon rejected, eBay chosen:**
```
[Brave] Amazon URL: .../Hermon-Antifungal-Jock-Itch-Cream/...
[HTML Parser] Price: $19.95
[price] ⚠️ Amazon missing distinguishing terms: 3.4floz
[price] ❌ Amazon result rejected
[ebay-sold] Found: $13.34 (median: $15.99)
[price] AI decision: source=ebay-sold base=$13.34 final=$11.81
❌ WRONG: Should use Amazon $19.53, not eBay $13.34
```

## Status
- ✅ Brand extraction working (FÜM found correctly)
- ✅ Vision AI classification working (12/12 images)
- ✅ Pairing working (6 pairs found)
- ❌ Amazon price matching broken
- ❌ Pricing strategy applying unwanted discount
- ❌ eBay sold prices preferred over Amazon retail

## Next Steps
1. Fix Amazon matching logic to be less strict
2. Remove discount application for Amazon marketplace prices
3. Change priority: Amazon > Brand MSRP > eBay sold (last resort)
4. Add regression test suite with gold standard prices
5. Re-test all ebay09 products
6. Validate against production data
