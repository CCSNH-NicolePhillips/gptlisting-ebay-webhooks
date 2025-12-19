# Copilot Instructions: eBay Listing Automation (SmartDrafts)

## Project Overview
Netlify Functions + TypeScript serverless app for automating eBay listing creation via multi-stage AI pipeline: Vision classification → Product pairing → eBay draft generation. Integrates Dropbox/local uploads (via ingestion adapters), OpenAI GPT-4o-mini vision, and eBay Inventory API.

## Core Architecture

### SmartDrafts Pipeline (Three Stages)
1. **Scan/Vision** (`src/lib/smartdrafts-scan-core.ts` + `src/smartdrafts/pairing-v2-core.ts`): 
   - GPT-4o-mini classifies images (product/non-product, front/back/side panels)
   - Extracts brand, productName, title (books), packageType, colorSignature, layoutSignature
   - Supports batched processing (12 images/call, configurable concurrency)

2. **Pairing** (`src/smartdrafts/pairing-v2-core.ts`): 
   - Matches fronts with backs using metadata-only GPT-4o reasoning
   - Two-pass pairing: strict text match → aggressive visual match
   - Verification stage catches pairing errors
   - Returns `PairingResult` with pairs, unpaired items, and metrics

3. **Draft Creation** (`netlify/functions/smartdrafts-create-drafts-background.ts`): 
   - GPT-4o generates eBay listings (title, description, bullets, aspects, categoryId)
   - Web search for current retail pricing (Amazon/Walmart)
   - Creates eBay Inventory items + Offers via Sell API

### Background Job Pattern (Upstash Redis)
Long-running tasks use Redis-backed job queues with polling:
- **Initiator** (e.g., `smartdrafts-scan-bg.ts`): Creates job in Redis → invokes background worker → returns `jobId`
- **Worker** (e.g., `smartdrafts-scan-background.ts`): Processes job (10min timeout), updates status in Redis
- **Status** (`smartdrafts-scan-status.ts`): Client polls Redis until `state: "complete"`

Job keys use pattern: `job:{userId}:{jobId}` (see `src/lib/user-keys.ts`)

### Serverless Functions (`netlify/functions/`)
- All endpoints are Netlify Functions with `Handler` export
- Default 10s timeout; overridden to 26s (`smartdrafts-create-drafts`) or 600s (`pairing-v2-processor-background`) in `netlify.toml`
- Auth via Auth0 JWT validation (`src/lib/auth-user.ts`) - requires `Authorization: Bearer <token>` header
- Shared utilities in `src/lib/`, business logic in `src/services/`, `src/smartdrafts/`

## Critical Patterns

### Safety Toggles (ALWAYS RESPECT)
- **`EBAY_ENV`**: `SANDBOX` | `PROD` (default: `PROD`) - Controls eBay API endpoints via `tokenHosts()` in `src/lib/_common.ts`
- **`PUBLISH_MODE`**: `draft` | `post` | `legacy-post` (default: `draft`) - See `src/config.ts`
- **`dryRun` parameter**: When true, functions return preview without external API calls (checked in `src/lib/ebay-adapter.ts`, `ebay-sell.ts`)

### Vision API (OpenAI)
- **Model**: Default `gpt-4o-mini` (cheaper, faster), configurable via `VISION_MODEL` env var
- **Batching**: Max 12 images per Vision API call (`CLASSIFY_BATCH_SIZE = 12` in `pairing-v2-core.ts`) to avoid token truncation
- **Concurrency**: Default 2 parallel vision calls (`config.visionConcurrency` from `src/config/smartdrafts.ts`), max 16
- **Retries**: Auto-retry failed batches 2x with 2s delay (`MAX_RETRIES = 2`)
- **Fallback chain**: gpt-4o-mini → gpt-4o on rate limit (`src/lib/vision-router.ts`)
- **Image encoding**: Base64 data URLs with MIME type detection (`encodeImageToBase64()`)

### Pairing System (Metadata-Only GPT Reasoning)
Two-pass pairing in `pairFromClassifications()`:
1. **Pass 1**: Strict text matching (brand + productName must match)
2. **Pass 2**: Aggressive visual matching (colorSignature + layoutSignature + packageType)
3. **Verification**: Independent validation catches mismatches

Returns `PairingResult` with:
- `pairs[]`: front/back pairs with confidence scores
- `unpaired[]`: singletons with reason codes
- `metrics`: pair rates, brand breakdown, reason histogram

### Storage & Caching
- **Netlify Blobs** (`src/lib/_blobs.ts`): OAuth tokens (`tokensStore()`), taxonomy cache (`cacheStore()`)
- **Upstash Redis REST** (`src/lib/job-store.ts`): Job state, price cache, user settings
- **Redis TTL**: 48 hours for jobs, 7 days for price cache
- **User-scoped keys** (`src/lib/user-keys.ts`): `job:{userId}:{jobId}`, `price:{userId}:{jobId}:{groupId}`

