# Competitive Pricing Implementation — Complete

## Overview
User-configurable competitive pricing system with two strategies:
1. **DISCOUNT_ITEM_ONLY**: Simple discount on item price only
2. **ALGO_COMPETITIVE_TOTAL**: Advanced algorithm accounting for competitor shipping

## Architecture

### Phase 1: Backend Settings Infrastructure ✅
**Files Modified:**
- `src/lib/pricing-config.ts`: PricingSettings interface + defaults
- `netlify/functions/user-settings-get.ts`: Returns pricing with defaults
- `netlify/functions/user-settings-save.ts`: Validates + persists pricing
- `tests/lib/pricing-config.test.ts`: 17 tests

**Storage:**
- Netlify Blobs: `users/{userId}/settings.json`
- Schema: `{ pricing: { discountPercent, shippingStrategy, templateShippingEstimateCents, shippingSubsidyCapCents } }`

**Defaults:**
```typescript
{
  discountPercent: 10,
  shippingStrategy: 'DISCOUNT_ITEM_ONLY',
  templateShippingEstimateCents: 600, // $6.00
  shippingSubsidyCapCents: null
}
```

### Phase 2: Pure Pricing Function ✅
**Files Modified:**
- `src/lib/pricing-compute.ts`: `computeEbayItemPrice()` function
- `tests/lib/pricing-compute.test.ts`: 18 tests

**Function Signature:**
```typescript
function computeEbayItemPrice(input: {
  retailSourceCents: number;
  shippingCostCents: number;
  pricingSettings: PricingSettings;
  photoQuantity?: number;
  amazonPackSize?: number;
}): { priceCents: number; evidence: PricingEvidence }
```

**Test Coverage:**
- Amazon $57 free shipping → $45.30 (ALGO strategy, 10% discount, $6 template)
- Amazon $57 + $5.99 → $50.69 (ALGO strategy, 10% discount, $6 template)
- Amazon $57 + $5.99 → $51.30 (ITEM_ONLY strategy, 10% discount)
- Photo quantity multiplication
- Amazon pack size division
- Rounding to cents

### Phase 3: Pipeline Integration ✅
**Files Modified:**
- `src/lib/price-lookup.ts`: Single call site for pricing computation
- `netlify/functions/smartdrafts-create-drafts-background.ts`: Loads settings, passes through pipeline

**Key Changes:**
- Removed all scattered `* 0.9` discount math (10+ occurrences)
- Replaced with single `computeEbayItemPrice()` call in `price-lookup.ts`
- Settings loaded once per job at start
- Evidence logging shows all calculation steps

**Evidence Fields:**
```typescript
{
  retailSourceCents: number;
  shippingCostCents: number;
  strategy: 'ALGO_COMPETITIVE_TOTAL' | 'DISCOUNT_ITEM_ONLY';
  discountPercent: number;
  templateShippingEstimateCents: number;
  finalPriceCents: number;
  photoQuantity?: number;
  amazonPackSize?: number;
}
```

### Phase 4: UI Implementation ✅
**Files Modified:**
- `public/settings.html`: Added pricing settings card + JavaScript

**UI Controls:**
- Discount percentage input (0-50%, default 10%)
- Strategy radio buttons:
  - "Item-Only Discount" (DISCOUNT_ITEM_ONLY)
  - "Total-Competitive Algorithm" (ALGO_COMPETITIVE_TOTAL)
- Template shipping estimate (dollars, default $6.00)
- Optional shipping subsidy cap (dollars, nullable)
- Save button with success/error messages

**JavaScript Features:**
- Load settings on page load from `/.netlify/functions/user-settings-get`
- Convert cents ↔ dollars for display
- Validate inputs before save
- POST to `/.netlify/functions/user-settings-save`
- Status messages (success/error)

## Acceptance Criteria — All Met ✅

### Phase 1 ✅
- [x] Settings stored in blob with proper schema
- [x] Defaults applied via nullish coalescing
- [x] user-settings-get returns pricing object
- [x] user-settings-save validates all fields

