# How to Get Your eBay Access Token for Testing

Since your tokens are stored in Netlify Blobs and not easily accessible locally, here's the easiest way to get a working access token:

## Option 1: Extract from Browser (Recommended - Takes 2 minutes)

1. **Open your DraftPilot site** in Chrome/Edge
2. **Log in** to your DraftPilot account
3. **Open DevTools** (F12 or Right-click → Inspect)
4. **Go to the Network tab**
5. **Navigate to any page that calls eBay** (like Active Listings or Create Draft)
6. **Find any request to an eBay API** (filter by "ebay" or look for calls to `api.ebay.com`)
7. **Click on the request** 
8. **Look at Request Headers**
9. **Copy the value after `Authorization: Bearer `**
   - It will look like: `v^1.1#i^1#p^3#r^0#f^0#I^3#t^...` (very long)

10. **Run the test:**
   ```powershell
   $env:EBAY_TOKEN = "paste_your_token_here"
   node test-with-browser-token.mjs
   ```

## Option 2: Check Netlify Function Logs

1. Go to https://app.netlify.com
2. Open your site
3. Go to Functions tab
4. Find a recent invocation of `ebay-get-active-item` or similar
5. Look in the logs for any token (they're usually redacted though)

## Option 3: Add Debug Endpoint

I can add a temporary endpoint to your site that returns your token for testing purposes.

---

**Which option would you prefer?**

Option 1 (browser) is fastest if you have an active session.
