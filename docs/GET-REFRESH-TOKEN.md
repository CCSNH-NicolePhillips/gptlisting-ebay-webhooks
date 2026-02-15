# Get Your eBay Refresh Token

Your eBay refresh token is stored in Netlify Blobs, but we need it locally for testing.

## Steps to Get Your Refresh Token:

1. **Go to Netlify Dashboard:**
   - https://app.netlify.com/sites/draftpilot-ai/configuration/env

2. **Look for environment variables** - your refresh token might be stored there (though it's likely in Blobs)

3. **OR - Check Netlify Blobs Store:**
   - Go to: https://app.netlify.com/sites/draftpilot-ai/blobs
   - Look for a key like: `user:{your-user-id}:ebay.json`
   - Click to view the value
   - Copy the `refresh_token` field

4. **OR - Use this manual process:**
   Since Netlify deployments are failing, we need to get creative:

   ### Option A: Generate a new eBay User Token
   1. Go to: https://developer.ebay.com/my/auth/?env=production&index=0
   2. Sign in with your eBay developer account
   3. Select scopes:
      - `https://api.ebay.com/oauth/api_scope`
      - `https://api.ebay.com/oauth/api_scope/sell.inventory`
      - `https://api.ebay.com/oauth/api_scope/sell.account`
   4. Click "Get a User Token"
   5. Copy the **refresh token** (not the access token)
   6. Save it as an environment variable

   ### Option B: Extract from old logs
   - Go to Netlify Functions logs
   - Look for any old successful runs
   - Tokens might be visible in debug output

---

**Once you have the refresh token**, save it and we can generate access tokens locally!
