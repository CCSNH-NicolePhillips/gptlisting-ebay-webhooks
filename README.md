# eBay + Dropbox Uploader + Netlify Webhooks

A complete eBay-Dropbox integration with:

- **Local app** for processing Dropbox photos → eBay draft/published listings
- **Netlify serverless functions** for eBay webhooks (MAD) and OAuth

## Features

### Local App (Express + TypeScript)

- Per-user **Connect Dropbox** (OAuth; offline access / refresh tokens)
- Per-user **Connect eBay Seller** (OAuth; refresh tokens)
- Groups files by prefix (`xx_01`, `xx_02`, `xx_price`) in a chosen folder
- Gets public `?raw=1` URLs for images (safe for eBay)
- OCR hook for `*_price.*` (placeholder provider)
- Pricing rules:
  - eBay price = 10% off base; if base > $30 then an extra -$5
  - Floor = 20% off the final eBay price (for markdown scheduler)
- **Publish Mode** toggle:
  - `draft` → create Inventory + Offer only
  - `post` → create + publish via Inventory API
  - `legacy-post` → (placeholder) use Trading API AddFixedPriceItem
- Category mapping support per SKU
- Offer management endpoints (view/update/publish)

### Netlify Functions

- **MAD webhook** (`/.netlify/functions/ebay-mad`) - Marketplace Account Deletion (required by eBay)
- **Platform Notifications** (`/.netlify/functions/ebay-platform`) - optional Trading API push
- **OAuth flow** (`/.netlify/functions/ebay-oauth-start`, `ebay-oauth-callback`)
- **Inventory setup** (`/.netlify/functions/ebay-init-location`)
- **Draft creation** (`/.netlify/functions/ebay-create-draft`) – accepts analyzer output and builds eBay Inventory + Offer drafts

### Draft creation function

`POST /.netlify/functions/ebay-create-draft`

```jsonc
{
   "items": [
      {
         "sku": "SKU123",
         "title": "Contoso Backpack",
         "price": 42.99,
         "quantity": 1,
         "imageUrls": ["https://dl.dropboxusercontent.com/..."],
         "inventory": {
            "product": {
               "aspects": { "Brand": ["Contoso"] }
            }
         }
      }
   ],
   "dryRun": false
}
```

- `items` may be a single object or array; analyzer UI already formats the payload.
- `dryRun: true` (or `PUBLISH_MODE=dry-run`) returns a preview without calling eBay.
- Provides automatic Dropbox URL conversion, policy lookup, and offer verification. Response includes `created` count, `results`, and `failures` with detailed errors.

## Quickstart

1. **Clone** and install deps

   ```bash
   npm i
   cp .env.example .env
   ```

2. **Create Dropbox app** → fill `DROPBOX_CLIENT_ID`, `DROPBOX_CLIENT_SECRET`, `DROPBOX_REDIRECT_URI` in `.env`.

3. **Create eBay app & RuName** → fill `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_RU_NAME`. Choose `EBAY_ENV` as `SANDBOX` to test.

4. **Run dev server**

   ```bash
   npm run dev
   ```

5. Visit:
   - `GET /auth/dropbox` → connect Dropbox (select folder later via `/me/dropbox/folder`).
   - `GET /auth/ebay` → connect eBay seller.
   - `POST /process?limit=10` → process up to 10 product groups from Dropbox into eBay (**see body format below**).

> **Heads-up: active listings UI**
> The local dev server is not configured for the Active Listings page or promotion edits. Those calls require a real seller account with Marketing API access; test them on your deployed Netlify site. Sandbox usually returns no active listings and may reject promo updates.

### Processing endpoint

`POST /process?limit=10` body (JSON):

```json
{
  "mode": "draft",
  "folderPath": "/EBAY",
  "quantityDefault": 1,
  "marketplaceId": "EBAY_US",
  "categoryId": "177011"
}
```

- `mode`: `draft` | `post` | `legacy-post`
- `folderPath`: Dropbox path or stored folder id (the scaffold accepts a string path for simplicity)
- You can also omit and rely on the server's defaults.

## Netlify Deployment

### Setup

1. **Create a new site on Netlify** and connect this repo, or deploy via CLI.

