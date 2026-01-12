# DraftPilot Pricing System — Technical Overview

## Core Concept: Delivered-Price-First

We price **backwards from the delivered price** (what the buyer pays total), not forward from cost. The system finds competitive market prices, then splits that total into item + shipping for eBay.

---

## Key Definitions

| Term | Meaning |
|------|---------|
| **targetDeliveredCents** | The total price we want the buyer to pay (item + shipping shown on eBay). Calculated from market comps. |
| **buyerShippingChargeCents** | The shipping amount shown to the buyer on eBay. This is `settings.shippingEstimateCents`. |
| **carrierShippingCostEstimateCents** | What WE estimate we pay the carrier (USPS/UPS). Used for margin calculations ONLY. **Never affects the buyer-facing split.** |
| **minItemCents** | Minimum allowed item price ($4.99 default). Prevents $0.01 items. |

---

## The Split Algorithm

Given a target delivered price, we split it into item + shipping:

### Step 1: Try Normal Split (Buyer Pays Shipping)
```
rawItemCents = targetDeliveredCents - buyerShippingChargeCents
```

**If rawItemCents >= minItemCents:** ✅ Use normal split
- `finalItemCents = rawItemCents`
- `finalShipCents = buyerShippingChargeCents`
- `canCompete = true`

**Example A — Normal Split Works:**
```
Target Delivered: $20.38
Buyer Shipping:   $6.00
Min Item:         $4.99

rawItem = $20.38 - $6.00 = $14.38
$14.38 >= $4.99? YES ✓

Result: Item = $14.38, Ship = $6.00, Total = $20.38, canCompete = true
```

---

### Step 2: If rawItem < minItem, Try Free Shipping Fallback

When the naive split would push item below the floor, we can flip to FREE_SHIPPING mode (if enabled):

**Conditions for auto-free-shipping:**
1. `allowFreeShippingWhenNeeded = true`
2. Subsidy needed ≤ `freeShippingMaxSubsidyCents`
3. `targetDeliveredCents >= minItemCents`

**If all conditions met:** ✅ Use free shipping
- `finalItemCents = targetDeliveredCents`
- `finalShipCents = 0`
- `canCompete = true`
- Warning: `autoFreeShippingOnLowPrice`

**Example B — Free Shipping Fallback Saves It:**
```
Target Delivered: $9.00
Buyer Shipping:   $6.00
Min Item:         $4.99
Max Subsidy:      $6.00

rawItem = $9.00 - $6.00 = $3.00
$3.00 >= $4.99? NO ✗

Try free shipping:
  Subsidy needed: $6.00 ≤ max $6.00? YES
  Item would be: $9.00 >= $4.99? YES

Result: Item = $9.00, Ship = $0, Total = $9.00, canCompete = true
Warning: autoFreeShippingOnLowPrice
```

---

### Step 3: Cannot Compete

If free shipping fallback isn't possible (disabled, subsidy too high, or target below min), we **cannot match market price**:

- `finalItemCents = minItemCents` (clamped)
- `finalShipCents = buyerShippingChargeCents` (or 0 if free ship within cap)
- `canCompete = false`
- Warnings: `minItemFloorHit`, `cannotCompete`

**Example C — Cannot Compete:**
```
Target Delivered: $9.00
Buyer Shipping:   $6.00
Min Item:         $4.99
Free Ship:        DISABLED

rawItem = $9.00 - $6.00 = $3.00
$3.00 >= $4.99? NO ✗

Free shipping fallback disabled.

Result: Item = $4.99, Ship = $6.00, Total = $10.99, canCompete = FALSE
(We're $1.99 overpriced vs market)
```

---

## The Critical Invariant

```
When canCompete = true:
  finalItemCents + finalShipCents === targetDeliveredCents  (ALWAYS)

When canCompete = false:
  finalItemCents + finalShipCents > targetDeliveredCents  (we're overpriced)
```

This invariant is enforced in the code and tested.

---

## Shipping Mode Summary

| Mode | What Buyer Sees | What Happens |
|------|-----------------|--------------|
| **BUYER_PAYS_SHIPPING** | Item price + shipping charge | `item = target - ship`, normal split |
| **FREE_SHIPPING** | Item price only, "Free shipping" badge | `item = target`, `ship = 0`, seller absorbs carrier cost |
| **Auto Fallback** | Flips BUYER→FREE when low-price item would violate min | Adds warning `autoFreeShippingOnLowPrice` |

---

## What We DON'T Do (Anti-patterns)

❌ **Never** use `carrierShippingCostEstimateCents` for the buyer-facing split  
❌ **Never** silently clamp without setting `canCompete = false`  
❌ **Never** violate the invariant when `canCompete = true`  

---

## Real Example from Testing

**Product:** OGX Bond Protein Repair 3-in-1 Oil Mist

| Source | Found Price |
|--------|-------------|
| Google Shopping (eBay) | $9.99 delivered |
| Google Shopping (Walmart) | $23.97 delivered |
| eBay Sold Median | $18.59 delivered |

**Target Delivered:** $18.59 (from sold median, strong data)  
**Buyer Shipping:** $6.00 (from category estimate)  

**Split:**
```
rawItem = $18.59 - $6.00 = $12.59
$12.59 >= $4.99? YES ✓

Final: Item = $12.59, Ship = $6.00, Total = $18.59, canCompete = true
```

---

## Low Price Mode Options

When `canCompete = false`, the system behavior depends on `lowPriceMode`:

| Mode | Behavior |
|------|----------|
| `FLAG_ONLY` | Create listing with warning (current default) |
| `AUTO_SKIP` | Don't create listing, return `skipListing = true` |
| `ALLOW_ANYWAY` | Create listing even if overpriced |

---

## Code Location

The split logic lives in:
- **File:** `src/lib/delivered-pricing.ts`
- **Function:** `splitDeliveredPrice()`
- **Tests:** `tests/lib/delivered-pricing.test.ts`

---

*Document generated: January 6, 2026*
