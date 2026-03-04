# Operations Runbook

Quick reference for local development, debugging, and production operations.
For architecture context see [architecture.md](architecture.md).

---

## Local Development

### Start the Express API server

```powershell
npm run dev:api          # tsx watch — auto-reloads on source changes
# Server starts on http://localhost:3000  (PORT env var overrides)
```

### Run tests

```powershell
npm test                 # lint + jest (full suite, with coverage thresholds)
npm run test:watch       # jest --watch (no lint, fast feedback loop)
npx jest tests/api/ebay.test.ts --no-coverage   # single suite, no coverage
```

### Lint only

```powershell
npm run lint             # ESLint, 0 warnings allowed
npm run lint:fix         # auto-fix fixable violations
npm run lint:boundaries  # layer-boundary rules only (fast)
```

### Structure and inventory guards

```powershell
npm run check:structure  # fails if new files were added to src/lib/
npm run check:no-netlify # fails if apps/ or packages/ import netlify
npm run check:inventory  # fails if a netlify function is missing from inventory
npm run check:forbidden  # fails if pricing sub-modules are imported directly
```

### Build

```powershell
npm run build            # tsc → dist/
npm run typecheck        # noEmit type check only (faster)
```

### Netlify local (legacy functions)

```powershell
netlify dev              # gates on :8888, proxies /.netlify/functions/*
ngrok http 8888          # HTTPS tunnel for eBay OAuth callbacks
# CRITICAL: update EBAY_RUNAME in .env when the ngrok URL changes
```

---

## Environment Variables

Copy `configs/prod.env.example` to `.env` and fill in missing values.

### Auth0

| Variable | Description |
|---|---|
| `AUTH0_DOMAIN` | Your Auth0 tenant domain (e.g. `myapp.us.auth0.com`) |
| `AUTH0_CLIENT_ID` | Auth0 application client ID |
| `AUTH0_AUDIENCE` | JWT audience (optional — defaults to CLIENT_ID) |
| `AUTH_MODE` | `user` \| `admin` \| `mixed` (default: `admin`) |

### eBay

| Variable | Description |
|---|---|
| `EBAY_CLIENT_ID` | eBay app client ID |
| `EBAY_CLIENT_SECRET` | eBay app client secret |
| `EBAY_RUNAME` | OAuth redirect URL name (must match current callback URL) |
| `EBAY_ENV` | `SANDBOX` or `PROD` (default: `PROD`) **Always set `SANDBOX` locally** |
| `EBAY_MERCHANT_LOCATION_KEY` | Merchant inventory location key |
| `EBAY_PAYMENT_POLICY_ID` | Default payment policy |
| `EBAY_RETURN_POLICY_ID` | Default return policy |
| `EBAY_FULFILLMENT_POLICY_ID` | Default fulfillment policy |

### OpenAI / Vision

| Variable | Description |
|---|---|
| `OPENAI_API_KEY` | OpenAI API key for GPT-4o-mini vision and chat |
| `VISION_MODEL` | Override vision model (default: `openai:gpt-4o-mini`) |
| `VISION_CONCURRENCY` | Parallel vision calls (default: `2`, max: `16`) |

### Redis (Upstash REST)

| Variable | Description |
|---|---|
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST endpoint URL |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST bearer token |

### Pricing / behaviour flags

| Variable | Description |
|---|---|
| `PUBLISH_MODE` | `draft` \| `post` \| `legacy-post` (default: `draft`) **Never set `post` locally** |
| `USE_ROLE_SORTING` | Enable role-based image sorting (default: `true`) |
| `USE_NEW_SORTER` | Enable new sorter algorithm (default: `true`) |
| `PAIR_CANDIDATE_K` | Top-K pairing candidates per front image (default: `8`) |
| `MAX_FILES_PER_BATCH` | Maximum images per scan job (default: `200`) |

### Storage / ingestion

| Variable | Description |
|---|---|
| `STORAGE_BUCKET` | AWS S3 bucket name for image staging |
| `STORAGE_REGION` | AWS region |
| `AWS_ACCESS_KEY_ID` | AWS credentials |
| `AWS_SECRET_ACCESS_KEY` | AWS credentials |

---

## Debugging

### eBay Auth / Token Refresh Flow

```
User browser → POST /.netlify/functions/ebay-auth-callback
              → stores { refresh_token, access_token } in Redis
                at key: users/<encodedSub>/ebay.json

Express route  → calls requireUserAuth(authHeader) → { userId }
              → getEbayClient(userId)  [src/lib/ebay-client.ts]
                  reads users/<encodedSub>/ebay.json from Redis
                  calls accessTokenFromRefresh(refresh_token)  [src/lib/_common.ts]
                  returns { access_token, apiHost, headers }
```

**Common auth problems:**
- `Connect eBay first` → user has not completed eBay OAuth.  Direct them to
  the eBay connect page which runs `ebay-auth-initiate`.
- `Token expired` → access tokens last 2 hours; `accessTokenFromRefresh` is
  called fresh on each request — if this error appears the user's *refresh*
  token has expired (90-day TTL). They must reconnect.
- `Auth0 not configured` → `AUTH0_DOMAIN` env var is missing.  Set it in `.env`.

### Job Status Normalisation

Background jobs (SmartDrafts scan, pairing, create-drafts) store state in Redis
using the key pattern `job:{userId}:{jobId}`.

Expected `state` transitions:

```
pending → running → complete
                  → error
```

- `state: "complete"` means the job finished without throwing — check `result`
  and `errors` fields for partial failures.
- `state: "error"` means the top-level handler threw.  Check `error.message`.
- If a job appears stuck in `running`, the background function likely hit its
  10-minute timeout.  Netlify background functions do not emit a `state: "error"`;
  the Redis record will remain in `running`.  The Railway worker times out after
  600 s and writes `state: "error"`.

