# Railway Deployment Guide

## Why Railway?

Netlify Functions hit memory limits during build with 153 functions. Railway runs a single Express server consolidating all functions, avoiding this issue.

## Architecture

```
                   ┌─────────────────────────────────────┐
                   │         Railway Server              │
                   │   (Express on Node.js 20)           │
                   │                                     │
                   │   /.netlify/functions/me            │
                   │   /.netlify/functions/ebay-*        │
                   │   /.netlify/functions/smartdrafts-* │
                   │   ... (152 function endpoints)      │
                   │                                     │
                   │   Static files from /public         │
                   │   SPA fallback to index.html        │
                   └─────────────────────────────────────┘
```

## Key Files

- `src/server/index.ts` - Express server entry point
- `src/server/adapter.ts` - Netlify-to-Express handler wrapper
- `railway.json` - Railway deployment config
- `Dockerfile` - Alternative container deployment

## Initial Setup

### 1. Install Railway CLI

```powershell
npm install -g @railway/cli
```

### 2. Login to Railway

```powershell
railway login
```

### 3. Create Project

```powershell
railway init
# Follow prompts to create new project
```

### 4. Link to GitHub (Optional)

In Railway Dashboard:
1. Go to your project
2. Click "Connect GitHub"
3. Select your repository
4. Enable auto-deploy on push

### 5. Configure Environment Variables

In Railway Dashboard → Variables, add:

**Required:**
```
EBAY_CLIENT_ID=<your-ebay-client-id>
EBAY_CLIENT_SECRET=<your-ebay-client-secret>
EBAY_RUNAME=<your-ebay-runame>
OPENAI_API_KEY=<your-openai-key>
UPSTASH_REDIS_REST_URL=<your-upstash-url>
UPSTASH_REDIS_REST_TOKEN=<your-upstash-token>
AUTH0_DOMAIN=<your-auth0-domain>
AUTH0_CLIENT_ID=<your-auth0-client-id>
```

**Optional:**
```
EBAY_ENV=PROD              # or SANDBOX for testing
PUBLISH_MODE=draft         # or post
PORT=8888                  # Railway sets this automatically
```

### 6. Deploy

**Manual deploy:**
```powershell
railway up
```

**Via GitHub (if linked):**
Just push to main branch.

## Verify Deployment

After deploy, Railway provides a URL like `https://your-app.up.railway.app`

Test health endpoint:
```bash
curl https://your-app.up.railway.app/health
# Should return: {"status":"ok","timestamp":"..."}
```

## Setting Up Cron Jobs

For `price-tick` auto-reduction, set up a cron job in Railway:

1. Go to Railway Dashboard → Your Project
2. Add a new Service → "Cron Job"
3. Configure:
   - Schedule: `0 */6 * * *` (every 6 hours)
   - Command: `curl -X POST https://your-app.up.railway.app/.netlify/functions/price-tick`

Or use an external cron service (e.g., cron-job.org, Upstash QStash).

## Local Development

```powershell
# Build
npm run build

# Start server
npm start

# Or with hot reload (requires tsx)
npm run dev:server
```

## Troubleshooting

### Server crashes immediately
- Check for unhandled promise rejections in function imports
- Look at Railway logs for stack traces

### Functions return 404
- Verify function is listed in `src/server/index.ts`
- Check if function exports `handler`

### Auth errors
- Ensure Auth0 environment variables are set
- Check `AUTH0_DOMAIN` format (should be like `your-tenant.auth0.com`)

### eBay API errors
- Verify `EBAY_ENV` matches your credentials (SANDBOX vs PROD)
- Check token refresh is working

## Migrating OAuth Callbacks

Update eBay Developer Portal:
1. Go to https://developer.ebay.com/my/keys
2. Update RuName redirect URL to Railway URL

Update Auth0:
1. Go to Auth0 Dashboard → Applications → Your App
2. Add Railway URL to Allowed Callback URLs

## Costs

Railway pricing (as of 2026):
- $5/month base (500 hours free)
- Pay for usage beyond that
- No cold starts (server always running)
