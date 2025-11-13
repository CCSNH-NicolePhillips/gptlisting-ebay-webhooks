# Cloudflare R2 Setup Guide

## Required Configuration

### 1. Create R2 Bucket
1. Go to Cloudflare Dashboard → R2
2. Click "Create bucket"
3. Name: `ebay-drafts-staging` (or your preferred name)
4. Click "Create bucket"

### 2. Configure CORS (CRITICAL for upload-local)
The bucket MUST allow CORS for browser uploads to work.

**In R2 Dashboard → Your Bucket → Settings → CORS Policy:**

```json
[
  {
    "AllowedOrigins": [
      "https://ebaywebhooks.netlify.app",
      "http://localhost:8888",
      "http://localhost:3000"
    ],
    "AllowedMethods": [
      "GET",
      "PUT",
      "POST",
      "DELETE",
      "HEAD"
    ],
    "AllowedHeaders": [
      "*"
    ],
    "ExposeHeaders": [
      "ETag"
    ],
    "MaxAgeSeconds": 3600
  }
]
```

### 3. Create API Token
1. In R2 Dashboard → Manage R2 API Tokens
2. Click "Create API token"
3. Permissions: **Object Read & Write**
4. Apply to specific bucket: `ebay-drafts-staging`
5. Copy the credentials:
   - **Access Key ID**
   - **Secret Access Key**
   - **Account ID** (from URL or settings)

### 4. Configure Netlify Environment Variables

Go to Netlify: **Site Settings → Environment Variables**

Add these variables:

```
R2_BUCKET=ebay-drafts-staging
R2_ACCOUNT_ID=<your-account-id>
R2_ACCESS_KEY_ID=<your-access-key-id>
R2_SECRET_ACCESS_KEY=<your-secret-access-key>
```

Optional (for public access without signed URLs):
```
R2_PUBLIC_URL=https://pub-xxxxxxxxx.r2.dev
```

### 5. Set Lifecycle Rule (Optional but Recommended)

To auto-delete staged files after 3 days:

1. In R2 Dashboard → Your Bucket → Settings → Object Lifecycle Rules
2. Add rule:
   - **Prefix**: `staging/`
   - **Action**: Delete after **3 days**

This prevents storage costs from accumulating.

## Testing

After configuration:
1. Redeploy site (or wait for auto-deploy)
2. Go to `/upload-local.html`
3. Select images
4. Click "Upload & Process"
5. Check browser Network tab for presigned URL request
6. Should see 200 OK responses

## Troubleshooting

### SSL Error (ERR_SSL_VERSION_OR_CIPHER_MISMATCH)
**Cause**: CORS not configured on R2 bucket
**Fix**: Add CORS policy (see step 2 above)

### 403 Forbidden
**Cause**: API token doesn't have write permissions
**Fix**: Recreate token with "Object Read & Write"

### 500 Internal Server Error
**Cause**: Missing environment variables
**Fix**: Verify all R2_* vars are set in Netlify

### Presigned URL returns 404
**Cause**: Bucket name mismatch
**Fix**: Verify R2_BUCKET matches actual bucket name