2. **Environment variables** (Site settings → Environment variables):
   - `EBAY_VERIFICATION_TOKEN`: 32–80 chars `[A-Za-z0-9_-]` (save this value—you'll also paste it in eBay's console)
   - `EBAY_ENDPOINT_URL`: exact MAD URL you'll paste into eBay (e.g., `https://<yoursite>.netlify.app/.netlify/functions/ebay-mad`)
   - `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_RUNAME` (production credentials)
   - `EBAY_ENV=PROD`
   - `EBAY_REFRESH_TOKEN`: seller refresh token with Inventory scope for draft creation
   - `DEFAULT_MARKETPLACE_ID` (e.g. `EBAY_US`) and `DEFAULT_CATEGORY_ID` fallback for analyzer → draft mapping
   - `EBAY_FULFILLMENT_POLICY_ID`, `EBAY_PAYMENT_POLICY_ID`, `EBAY_RETURN_POLICY_ID`, `EBAY_MERCHANT_LOCATION_KEY` to pin policy/location defaults (or let the function auto-discover the first policy)
   - Optional: `PROMOTED_CAMPAIGN_ID` (applies to created offers), `PUBLISH_MODE` (`draft` | `dry-run`), `EBAY_ENV` overrides (`SANDBOX`/`PROD`)
   - See `prod.env` for complete list

3. **Deploy**:
   ```bash
   npm run deploy  # deploy via CLI after login
   ```

### Authentication (Auth0 recommended for Google + Apple + Email)

The app includes a login page (`/login.html`) and a tiny auth client. Choose one mode:

Option A — Auth0 (Google, Apple, Email/password)

1) In Auth0, create a Single Page Application.
2) In Auth0 → Application → Settings:
   - Allowed Callback URLs: `https://<yoursite>.netlify.app/login.html`
   - Allowed Logout URLs: `https://<yoursite>.netlify.app/`
   - Allowed Web Origins: `https://<yoursite>.netlify.app`
3) Enable connections you need: Google (google-oauth2), Apple (apple), and Database (for email/password).
4) In Netlify Site settings → Environment variables set:
   - `AUTH_MODE=auth0`
   - `AUTH0_DOMAIN=<your-tenant>.us.auth0.com`
   - `AUTH0_CLIENT_ID=<client id>`
   - `AUTH0_AUDIENCE=<optional API identifier>`
5) Deploy. Visiting any gated page will redirect to `/login.html` and use Auth0 Universal Login.

Option B — Netlify Identity (Email/password, optional providers)

1) Enable Identity for your site in Netlify settings.
2) Set environment variable: `AUTH_MODE=identity`.
3) Deploy. The login page will open the Netlify Identity widget.

Notes:
- If `AUTH_MODE` isn’t set, `/login.html` shows an inline warning and disables buttons until configured.
- To fully isolate user data, add server-side JWT verification in functions and store per-user eBay/Dropbox tokens (keyed by JWT `sub`).

### eBay Console (Production)

- Go to **Alerts & Notifications** → **Production** → **Marketplace Account Deletion**.
- **Endpoint**: paste the MAD URL above.
- **Verification token**: the exact `EBAY_VERIFICATION_TOKEN` value.
- **Save** → eBay will GET `?challenge_code=...` → your function responds with `{ "challengeResponse": "<hex>" }`.
- Use **Send Test Notification** to send a test POST (your function logs will show it).

### Security

- **Do not** store refresh tokens unencrypted in production. Use a DB + KMS (e.g., AWS KMS) to encrypt at rest.
- Add proper auth for your app's users (JWT session, etc.). The scaffold ships with an in-memory pseudo-session for demo purposes.

### Notes

- OCR is stubbed—wire `tesseract` or your preferred provider.
- Promoted Listings and Markdown promotions API calls are sketched in `services/ebay.ts` as TODOs.
- Trading API (`legacy-post`) is left as a placeholder function to keep the scaffold small.
- **Webhooks**: Respond with 2xx quickly (≤3s). Do heavy work asynchronously.
- **MAD webhook hash**: Must be built with `challengeCode + verificationToken + endpointURL` in that order.

Have fun. PRs welcome.
