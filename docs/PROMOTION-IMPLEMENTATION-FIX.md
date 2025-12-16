# Promotion Implementation Issue - Analysis & Fix

## Current State

### What's Working ✅
1. **Settings Storage** - User can enable/disable auto-promote in settings UI
2. **Promotion Data Storage** - Promotion settings (`autoPromote`, `autoPromoteAdRate`) are stored in offer's `merchantData`
3. **Marketing API Code Exists** - `src/lib/ebay-promote.ts` has `promoteSingleListing()` function that works
4. **Edit Draft Promo** - `ebay-update-draft-promo.ts` endpoint exists to update promotion settings

### What's NOT Working ❌
**The promotion is never actually applied** - the Marketing API is never called to create the promoted listing ad!

## Problem

When a draft is published via `create-ebay-draft-user.ts`:
1. ✅ Inventory item is created
2. ✅ Offer is created with `merchantData.autoPromote = true`
3. ❌ **Marketing API is NEVER called** to actually promote the listing
4. The listing exists but has NO active promotion

## Solution

### For Drafts (Inventory API Listings)

After creating/publishing an offer in `create-ebay-draft-user.ts`, we need to:

```typescript
// After offer is created successfully
if (group.promotion?.enabled) {
  try {
    console.log(`[create-ebay-draft-user] Applying promotion to ${mapped.sku}...`);
    
    const promoResult = await promoteSingleListing({
      tokenCache,
      userId: user.userId,
      ebayAccountId: undefined, // Uses default account
      inventoryReferenceId: mapped.sku,
      adRate: group.promotion.rate || 5,
      campaignIdOverride: undefined, // Auto-create campaign
    });
    
    console.log(`[create-ebay-draft-user] ✓ Promotion applied: campaign=${promoResult.campaignId}, enabled=${promoResult.enabled}`);
  } catch (err) {
    console.error(`[create-ebay-draft-user] ⚠️ Failed to promote ${mapped.sku}:`, err);
    // Don't fail the whole job - just log the error
  }
}
```

### For Active Listings (Trading API Listings)

For listings created directly on eBay (not through our Inventory API), we need to use the Trading API's `SetPromotionalSaleListings` or the Marketing API with `listingId`.

The key difference:
- **Inventory API listings**: Use SKU with `promoteSingleListing()`
- **Trading API listings**: Use listingId with Marketing API's `POST /sell/marketing/v1/ad_campaign/{campaignId}/ad` with `listingId` field

## Files to Modify

1. **`netlify/functions/create-ebay-draft-user.ts`**
   - Import `promoteSingleListing` from `src/lib/ebay-promote.ts`
   - After offer creation success, call `promoteSingleListing()` if promotion enabled

2. **`src/lib/ebay-promote.ts`**
   - Ensure `promoteSingleListing()` handles both SKU (for drafts) and listingId (for active listings)
   - Current implementation uses SKU - good for Inventory API
   - Need separate function for Trading API listings

3. **New endpoint needed: `netlify/functions/ebay-promote-active-listing.ts`**
   - Accept `{ listingId, adRate }` in body
   - Call Marketing API directly with listingId
   - Return promotion status

## Testing

1. **Drafts**: Create draft with promotion enabled → verify ad appears in eBay Seller Hub → Promoted Listings
2. **Active Listings**: Click "Promote" button on active listing → verify ad is created
3. **Settings**: Enable auto-promote in settings → create new draft → verify automatic promotion

## References

- Marketing API Docs: https://developer.ebay.com/api-docs/sell/marketing/overview.html
- Promoted Listings Guide: https://developer.ebay.com/api-docs/sell/static/marketing/pl-landing.html
- Current implementation: `src/lib/ebay-promote.ts` lines 816-950