### Phase 2 ✅
- [x] Pure function with no side effects
- [x] Amazon $57 free shipping → $45.30 (ALGO)
- [x] Amazon $57 + $5.99 → $50.69 (ALGO)
- [x] Amazon $57 + $5.99 → $51.30 (ITEM_ONLY)
- [x] Evidence tracking for transparency
- [x] 18 passing tests

### Phase 3 ✅
- [x] Offer params price comes from new function
- [x] No other pricing math remains in pipeline
- [x] Settings loaded from blob storage
- [x] Single call site in price-lookup.ts

### Phase 4 ✅
- [x] Settings persist across sessions
- [x] Switching strategy changes price output deterministically
- [x] Validation prevents invalid inputs
- [x] UI follows existing settings page patterns

## Usage Example

### User Workflow
1. Navigate to Settings → Competitive Pricing
2. Set discount: 15%
3. Select strategy: Total-Competitive Algorithm
4. Set template shipping: $7.50
5. Set subsidy cap: $3.00
6. Click "Save pricing settings"
7. Create drafts → prices calculated with new settings

### Developer Workflow
```typescript
// In smartdrafts-create-drafts-background.ts
const settings = await getUserSettings(userId);
const pricingSettings = getPricingSettings(settings);

// In price-lookup.ts
const { priceCents, evidence } = computeEbayItemPrice({
  retailSourceCents: 5700,
  shippingCostCents: 599,
  pricingSettings,
  photoQuantity: 1,
  amazonPackSize: 1
});

console.log('Pricing evidence:', evidence);
// { strategy: 'ALGO_COMPETITIVE_TOTAL', finalPriceCents: 5069, ... }
```

## Testing

### Unit Tests
```bash
npm test pricing-config  # 17 tests, 100% coverage
npm test pricing-compute # 18 tests, 83% coverage
```

### Manual Testing
See `_pricing_triage_dump/phase4-acceptance-test.md` for test plan

### Local Development
```bash
netlify dev  # Start local server
# Navigate to http://localhost:8888/settings.html
# Test pricing settings UI
```

## Files Modified (Summary)

**Backend (Phases 1-3):**
- `src/lib/pricing-config.ts` (new)
- `src/lib/pricing-compute.ts` (new)
- `src/lib/price-lookup.ts` (modified)
- `netlify/functions/user-settings-get.ts` (modified)
- `netlify/functions/user-settings-save.ts` (modified)
- `netlify/functions/smartdrafts-create-drafts-background.ts` (modified)

**Frontend (Phase 4):**
- `public/settings.html` (modified)

**Tests:**
- `tests/lib/pricing-config.test.ts` (new)
- `tests/lib/pricing-compute.test.ts` (new)

**Documentation:**
- `_pricing_triage_dump/phase1-implementation-notes.md`
- `_pricing_triage_dump/phase2-implementation-notes.md`
- `_pricing_triage_dump/phase3-integration-notes.md`
- `_pricing_triage_dump/phase4-acceptance-test.md`
- `_pricing_triage_dump/COMPLETE-SUMMARY.md` (this file)

## Maintenance Notes

### Adding New Strategies
1. Add to `ShippingStrategy` enum in `pricing-config.ts`
2. Implement logic in `computeEbayItemPrice()` switch statement
3. Add tests in `pricing-compute.test.ts`
4. Add radio button in `settings.html`

### Changing Defaults
Update `getDefaultPricingSettings()` in `pricing-config.ts`

### Debugging Pricing Issues
1. Check evidence logs in draft creation job output
2. Verify settings in Netlify Blobs: `users/{userId}/settings.json`
3. Run unit tests: `npm test pricing-compute`
4. Check AC scenarios match expected outputs

## Known Limitations
- Subsidy cap not yet implemented in ALGO strategy (placeholder for future)
- UI does not show real-time price preview (requires separate calculator tool)
- Settings apply globally to all items (no per-category overrides)

## Future Enhancements
- Real-time price calculator on settings page
- Per-category pricing overrides
- Historical pricing analytics
- Competitor price monitoring
- Dynamic discount suggestions based on market data
