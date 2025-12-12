# Active Listing Promotion Update - Debug Documentation

## Problem
When trying to update promotion (ad rate) on active eBay listings, getting 401 "Invalid access token" errors from eBay Marketing API.

## Fix Attempts

### Fix #1 - Added Marketing Scope (Commit: de7c978)
Fixed `getEbayAccessToken()` in `src/lib/ebay-auth.ts` to explicitly request the `sell.marketing` scope when refreshing tokens.
**Result**: Still getting 401 errors

### Fix #2 - Fixed Token Destructuring (Commit: 3ab65b6)
**ROOT CAUSE IDENTIFIED**: `getEbayAccessToken()` returns `{token, apiHost}` object, but code was using it as a string.
- This caused `Authorization: Bearer [object Object]` header
- Fixed all Marketing API functions to use `const { token } = await getEbayAccessToken(userId)`
- Fixed `updateAdRate` endpoint from `/ad/{adId}` to `/ad/{adId}/bid`
- Aligned `getMarketingApiHost()` to use `EBAY_ENV` instead of `NODE_ENV`
**Result**: STILL getting 401 errors after deployment

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
1. **Deployment not live yet**: The fix to destructure token may not be deployed on Netlify yet
2. **Stale refresh token**: User's stored refresh token may predate the marketing scope addition
3. **Token refresh not working**: `accessTokenFromRefresh()` may not be requesting scopes correctly
4. **Environment mismatch**: EBAY_ENV may be pointing to wrong environment (sandbox vs production)

## Key Files Provided

### 1. netlify/functions/ebay-update-active-promo.ts
- Entry point for promotion updates from frontend
- Authenticates user via Auth0 JWT
- Gets eBay refresh token from Netlify Blobs
- Calls helper functions from `ebay-promote.ts`

### 2. src/lib/ebay-promote.ts
- Contains `getCampaigns()`, `getAds()`, `createAds()`, `updateAdRate()`
- All functions call `getEbayAccessToken(userId)` to get access token
- **FIXED**: Now destructures `{token}` from return value
- Makes Marketing API requests to eBay

### 3. src/lib/ebay-auth.ts
- Contains `getEbayAccessToken(userId)` - **RETURNS OBJECT NOT STRING**
- Returns `{token: string, apiHost: string}`
- Explicitly requests all 5 scopes including `sell.marketing`

### 4. src/lib/_common.ts (NEW - NEEDED FOR DIAGNOSIS)
- Contains `accessTokenFromRefresh()` function
- This is what actually calls eBay's OAuth endpoint
- Takes `refreshToken` and optional `scopes` array
- Returns `{access_token, expires_in}`

## What We Need to Check
1. Is `accessTokenFromRefresh()` being called correctly with scopes?
2. Is the refresh token itself valid and has marketing scope?
3. Is the deployment actually live on Netlify?
4. Should user disconnect/reconnect eBay to get new refresh token with marketing scope?

## Next Steps
1. **Check Netlify deployment**: Verify commit 3ab65b6 is deployed and live
2. **Add debug logging**: Log the actual access token being sent (first/last 10 chars only)
3. **Test token directly**: Use a REST client to test if the token works with Marketing API
4. **Check user's refresh token**: May need to examine stored refresh token scopes
5. **Force eBay reconnection**: Have user disconnect/reconnect eBay to get fresh token with marketing scope
6. **Verify EBAY_ENV**: Ensure environment variable matches the actual eBay account (sandbox vs production)

## Files in This Debug Folder
- `README.md` - This file
- `ebay-update-active-promo.ts` - Netlify function entry point
- `ebay-promote.ts` - Marketing API wrapper functions
- `ebay-auth.ts` - Token management (returns {token, apiHost} object)
- `_common.ts` - OAuth token refresh function (accessTokenFromRefresh)

## Latest Error (Dec 12, 11:15 AM)
```
Failed to get ads 401: {
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

Still failing after token destructuring fix. Either:
1. Deployment not live yet
2. Refresh token itself doesn't have marketing scope
3. Some other token issue we haven't identified

## Related Documentation
- eBay Marketing API: https://developer.ebay.com/api-docs/sell/marketing/overview.html
- OAuth Scopes: https://developer.ebay.com/api-docs/static/oauth-scopes.html
- Commit with token fix: de7c978 (Dec 12, 2024)
