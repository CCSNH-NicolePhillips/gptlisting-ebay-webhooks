# Phase 4 — UI Acceptance Test

## ✅ Acceptance Criteria
1. **Settings persist**: User can save pricing settings and they persist across sessions
2. **Switching strategy changes price output deterministically**: Changing strategy radio button affects final price calculation

## Test Plan

### Test 1: Settings Persist
**Steps:**
1. Open `public/settings.html` in browser (via `netlify dev`)
2. Navigate to "💰 Competitive Pricing" card
3. Set values:
   - Discount Percentage: 15%
   - Strategy: Total-Competitive Algorithm (radio button)
   - Template Shipping Estimate: $7.50
   - Shipping Subsidy Cap: $3.00
4. Click "Save pricing settings"
5. Verify success message appears
6. Refresh the page
7. Verify all values are still set correctly

**Expected Result:** All settings persist after page refresh

### Test 2: Strategy Toggle Changes Price Output
**Pre-requisite:** Run a draft creation job with pricing settings

**Scenario A: Item-Only Discount**
- Settings: 10% discount, DISCOUNT_ITEM_ONLY strategy, $6 shipping
- Input: Amazon $57 + $5.99 shipping
- Expected: eBay price = $51.30 (discount applied to item only, shipping ignored)
- Evidence: `"strategy":"DISCOUNT_ITEM_ONLY"` in logs

**Scenario B: Total-Competitive Algorithm**
- Settings: 10% discount, ALGO_COMPETITIVE_TOTAL strategy, $6 shipping
- Input: Amazon $57 + $5.99 shipping
- Expected: eBay price = $50.69 (discount applied to total, shipping subtracted)
- Evidence: `"strategy":"ALGO_COMPETITIVE_TOTAL"` in logs

**Verification Method:**
1. Check job logs in `netlify/functions/smartdrafts-create-drafts-background.ts`
2. Look for pricing evidence containing `retailSourceCents`, `shippingCostCents`, `strategy`, `finalPriceCents`
3. Verify final price matches expected calculation

### Test 3: Validation Works
**Steps:**
1. Try to save with discount > 50% → should show error
2. Try to save with negative shipping estimate → should show error
3. Try to save without selecting strategy → should show error
4. Save with valid values → should succeed

**Expected Result:** All invalid inputs rejected with clear error messages

## Implementation Checklist

### HTML Form Controls ✅
- [x] Discount percentage input (0-50 range)
- [x] Two radio buttons for strategy selection
- [x] Template shipping estimate input (dollars)
- [x] Optional shipping subsidy cap input
- [x] Save button
- [x] Status message display

### JavaScript Load Logic ✅
- [x] Fetch settings from `/.netlify/functions/user-settings-get`
- [x] Populate discount percentage field
- [x] Set correct radio button based on strategy
- [x] Convert cents to dollars for shipping inputs
- [x] Handle nullable subsidy cap (leave empty if null)

### JavaScript Save Logic ✅
- [x] Validate discount 0-50%
- [x] Validate strategy radio selected
- [x] Validate shipping estimate >= 0
- [x] Convert dollars to cents for API
- [x] Handle nullable subsidy cap (null if empty)
- [x] POST to `/.netlify/functions/user-settings-save` with pricing object
- [x] Show success/error messages

### Backend Integration ✅
- [x] `user-settings-get.ts` returns pricing settings with defaults
- [x] `user-settings-save.ts` validates and persists pricing settings
- [x] `smartdrafts-create-drafts-background.ts` loads settings from blob
- [x] `price-lookup.ts` uses settings in pricing computation

## Manual Test Results

_To be filled in during manual testing_

**Test 1 (Persistence):** [ ] PASS / [ ] FAIL
- Notes:

**Test 2 (Strategy Toggle):** [ ] PASS / [ ] FAIL
- Notes:

**Test 3 (Validation):** [ ] PASS / [ ] FAIL
- Notes:

## Notes
- Settings stored in Netlify Blobs at `users/{userId}/settings.json`
- Pricing settings nested under `pricing` key
- Backend validates all values on save
- Frontend validation matches backend constraints
- Strategy change deterministically affects `computeEbayItemPrice` output
