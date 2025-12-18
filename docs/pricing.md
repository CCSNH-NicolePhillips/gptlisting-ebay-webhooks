# Pricing Architecture

## Single Canonical Location

**Pricing is computed ONLY in `src/lib/taxonomy-map.ts`.**

The `mapGroupToDraftWithTaxonomy()` function is the single writer for `offer.price`. All pricing logic flows through:

1. **Extract Amazon data** → `amazonItemPriceCents`, `amazonShippingCents` from `group.priceMeta`
2. **Load user settings** → Merge user-specific `PricingSettings` with defaults from Netlify Blobs
3. **Compute price** → Call `computeEbayItemPriceCents()` pure function from `pricing-compute.ts`
4. **Log evidence** → `PRICING_EVIDENCE` console output for debugging
5. **Return draft** → Set `offer.price` once, never modified downstream

## Protected by Tests

Any changes to pricing must maintain these invariants:

- **Settings merge tests** (`tests/lib/taxonomy-map-settings-merge.test.ts`): Validates user settings override defaults correctly
- **Pricing wiring tests** (`tests/lib/taxonomy-map-settings-merge.test.ts`): Validates pricing compute integration with different strategies
- **Guardrail test** (`tests/lib/pricing-guardrail.test.ts`): Asserts `computeEbayItemPriceCents()` is called ONLY from `taxonomy-map.ts`

If the guardrail test fails, **you have introduced double pricing** — revert immediately.

## Architecture Benefits

✅ **No double pricing** → Single source of truth prevents price divergence bugs  
✅ **Testable** → Pure function `computeEbayItemPriceCents()` has 100% branch coverage  
✅ **Observable** → `PRICING_EVIDENCE` logs show exact inputs/outputs for every listing  
✅ **User-configurable** → Settings merge allows per-user pricing strategies  

## Related Documentation

- Phase 3 implementation details: `PHASE3-PRICING-REVIEW.md`
- Phase 2 pure function: `src/lib/pricing-compute.ts` (see JSDoc)
- Phase 1 settings schema: `src/lib/pricing-config.ts` (see `PricingSettings` type)
