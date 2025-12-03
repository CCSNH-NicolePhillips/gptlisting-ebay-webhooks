# Local Development Setup

This guide explains how to run the app locally with full eBay integration for testing.

## Prerequisites

1. **Netlify CLI** - For running functions locally
   ```bash
   npm install -g netlify-cli
   ```

2. **ngrok** - For HTTPS tunnel to localhost (eBay requires HTTPS)
   ```bash
   npm install -g ngrok
   # or download from https://ngrok.com/download
   ```

3. **eBay Developer Account** with separate Sandbox credentials

## Step 1: Start Local Server with HTTPS Tunnel

eBay requires HTTPS for OAuth callbacks, so we use ngrok to create a secure tunnel to localhost.

```bash
# Terminal 1: Start Netlify Dev
netlify dev

# Terminal 2: Start ngrok tunnel
ngrok http 8888
```

ngrok will display output like:
```
Forwarding  https://abc123.ngrok.io -> http://localhost:8888
```

**Copy the HTTPS URL** (e.g., `https://abc123.ngrok.io`) - you'll need this for the next step.

> **Note**: The ngrok URL changes every time you restart it (unless you have a paid account with a fixed subdomain). You'll need to update the eBay RUName each time, or use a paid ngrok account for a permanent URL.

## Step 2: Create eBay Sandbox RUName