### eBay API Integration
- **Inventory API** (`src/lib/ebay-sell.ts`): Create inventory items + offers (primary API)
- **Token management** (`src/lib/ebay-auth.ts`): Refresh tokens stored in Blobs, access tokens cached in-memory
- **Marketing API** (`src/lib/ebay-promote.ts`): Promoted Listings auto-creation
- **Location check** (`ensureInventoryLocation()`): Validates merchant location before offer creation
- **Error handling**: eBay returns 200 with `errors[]` array - always check payload structure

## Development Workflows

### Build & Test
```powershell
npm run build              # TypeScript → dist/
npm run lint               # ESLint (no warnings allowed in CI)
npm run typecheck          # tsc --noEmit
npm test                   # Jest with lint pre-flight
npm run test:coverage      # Jest coverage report
```

### Local Development
```powershell
netlify dev                # Runs functions on :8888
ngrok http 8888            # HTTPS tunnel for eBay OAuth (requires HTTPS callbacks)
```

**Critical**: Update `EBAY_RUNAME` redirect URL when ngrok URL changes (or use paid ngrok with fixed subdomain)

### Testing eBay Integration
Always test against SANDBOX first:
1. Set `EBAY_ENV=SANDBOX` in `.env`
2. Use sandbox credentials from eBay Developer Portal
3. Verify in sandbox before switching to `EBAY_ENV=PROD`

### Smoke Testing (`scripts/smoke.sh` or `scripts/smoke.ps1`)
Run smoke tests after changes to verify endpoints work end-to-end with real API calls

## Code Organization

### Key Directories
- `netlify/functions/`: All serverless endpoints (170+ functions)
- `src/lib/`: Shared utilities
  - `auth-user.ts`, `auth-admin.ts`: Auth0 JWT validation
  - `ebay-adapter.ts`, `ebay-sell.ts`: eBay Inventory/Sell API wrappers
  - `ebay-promote.ts`: Marketing API for Promoted Listings
  - `vision-router.ts`: Multi-provider vision (OpenAI, Anthropic, Google)
  - `job-store.ts`: Upstash Redis job management
  - `_blobs.ts`, `_auth.ts`, `_common.ts`: Internal storage/auth primitives
- `src/smartdrafts/`: SmartDrafts pipeline core
  - `pairing-v2-core.ts`: Classification + Pairing logic
  - `analysisCore.ts`: Shared analysis wrapper
- `src/ingestion/`: Adapter pattern for file sources
  - `types.ts`: `IngestionAdapter` interface
  - `local.ts`, `dropbox.ts`: Concrete adapters
- `src/config/`: Centralized configuration
  - `smartdrafts.ts`: Vision concurrency, batch sizes
- `tests/`: Jest tests (mirrors src/ structure)
- `scripts/`: Test runners (tsx-based, e.g., `test-full-pipeline-local.ts`)
- `docs/`: Architecture docs (may be outdated - verify against code)

### Import Conventions
- TypeScript ES modules (`"type": "module"` in package.json)
- **CRITICAL**: Use `.js` extensions in imports: `import { foo } from './bar.js'`
  - Reason: TypeScript emits ES modules, Node expects .js extension
  - Example: `import { openai } from '../lib/openai.js'`
- Shared config: `src/config.ts` (main), `src/config/smartdrafts.ts` (pipeline-specific)

## Testing Conventions

### Jest Configuration (`jest.config.js`)
- Preset: `ts-jest/presets/default-esm` (ES module support)
- Test environment: `node`
- Test pattern: `tests/**/*.test.ts`
- **Coverage thresholds**: 80% branches, functions, lines, statements
- **Excluded from coverage**: Certain test files (`smartdrafts-scan-core.test.ts`, `pairing-v2-core.test.ts`)
- Mock OpenAI: `jest.mock('../src/lib/openai', () => ({ openai: { chat: { completions: { create: jest.fn() } } } }))`

### Test Structure
Tests mirror `src/` directory structure:
- `tests/lib/`: Unit tests for shared libraries
- `tests/smartdrafts/`: SmartDrafts pipeline tests
- `tests/pairing/`: Pairing system tests
- Example: `tests/pairing-v2-core.test.ts` tests `src/smartdrafts/pairing-v2-core.ts`

### Integration Tests (`scripts/`)
Use `tsx` to run TypeScript directly:
- `scripts/test-full-pipeline-local.ts`: End-to-end pipeline test
- `scripts/test-create-drafts-local.ts`: Draft generation test
- Run with: `tsx scripts/test-*.ts`

## Common Tasks

