# Active Listing Promotion Update - Debug Documentation

## Problem
When trying to update promotion (ad rate) on active eBay listings, getting 401 "Invalid access token" errors from eBay Marketing API.

## Recent Fix Attempt
We fixed `getEbayAccessToken()` in `src/lib/ebay-auth.ts` to explicitly request the `sell.marketing` scope when refreshing tokens. This was committed on Dec 12, 2024.

However, the 401 errors persist even after this fix.

## Error Log
```
Dec 12, 10:43:52 AM: 5f1928a2 INFO   [ebay-update-active-promo] Request received
Dec 12, 10:43:52 AM: 5f1928a2 INFO   [ebay-update-active-promo] Input: {
  listingId: '177667962775',
  offerId: '177667962775',
  sku: 'NSDBF6VCmj221yfrce2',
  adRate: 5
}
Dec 12, 10:43:52 AM: 5f1928a2 INFO   [ebay-update-active-promo] Using campaign: 151310691012
Dec 12, 10:43:53 AM: 5f1928a2 ERROR  [ebay-update-active-promo] Error: Error: Failed to get ads 401: {
  "errors": [
    {
      "errorId": 1001,
      "domain": "OAuth",
      "category": "REQUEST",
      "message": "Invalid access token",
      "longMessage": "Invalid access token. Check the value of the Authorization HTTP request header."
    }
  ]
}
```

## Call Chain
1. **User Action**: Update promotion ad rate from Active Listings page
2. **Frontend**: Calls `/.netlify/functions/ebay-update-active-promo`
3. **ebay-update-active-promo.ts**: 
   - Gets user's eBay refresh token from Netlify Blobs
   - Calls `getCampaigns()` from `ebay-promote.ts`
   - Calls `getAds()` from `ebay-promote.ts` ❌ **FAILS HERE WITH 401**
4. **ebay-promote.ts `getAds()`**:
   - Calls `getEbayAccessToken(userId)` from `ebay-auth.ts`
   - Makes GET request to `/sell/marketing/v1/ad_campaign/{campaignId}/ad`
5. **ebay-auth.ts `getEbayAccessToken()`**:
   - Retrieves user's refresh token from Netlify Blobs
   - Calls `accessTokenFromRefresh()` with all 5 scopes including `sell.marketing`

## Key Files

### 1. netlify/functions/ebay-update-active-promo.ts
- Entry point for promotion updates from frontend
- Authenticates user via Auth0 JWT
- Gets eBay refresh token from Netlify Blobs
- Calls helper functions from `ebay-promote.ts`

### 2. src/lib/ebay-promote.ts
- Contains `getCampaigns()`, `getAds()`, `createAds()`, `updateAdRate()`
- All functions call `getEbayAccessToken(userId)` to get access token
- Makes Marketing API requests to eBay

### 3. src/lib/ebay-auth.ts
- Contains `getEbayAccessToken(userId)` - **RECENTLY FIXED**
- Now explicitly requests all 5 scopes including `sell.marketing`
- Returns access token and API host

## What We've Tried
1. ✅ Fixed environment variable (changed from `EBAY_ENV` to `NODE_ENV` for REST APIs)
2. ✅ Removed non-existent `adStatus` field check
3. ✅ Added `sell.marketing` scope to `getEbayAccessToken()` token refresh
4. ❌ Still getting 401 errors on Marketing API calls

## Possible Issues
1. **Stale Deployment**: The fix to `ebay-auth.ts` may not be deployed yet on Netlify
2. **Token Cache**: User's refresh token may have been created without `sell.marketing` scope
3. **Scope Mismatch**: User may need to disconnect and reconnect eBay to get new refresh token with marketing scope
4. **Environment Difference**: May be calling sandbox when production is expected, or vice versa

## Next Steps
1. **Verify deployment**: Check if the latest commit (de7c978) with the token scope fix is deployed
2. **Check user's refresh token**: Verify which scopes are actually in the user's stored refresh token
3. **Force token refresh**: May need user to disconnect/reconnect eBay to get new refresh token with marketing scope
4. **Add more logging**: Log the actual access token scopes being requested and received

## Related Documentation
- eBay Marketing API: https://developer.ebay.com/api-docs/sell/marketing/overview.html
- OAuth Scopes: https://developer.ebay.com/api-docs/static/oauth-scopes.html
- Commit with token fix: de7c978 (Dec 12, 2024)