1. Go to [eBay Developer Portal](https://developer.ebay.com/)
2. Switch to **Sandbox** environment
3. Navigate to **User Tokens** → **Auth'n'Auth**
4. Create a new **OAuth Redirect URL** (RUName):
   - **Name**: `ngrok-dev` (or whatever you prefer)
   - **Production/Sandbox**: SANDBOX
   - **Redirect URL**: `https://YOUR-NGROK-URL/.netlify/functions/ebay-oauth-callback`
     - Example: `https://abc123.ngrok.io/.netlify/functions/ebay-oauth-callback`
   - **Privacy Policy URL**: `https://YOUR-NGROK-URL/privacy.html`
     - Example: `https://abc123.ngrok.io/privacy.html`
   
5. Note the generated RUName (e.g., `Your_Name-YourApp-ngrok-wxyz`)

## Step 2: Get Sandbox App Credentials

1. In eBay Developer Portal → **Application Keys**
2. Switch to **Sandbox** keys
3. Copy:
   - **App ID (Client ID)**
   - **Cert ID (Client Secret)**

## Step 3: Configure Local Environment

Create `.env` file in project root:

```bash
# eBay Sandbox Credentials
EBAY_ENV=SANDBOX
EBAY_CLIENT_ID=your-sandbox-app-id
EBAY_CLIENT_SECRET=your-sandbox-cert-id
EBAY_RUNAME=Your_Name-YourApp-ngrok-wxyz

# Marketplace (use EBAY_US for testing)
DEFAULT_MARKETPLACE_ID=EBAY_US
EBAY_MARKETPLACE_ID=EBAY_US

# Auth0 (use production or separate dev tenant)
AUTH0_DOMAIN=your-tenant.us.auth0.com
AUTH0_CLIENT_ID=your-auth0-client-id
AUTH0_CLIENT_SECRET=your-auth0-client-secret
AUTH0_AUDIENCE=https://api.gptlisting.com

# OpenAI for SmartDrafts
OPENAI_API_KEY=sk-...

# AWS S3/R2 for image storage (optional, can use Dropbox)
AWS_ACCESS_KEY_ID=your-r2-access-key
AWS_SECRET_ACCESS_KEY=your-r2-secret-key
AWS_REGION=auto
AWS_ENDPOINT_URL=https://your-account.r2.cloudflarestorage.com
S3_BUCKET_NAME=ebay-drafts-staging

# Redis (use Upstash free tier or local Redis)
REDIS_URL=redis://localhost:6379
# or Upstash:
# REDIS_URL=rediss://...

# Netlify Blobs (won't work locally, falls back to Redis)
# No config needed - uses Netlify CLI context

# Optional: Default location for testing
# EBAY_MERCHANT_LOCATION_KEY=default-loc
```

## Step 4: Run Locally

```bash
# Terminal 1: Install dependencies and build
npm install
npm run build

# Start Netlify Dev server
netlify dev

# Terminal 2: Start ngrok tunnel (in a separate terminal)
ngrok http 8888
```

Your app is now accessible at:
- **Public URL** (for eBay OAuth): `https://YOUR-NGROK-URL` (e.g., `https://abc123.ngrok.io`)
- **Local URL** (for direct testing): `http://localhost:8888`

> **Important**: Use the ngrok HTTPS URL when testing eBay OAuth. Use localhost for general development without OAuth.

## Step 5: Test eBay OAuth Flow

1. Open the **ngrok HTTPS URL** in your browser (e.g., `https://abc123.ngrok.io`)
2. Login with Auth0
3. Go to **Settings** → **Connect eBay**
4. Should redirect to eBay Sandbox login
5. After authorization, redirects back to your ngrok URL
6. Check that token is saved (Settings page shows "Connected")

> **Note**: If you restart ngrok, you'll get a new URL and need to update the RUName in eBay Developer Portal.

## Testing Workflow

### Create Test Listings in Sandbox

1. Go to [eBay Sandbox Seller Hub](https://www.sandbox.ebay.com)
2. Login with your sandbox seller account
3. Create a test inventory location if needed
4. In local app:
   - Upload test product images
   - Run Quick List or Draft Wizard
   - Verify drafts are created in eBay Sandbox

### Check Sandbox Listings

- [My eBay Sandbox - Selling](https://www.sandbox.ebay.com/sh/ovw)
- Listings created via API appear as drafts/unpublished

## Troubleshooting

### "RUName mismatch" or "redirect_uri" errors

- eBay RUName must **exactly** match your ngrok URL
- Format: `https://YOUR-NGROK-URL/.netlify/functions/ebay-oauth-callback`
- No trailing slash
- Must be HTTPS (not HTTP)
- If you restart ngrok, update the RUName in eBay Developer Portal

### ngrok URL changes every restart

- **Free ngrok**: URL changes each time (`https://random123.ngrok.io`)
- **Solution 1**: Update eBay RUName each time you restart ngrok
- **Solution 2**: Get ngrok paid account for fixed subdomain (`https://yourname.ngrok.io`)
- **Solution 3**: Use Netlify Deploy Preview instead (see below)

### "Invalid grant" errors

- Sandbox tokens expire frequently
- Re-connect eBay to get fresh tokens
- Check that `EBAY_ENV=SANDBOX` matches your credentials

### Functions timeout

- Increase timeout in `netlify.toml` for local testing
- Check Netlify Dev logs for detailed errors

### Image uploads fail

- Local mode uses Cloudflare R2 if configured, otherwise Dropbox
- Make sure R2 credentials are valid
- Or use Dropbox OAuth for image uploads

## Production vs Local Differences

| Feature | Production | Local Dev (ngrok) |
|---------|-----------|-------------------|
| eBay Env | PROD | SANDBOX |
| RUName | Production RUName | ngrok HTTPS URL |
| URL | `https://gptlisting.netlify.app` | `https://abc123.ngrok.io` |
| Storage | Netlify Blobs + R2 | Redis + R2 |
| Background Jobs | Netlify Background Functions | Simulated (runs inline) |

## Alternative: Use Netlify Deploy Preview (No ngrok needed)

If you don't want to deal with changing ngrok URLs:

1. Create a `dev` branch for testing
2. Push changes: `git push origin dev`
3. Netlify automatically creates deploy preview: `https://dev--yoursite.netlify.app`
4. Create eBay RUName pointing to: `https://dev--yoursite.netlify.app/.netlify/functions/ebay-oauth-callback`
5. Set `EBAY_ENV=SANDBOX` in Netlify environment variables for the `dev` branch

This gives you a stable HTTPS URL for development without needing ngrok.

## Best Practices

1. **Never commit `.env`** - Add to `.gitignore` (already done)
2. **Use separate Auth0 tenant** for local dev (optional but recommended)
3. **Keep sandbox data clean** - Delete test listings regularly
4. **Test pricing changes locally** before deploying to production
5. **Use sample images** - Don't upload customer data locally

## Quick Commands

```bash
# Terminal 1: Build and run Netlify Dev
npm run build && netlify dev

# Terminal 2: Start ngrok tunnel
ngrok http 8888

# Watch TypeScript changes (optional)
npm run build -- --watch

# Clear local cache
rm -rf .netlify/cache

# View ngrok requests (helpful for debugging OAuth)
# Open http://localhost:4040 in browser (ngrok inspector)
```

## Environment Variables Reference

See `configs/prod.env.example` for complete list of environment variables.

Required for local eBay testing:
- `EBAY_ENV=SANDBOX`
- `EBAY_CLIENT_ID`
- `EBAY_CLIENT_SECRET`
- `EBAY_RUNAME` (sandbox localhost RUName)
- `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`
- `OPENAI_API_KEY`

Optional but recommended:
- `AWS_*` for R2 storage (faster than Dropbox)
- `REDIS_URL` for local job queue testing
