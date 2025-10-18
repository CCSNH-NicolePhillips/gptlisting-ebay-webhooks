# eBay + Dropbox Uploader (Scaffold)

A minimal, multi-user scaffold to ingest product photos from **Dropbox**, compute pricing, and create **eBay Inventory/Offer** listings as **drafts** or **post now**, with room for Promoted Listings and Markdown promotions.

## Features

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
- Clean services layer: `dropbox`, `ebay`, `pricing`, `grouping`, `ocr`

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

### Security

- **Do not** store refresh tokens unencrypted in production. Use a DB + KMS (e.g., AWS KMS) to encrypt at rest.
- Add proper auth for your app's users (JWT session, etc.). The scaffold ships with an in-memory pseudo-session for demo purposes.

### Notes

- OCR is stubbed—wire `tesseract` or your preferred provider.
- Promoted Listings and Markdown promotions API calls are sketched in `services/ebay.ts` as TODOs.
- Trading API (`legacy-post`) is left as a placeholder function to keep the scaffold small.

Have fun. PRs welcome.
