# Setting Up eBay Fallback App for Rate Limit Protection

## Why You Need This

eBay's Taxonomy API has a limit of **5,000 calls per day per app**. With 15,111 categories to fetch, you'll hit this limit. A fallback app gives you an additional 5,000 calls/day, doubling your quota.

## How It Works

1. **Primary app** is used by default
2. When **rate limited (429)**, automatically switches to **fallback app**
3. Continues processing without waiting for midnight reset
4. Logs show: `🔄 Using fallback eBay app due to rate limit`

## Setup Steps

### 1. Create a Second eBay App

1. Go to [eBay Developer Program](https://developer.ebay.com/)
2. Sign in with your eBay account
3. Click **"Create an Application"**
4. Fill in the form:
   - **Application Title**: `GPTListing Taxonomy Fallback` (or whatever you want)
   - **Application Type**: Select **"Production"**
   - **Grant Options**: Select required permissions (Inventory, Sell APIs)
5. Click **"Create"**

### 2. Get Your Credentials

After creating the app, you'll see:
- **App ID (Client ID)**: Something like `YourName-GPTListi-PRD-xxxxxxxxx-xxxxxxxx`
- **Cert ID (Client Secret)**: Something like `PRD-xxxxxxxxx-xxxx-xxxx-xxxx-xxxx`

### 3. Add to Netlify Environment Variables

1. Go to [Netlify Site Settings](https://app.netlify.com/sites/ebaywebhooks/settings/env)
2. Add these new variables:
   ```
   EBAY_FALLBACK_CLIENT_ID=YourName-GPTListi-PRD-xxxxxxxxx-xxxxxxxx
   EBAY_FALLBACK_CLIENT_SECRET=PRD-xxxxxxxxx-xxxx-xxxx-xxxx-xxxx
   ```
3. Click **"Save"**

### 4. Redeploy

The next deployment will pick up the fallback credentials automatically.

## How to Test

Run the rate limit check script:
```bash
node scripts/check-ebay-rate-limit.mjs
```

If you see `429 Unknown Error`, you're currently rate limited.

## Current Status

- **Primary App**: `YOUR-APP-NAME-PRD-xxxxxxxxx-xxxxxxxx` (configured in env)
- **Fallback App**: Not yet configured
- **Categories Cached**: 7,361 / 15,111 (49%)
- **Remaining**: 7,750

## What Happens Next

Once configured:
1. Background job hits rate limit on primary app (after ~5,000 calls)
2. Automatically switches to fallback app
3. Gets another 5,000 calls
4. Together: **10,000 calls/day** = can fetch all remaining 7,750 categories in one day!

## Optional: Add to prod.env (Local Testing)

Add these to your `prod.env` file for local testing:
```env
# Fallback eBay app for rate limit protection
EBAY_FALLBACK_CLIENT_ID=YourName-GPTListi-PRD-xxxxxxxxx-xxxxxxxx
EBAY_FALLBACK_CLIENT_SECRET=PRD-xxxxxxxxx-xxxx-xxxx-xxxx-xxxx
```

**Note**: This file is gitignored, so these credentials stay private.