### `pricingEvidence.summary` Field Reference

The `summary` object returned by `getPricingDecision()` contains these fields:

| Field | Meaning |
|---|---|
| `strategy` | Active pricing strategy name, e.g. `"ALGO_COMPETITIVE_TOTAL"` |
| `shippingEstimateCents` | Shipping cost used in math (0 for free-shipping items) |
| `discountPercent` | Markdown applied to the anchor price before minimum check |
| `anchorPriceCents` | Pre-discount price (market reference, in cents) |
| `floorPriceCents` | `minItemPriceCents` — listing will not go below this |
| `finalPriceCents` | Computed sale price (after discount + floor clamping) |
| `sources` | Array of price signals used (`amazon`, `ebay-sold`, `walmart`, etc.) |
| `winningSignal` | Which source drove the anchor price |
| `warnings` | Array of strings describing anomalies (e.g. `"no market data found"`) |
| `usedFallback` | `true` when no market data was found and floor price was used |

**Example workflow**: If a listing price seems unexpectedly low, check:
1. `winningSignal` — which source "won"
2. `sources` — are the prices plausible?  Was only one low-quality source found?
3. `usedFallback: true` — if true, market data was missing entirely

### `publishOffer` Auto-Fix Behaviour

`publishOffer` in `src/services/ebay-offers.service.ts` retries up to once per
error code (does not loop):

| eBay error | Meaning | Auto-fix |
|---|---|---|
| `25020` | Missing package weight | Fetches inventory item, patches weight to **16 oz**, retries publish |
| `25021` | Invalid condition value | Fetches offer, patches condition to caller-supplied value or `1000` (unspecified), retries |
| `25015` | Picture URL too long (>500 chars) | Converts S3 presigned URLs to short `img?k=…` redirect URLs, retries |

If the retry still fails, the original eBay error payload is forwarded with its
HTTP status code.  The caller should display the `publish.detail` field to the
user.  **Do not auto-delete** the offer on failure — the user may be able to
fix the underlying issue.

Post-publish side-effects (non-blocking — logged on error but do not fail the
publish response):
1. Records `offerId → publishedAt` in `users/<sub>/published.json`
2. Checks Redis for a per-offer **promotion intent** set by the draft wizard →
   queues a promotion job if found
3. Re-reads user's `settings.json` for **auto-price reduction** settings →
   creates a price binding via `price-store.ts` if enabled

### Common eBay Error Codes

| Code | Meaning | Action |
|---|---|---|
| `25707` | Invalid SKU character in inventory | `listOffers` auto-falls-back to per-SKU safe aggregation |
| `25020` | Missing package weight | Auto-fixed by `publishOffer` |
| `25021` | Invalid condition value | Auto-fixed by `publishOffer` |
| `25015` | Picture URL too long | Auto-fixed by `publishOffer` |
| `25002` | Offer already published | Check if the user already published this offer |
| `1047` | Trading API: item already ended | Treated as success by `endListing` |
| `25113` | Missing category ID | Ensure `categoryId` is set in the draft |

### Logging Expectations

- Every significant operation logs `[function-name] <message>` as prefix.
- Errors log `console.error('[name] Error:', err.message)` then `err.stack`.
- Sensitive data (tokens, refresh tokens, eBay auth tokens) must **never** be
  logged.  Use `'[REDACTED]'` if you need to confirm a value is present.
- Vision batch operations log `[vision] batch N of M: N images` for each call.
- Rate-limit back-off is logged as `[warn] rate-limited, retrying in Xms`.

---

## Operational Notes

### Safety Flags (checked before every deploy)

```
EBAY_ENV=SANDBOX         # must be PROD on Railway production
PUBLISH_MODE=draft       # must be 'post' only when intentionally publishing live
```

### eBay Sandbox vs Production

- Switch `EBAY_ENV=SANDBOX` to test against the eBay sandbox environment.
- Sandbox credentials from the eBay Developer Portal are **separate** from prod.
- The `tokenHosts(process.env.EBAY_ENV)` call in `src/lib/_common.ts` routes
  all API calls to the correct host automatically.

### Redis Key Patterns

| Key pattern | Contents |
|---|---|
| `users/<sub>/ebay.json` | eBay OAuth tokens (refresh + access) |
| `users/<sub>/settings.json` | User settings (auto-promote, auto-price, etc.) |
| `users/<sub>/policy-defaults.json` | Legacy policy defaults |
| `users/<sub>/published.json` | Map of `offerId → publishedAt` |
| `job:{userId}:{jobId}` | Background job state |
| `price:bind:*` | Auto-price reduction bindings (45-day TTL) |
| `promo:intent:{offerId}` | Pending promotion intent (set during draft creation) |
| `taxonomy:*` | Taxonomy cache (7-day TTL) |

### Railway Deployment

```powershell
npm run deploy           # railway up
```

- The Express server (`apps/api/src/index.ts`) listens on `PORT` (Railway sets this automatically).
- The longer timeout for list-offers (25 s on Railway vs 7 s on Netlify) is
  controlled by `process.env.RAILWAY_ENVIRONMENT` / `RAILWAY_PROJECT_ID` checks
  inside `ebay-offers.service.ts`.

### Adding a New Netlify Function (during migration)

If you must add a new Netlify function (discouraged — prefer Express):
1. Create `netlify/functions/my-function.ts` with `export const handler`.
2. **Immediately** add a row to `docs/endpoints-migration.md` with
   `status: not-started` — otherwise `check:inventory` will fail CI.
3. If runtime > 10 s, add a `[functions.my-function]` timeout override in
   `netlify.toml`.
4. Open a follow-up ticket to port it to Express.
