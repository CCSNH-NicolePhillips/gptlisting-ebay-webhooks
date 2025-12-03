# Local Development Setup

This guide explains how to run the app locally with full eBay integration for testing.

## Prerequisites

1. **Netlify CLI** - For running functions locally
   ```bash
   npm install -g netlify-cli
   ```

2. **eBay Developer Account** with separate Sandbox credentials

## Step 1: Create eBay Sandbox RUName

1. Go to [eBay Developer Portal](https://developer.ebay.com/)
2. Switch to **Sandbox** environment
3. Navigate to **User Tokens** → **Auth'n'Auth**
4. Create a new **OAuth Redirect URL** (RUName):
   - **Name**: `localhost-dev` (or whatever you prefer)
   - **Production/Sandbox**: SANDBOX
   - **Redirect URL**: `http://localhost:8888/.netlify/functions/ebay-oauth-callback`
   - **Privacy Policy URL**: `http://localhost:8888/privacy.html`
   
5. Note the generated RUName (e.g., `Your_Name-YourApp-local-wxyz`)

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
EBAY_RUNAME=Your_Name-YourApp-local-wxyz

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
# Install dependencies
npm install

# Build TypeScript
npm run build

# Start Netlify Dev server
netlify dev
```

This starts:
- Local dev server at `http://localhost:8888`
- Functions at `http://localhost:8888/.netlify/functions/...`

## Step 5: Test eBay OAuth Flow

1. Open `http://localhost:8888`
2. Login with Auth0
3. Go to **Settings** → **Connect eBay**
4. Should redirect to eBay Sandbox login
5. After authorization, redirects back to `localhost:8888`
6. Check that token is saved (Settings page shows "Connected")

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

- eBay RUName must **exactly** match `http://localhost:8888/.netlify/functions/ebay-oauth-callback`
- Check eBay Developer Portal → Auth'n'Auth settings
- No trailing slash, must be `http` not `https` for localhost

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

| Feature | Production | Local Dev |
|---------|-----------|-----------|
| eBay Env | PROD | SANDBOX |
| RUName | Production RUName | Localhost RUName |
| URL | `https://gptlisting.netlify.app` | `http://localhost:8888` |
| Storage | Netlify Blobs + R2 | Redis + R2 |
| Background Jobs | Netlify Background Functions | Simulated (runs inline) |

## Best Practices

1. **Never commit `.env`** - Add to `.gitignore` (already done)
2. **Use separate Auth0 tenant** for local dev (optional but recommended)
3. **Keep sandbox data clean** - Delete test listings regularly
4. **Test pricing changes locally** before deploying to production
5. **Use sample images** - Don't upload customer data locally

## Quick Commands

```bash
# Build and run
npm run build && netlify dev

# Watch TypeScript changes
npm run build -- --watch
# In another terminal:
netlify dev

# Clear local cache
rm -rf .netlify/cache

# View function logs
netlify functions:log <function-name>
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
