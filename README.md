# GPTListing eBay Webhooks (Netlify)

Production-ready minimal scaffold for:
- **Marketplace Account Deletion (MAD)** webhook (required by eBay for prod apps)
- **Platform Notifications** (optional Trading API push notifications)

## Endpoints (after deploy)
- MAD: `https://<yoursite>.netlify.app/.netlify/functions/ebay-mad`
- Platform: `https://<yoursite>.netlify.app/.netlify/functions/ebay-platform`

## Setup

1. **Create a new site on Netlify** and connect this repo, or deploy via CLI.
2. **Environment variables** (Site settings → Environment variables):
   - `EBAY_VERIFICATION_TOKEN`: 32–80 chars `[A-Za-z0-9_-]` (save this value—you’ll also paste it in eBay’s console)
   - `EBAY_ENDPOINT_URL`: exact MAD URL you’ll paste into eBay (e.g., `https://<yoursite>.netlify.app/.netlify/functions/ebay-mad`)
3. **Deploy**:  
   ```bash
   npm i
   npm run dev   # local tunnel for quick tests
   # or
   npm run deploy  # deploy via CLI after login
   ```

## eBay Console (Production)

- Go to **Alerts & Notifications** → **Production** → **Marketplace Account Deletion**.
- **Endpoint**: paste the MAD URL above.
- **Verification token**: the exact `EBAY_VERIFICATION_TOKEN` value.
- **Save** → eBay will GET `?challenge_code=...` → your function responds with `{ "challengeResponse": "<hex>" }`.
- Use **Send Test Notification** to send a test POST (your function logs will show it).

## Notes
- Respond with 2xx quickly (≤3s). Do heavy work asynchronously.
- The hash must be built with: `challengeCode + verificationToken + endpointURL` in that order.
- JSON response for the challenge must be exactly `{ "challengeResponse": "<hex>" }` with `Content-Type: application/json`.
