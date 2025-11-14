# Auth0 Token Refresh Race Condition Fix

**Date:** November 14, 2025  
**Issue:** 502/404 errors on quick-list page due to Auth0 refresh token issues

## Problem Summary

The application was experiencing **"Token could not be decoded or is missing in DB"** errors from Auth0, resulting in 502/404 errors when making API calls. This was caused by a **race condition** in the token refresh logic.

### Root Causes

1. **Multiple simultaneous token refresh attempts** - When the app initialized or made multiple API calls, several parts of the code would call `getTokenSilently()` at the same time
2. **Rotating refresh token reuse** - Auth0 uses rotating refresh tokens for security. When a refresh token is used multiple times simultaneously, Auth0 invalidates the entire token family
3. **No request gating** - The original code had no mechanism to prevent concurrent token refresh operations
4. **Aggressive cache busting** - Using `cacheMode: 'off'` forced unnecessary token refreshes

### Auth0 Behavior

According to Auth0 documentation, this error occurs when:
- A refresh token is **reused** (causes entire token family invalidation)
- A refresh token is **revoked**
- A refresh token has **expired**
- A refresh token was **pruned** (>200 tokens per user per app)

## Solution Implemented

### 1. Token Refresh Gating (Primary Fix)

Created a `getTokenWithGating()` function that ensures **only one token refresh can be in-flight at a time**:

```javascript
async function getTokenWithGating() {
  // If a refresh is already in progress, wait for it
  if (state.tokenRefreshPromise) {
    console.log('[Auth] Token refresh already in progress, waiting...');
    return await state.tokenRefreshPromise;
  }

  // Start a new refresh operation
  state.tokenRefreshPromise = (async () => {
    try {
      // Token refresh logic here...
    } finally {
      // Clear the promise after completion
      state.tokenRefreshPromise = null;
    }
  })();

  return state.tokenRefreshPromise;
}
```

This implements the **promise-based gating pattern** similar to Auth0's own SDK (`promise-utils.js`).

### 2. Improved Token Validation

- Increased JWT validation buffer from 30s to 60s to avoid edge cases
- Check cached tokens first before refreshing
- Validate tokens before making refresh calls

### 3. Better Error Handling

- Detect `AUTH_EXPIRED` errors and redirect to login
- Handle 401/403 errors gracefully in `fetchJSON()`
- Avoid showing alerts when auth redirect is happening
- Clear auth state properly when tokens are invalid

### 4. Removed Aggressive Cache Busting

Changed `ensureAuth()` from:
```javascript
state.token = await state.auth0.getTokenSilently({ cacheMode: 'off' })
  || await state.auth0.getTokenSilently();
```

To:
```javascript
state.token = await getTokenWithGating();
```

This lets the Auth0 SDK manage its own cache instead of forcing refreshes.

### 5. Updated All Token Fetch Points

Updated these functions to use `getTokenWithGating()`:
- `initAuth0()` - Initial token acquisition
- `ensureAuth()` - Ensure authentication before operations
- `getToken()` - Public API for getting tokens
- `authFetch()` - Authenticated fetch wrapper
- `attachAuthFetch()` - Global fetch patch for Netlify functions

## Files Modified

1. **`public/auth-client.js`**
   - Added `tokenRefreshPromise` to state
   - Created `getTokenWithGating()` function
   - Updated `initAuth0()`, `ensureAuth()`, `getToken()`, `authFetch()`, `attachAuthFetch()`
   - Added debug logging for token refresh operations

2. **`public/quick-list.html`**
   - Enhanced `fetchJSON()` error handling
   - Added auth error detection and redirect
   - Improved error messages in pipeline

## Testing Recommendations

### 1. Test Normal Flow
- Log in to the application
- Navigate to quick-list page
- Start a pipeline
- Verify no 502/404 errors occur

### 2. Test Token Expiration
- Log in and wait for token to expire (check JWT exp claim)
- Try to make an API call
- Should redirect to login page gracefully

### 3. Test Concurrent Requests
- Open browser dev tools → Network tab
- Start quick-list pipeline (makes multiple API calls)
- Check console for "[Auth] Token refresh already in progress, waiting..." messages
- Verify only ONE token refresh request is made to Auth0

### 4. Monitor Auth0 Logs
- Check Auth0 dashboard → Logs
- Look for "Reused rotating refresh token detected" errors (should be gone)
- Verify successful token exchange events

## Debugging

If issues persist, check the browser console for:

```
[Auth] Token refresh already in progress, waiting...
[Auth] Starting new token refresh...
[Auth] Token expired, redirecting to login...
```

These logs indicate the gating mechanism is working.

## Prevention

To prevent this issue in the future:

1. **Never call `getTokenSilently()` directly** - Always use `getTokenWithGating()`
2. **Don't use `cacheMode: 'off'`** unless absolutely necessary
3. **Check `state.token` first** before refreshing
4. **Add proper error handling** for auth failures
5. **Monitor Auth0 logs** for token-related errors

## Related Auth0 Documentation

- [Refresh Token Rotation](https://auth0.com/docs/secure/tokens/refresh-tokens/refresh-token-rotation)
- [Refresh Token Errors](https://auth0.com/docs/troubleshoot/authentication-issues/refresh-token-errors)
- [Token Best Practices](https://auth0.com/docs/secure/tokens/token-best-practices)

## Additional Notes

The 502 error you saw ("Background worker returned 404 Not Found") was likely a **cascading failure** from the auth error:

1. Token refresh failed due to race condition
2. API request had invalid/missing auth token
3. Backend returned 401/403
4. Frontend error handling wasn't catching auth errors properly
5. Error bubbled up as generic 502/404

With these fixes, the auth layer should handle token refresh correctly and prevent these cascading failures.