### Adding a New Netlify Function
1. Create `netlify/functions/my-function.ts`
2. Export `handler` with signature: `(event: HandlerEvent) => Promise<HandlerResponse>`
3. Add to `docs/API.md` with curl example
4. Add smoke test to `scripts/smoke.ps1`
5. If >10s runtime, add timeout override to `netlify.toml`

### Modifying Pairing Logic
1. Update scoring in `src/smartdrafts/pairing-v2-core.ts`
2. Run `npm run pairing` to test on sample data
3. Compare metrics: `npm run metrics:print pairing-metrics.json`
4. Update golden dataset if changes are blessed
5. Document threshold changes in `docs/PAIRING-SYSTEM.md`

### Adding eBay API Endpoints
1. Add method to `src/lib/ebay-adapter.ts` or `src/lib/ebay-promote.ts`
2. Respect `dryRun` flag for safety
3. Add token caching via `tokenCache` param
4. Handle errors gracefully (eBay returns 200 with error payloads)
5. Add tests in `tests/lib/ebay-adapter.test.ts`

## Environment Variables

### Required
- `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`: eBay app credentials
- `EBAY_RUNAME`: OAuth redirect URL name
- `OPENAI_API_KEY`: For GPT-4o vision & chat
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`: Upstash Redis credentials (REST API)
- `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`: Auth0 config for user JWT validation
- `AUTH_MODE`: `user` | `admin` | `mixed` (default: `admin`) - controls auth strategy

### Optional but Important
- `EBAY_ENV`: `SANDBOX` or `PROD` (default: `PROD`)
- `PUBLISH_MODE`: `draft`, `post`, or `legacy-post` (default: `draft`)
- `VISION_MODEL`: Vision model to use (default: `openai:gpt-4o-mini`)
- `VISION_CONCURRENCY`: Parallel vision requests (default: 2, max: 16)
- `PAIR_CANDIDATE_K`: Top-K candidates per front (default: 8)
- `MAX_FILES_PER_BATCH`: Max images per scan job (default: 200)
- `NETLIFY_BLOBS_SITE_ID`, `NETLIFY_BLOBS_TOKEN`: Netlify Blobs credentials (auto-provisioned in production)

### Storage Providers
- **Netlify Blobs**: Token storage, taxonomy cache (`tokensStore()`, `cacheStore()`)
- **Upstash Redis**: Job state, pricing cache, user settings (48hr TTL for jobs)
- **AWS S3/R2**: Image staging for ingestion pipeline (via `AWS_*` env vars)

### Full List
See `configs/prod.env.example` for complete environment variable reference

## Common Tasks

### Adding a New Netlify Function
1. Create `netlify/functions/my-function.ts`
2. Export `handler` with signature: `(event: HandlerEvent) => Promise<HandlerResponse>`
3. Add to `docs/API.md` with curl example
4. Add smoke test to `scripts/smoke.ps1`
5. If >10s runtime, add timeout override to `netlify.toml`

### Modifying Pairing Logic
1. Update scoring in `src/smartdrafts/pairing-v2-core.ts`
2. Run `npm run pairing` to test on sample data
3. Compare metrics: `npm run metrics:print pairing-metrics.json`
4. Update golden dataset if changes are blessed
5. Document threshold changes in `docs/PAIRING-SYSTEM.md`

### Adding eBay API Endpoints
1. Add method to `src/lib/ebay-adapter.ts` or `src/lib/ebay-promote.ts`
2. Respect `dryRun` flag for safety
3. Add token caching via `tokenCache` param
4. Handle errors gracefully (eBay returns 200 with error payloads)
5. Add tests in `tests/lib/ebay-adapter.test.ts`

## Anti-Patterns to Avoid

❌ **Don't** hardcode eBay sandbox/prod URLs → use `tokenHosts(process.env.EBAY_ENV)`
❌ **Don't** skip `dryRun` checks in eBay create/update functions
❌ **Don't** commit secrets or tokens → use environment variables
❌ **Don't** send >12 images per vision API call → causes JSON truncation
❌ **Don't** auto-publish to production → always require explicit `PUBLISH_MODE=post`
❌ **Don't** assume pairing is always front+back → handles front+side, back+side too
❌ **Don't** log eBay tokens or user refresh tokens → scrub sensitive data

## Documentation

- `docs/API.md`: Complete endpoint reference with curl examples
- `docs/COPILOT.md`: AI agent coding guidelines (deprecated, merged here)
- `docs/PAIRING-SYSTEM.md`: Pairing algorithm deep dive with metrics
- `docs/SMARTDRAFTS-CREATE-DRAFTS.md`: Draft generation pipeline
- `docs/LOCAL-DEVELOPMENT.md`: Setup guide for local testing
- `docs/OPERATIONS-RUNBOOKS.md`: Production troubleshooting

When in doubt about patterns, search existing `netlify/functions/` for similar examples.
