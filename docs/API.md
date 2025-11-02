# API Surface

## POST /.netlify/functions/analyze-images
Body: {"images": [url...], "batchSize": 12}
Resp: { status, info, summary, warnings?, groups? }

Smoke (bash):
curl -s -X POST "$BASE/.netlify/functions/analyze-images" \
 -H "Content-Type: application/json" \
 -d '{"images":["https://...jpg"],"batchSize":12}' | jq .
**Purpose**: Foreground image analysis without auth. Intended for admin tooling and background jobs that run from trusted origins only.

**Request Body**

```json
{
	"images": ["https://..."],
	"batchSize": 12
}
```

- `images` — array of https URLs; duplicates are deduped server-side.
- `batchSize` — optional chunking hint (min 4, max 12). Defaults to 12.

**Response**

```json
{
	"status": "ok",
	"info": "Image analysis complete (pricing skipped)",
	"summary": { "batches": 1, "totalGroups": 2 },
	"warnings": ["Skipped 1 unreachable image."],
	"groups": [ ... ]
}
```

- `groups` mirrors `AnalysisResult` from `src/lib/analyze-core.ts` with brand/product/variant/size/claims/images etc.
- Returns HTTP `202` with redirect instructions when >3 images (see background variant).

**Example**

```bash
curl -s -X POST "$BASE/.netlify/functions/analyze-images" \
	-H "Content-Type: application/json" \
	-d '{"images":["https://example.com/photo.jpg"],"batchSize":12}' | jq .
```

## POST /.netlify/functions/analyze-images-bg
**Purpose**: Queue large image batches (>3 URLs) for asynchronous processing.

**Request Body**

```json
{
	"images": ["https://..."],
	"batchSize": 12
}
```

**Response**

```json
{
	"jobId": "job_01HXYZ...",
	"state": "queued"
}
```

Use the job id with the status endpoint below. Returns `401` if the caller lacks a user bearer token.

**Example**

```bash
curl -s -X POST "$BASE/.netlify/functions/analyze-images-bg-user" \
	-H "Authorization: Bearer $TOKEN" \
	-H "Content-Type: application/json" \
	-d '{"images":["https://example.com/photo.jpg"],"batchSize":12}'
```

## GET /.netlify/functions/analyze-images-status?jobId=...
Resp: { state: pending|running|complete|error, groups?, warnings?, summary? }
Notes: Requires the same user bearer token used to create the job. `complete` payload mirrors foreground `runAnalysis` result. `error` state includes `message` when available.

## GET /.netlify/functions/analyze-jobs?limit=50
Resp: { jobs:[JobSummary], count }
Notes: Auth required. Returns 503 if Redis (Upstash) not configured.

## GET /.netlify/functions/analyze-job?jobId=...
Resp: { job }
Notes: 404 when the job is missing/expired.

## POST /.netlify/functions/ai-gpt-drafts
**Purpose**: Transform SmartDraft product seeds into listing copy using OpenAI Chat Completions.

**Request Body** (array truncated)

```json
{
	"seeds": [
		{
			"id": "grp_abc123",
			"brand": "Frog Fuel",
			"product": "Performance Greens + Protein",
			"variant": "Lemon Lime",
			"size": "25 oz",
			"features": ["supports recovery", "greens blend"],
			"keywords": ["supplement"]
		}
	]
}
```

**Response**

```json
{
	"ok": true,
	"count": 1,
	"drafts": [
		{
			"id": "grp_abc123",
			"title": "Frog Fuel Performance Greens + Protein Powder 25 oz",
			"bullets": ["Supports recovery", "25 servings", "Greens & protein"],
			"description": "...",
			"aspects": { "Brand": ["Frog Fuel"], "Size": ["25 oz"] },
			"category": { "name": "Dietary Supplements", "id": "180947" }
		}
	]
}
```

- Retries OpenAI up to twice (configurable via `GPT_RETRY_ATTEMPTS`).
- Errors return `ok:false` with HTTP 500 and `error` string. Synthetic drafts with `description` starting `ERROR:` are returned when individual seeds fail.

**Example**

```bash
curl -s -X POST "$BASE/.netlify/functions/ai-gpt-drafts" \
	-H "Authorization: Bearer $TOKEN" \
	-H "Content-Type: application/json" \
	-d '{"seeds":[{"product":"Demo","features":[]}]}'
```

## POST /.netlify/functions/smartdrafts-scan-bg
**Purpose**: Enqueue a SmartDraft Dropbox scan as a background job. The caller immediately receives a `jobId` and should poll the status endpoint below until the job settles.

**Request Body**

```json
{
	"path": "/EBAY",
	"limit": 100,
	"force": false
}
```

- `path` — Dropbox folder to scan; defaults to `/EBAY` when omitted.
- `limit` — optional safety ceiling (max 100) to reduce image fetches during testing.
- `force` — when `true`, bypasses the cached result even if the Dropbox signature matches.

**Response**

```json
{
	"ok": true,
	"jobId": "ad1a8bb4-0c8a-4a6b-b9c1-3f6d7405c9a1"
}
```

The job will fail with `429 Too Many Requests` if the caller already has the maximum number of running SmartDraft jobs.

**Example**

```bash
curl -s -X POST "$BASE/.netlify/functions/smartdrafts-scan-bg" \
	-H "Authorization: Bearer $TOKEN" \
	-H "Content-Type: application/json" \
	-d '{"path":"/EBAY","force":true}' | jq .
```

## GET /.netlify/functions/smartdrafts-scan-status
**Purpose**: Retrieve the latest state of an enqueued SmartDraft scan. Returns `state: "pending" | "running" | "complete" | "error"`.

**Query Parameters**

| Name   | Type   | Notes |
|--------|--------|-------|
| `jobId` | string | Required. The identifier returned by the enqueue endpoint. |

**Response (complete)**

```json
{
	"jobId": "ad1a8bb4-0c8a-4a6b-b9c1-3f6d7405c9a1",
	"state": "complete",
	"folder": "/EBAY",
	"cached": false,
	"signature": "sha1:...",
	"count": 6,
	"warnings": ["Vision fallback used"],
	"groups": [
		{
			"groupId": "grp_abc123",
			"name": "Acme Vitamin C (120ct)",
			"brand": "Acme",
			"claims": ["Immune support"],
			"images": ["https://..."],
			"category": { "title": "Vitamins", "id": "180959" }
		}
	],
	"orphans": [
		{ "url": "https://.../loose.jpg", "name": "loose.jpg", "folder": "/EBAY/Loose" }
	]
}
```

Completed payloads mirror the historical synchronous API response. `state: "error"` includes an `error` field describing the failure.

## GET /.netlify/functions/dropbox-list-folders
**Purpose**: Enumerate Dropbox folders for the signed-in merchant. Backed by the saved OAuth refresh token and intended for folder pickers.

**Query Parameters**

| Name      | Type    | Notes |
|-----------|---------|-------|
| `path`    | string  | Optional root path (`""` lists drive root); defaults to empty string. |
| `recursive` | boolean | Accepts `1`/`true`; when set, walks the entire subtree. |

**Response**

```json
{
	"ok": true,
	"path": "",
	"recursive": true,
	"count": 42,
	"folders": [ { ".tag": "folder", "path_display": "/EBAY" }, ... ]
}
```

- Requires an authenticated bearer token tied to a user who previously connected Dropbox.
- Returns `400` with `Connect Dropbox first` if no refresh token is on file.

**Example**

```bash
curl -s "$BASE/.netlify/functions/dropbox-list-folders?recursive=1" \
	-H "Authorization: Bearer $TOKEN" | jq '.count'
```

## GET /.netlify/functions/dropbox-list-images
**Purpose**: Produce direct (and proxied) image URLs for a Dropbox folder so SmartDrafts and listing tools can preview photos.

**Query Parameters**

| Name        | Type    | Notes |
|-------------|---------|-------|
| `path`      | string  | Folder to scan; defaults to `/EBAY`. |
| `recursive` | boolean | When `true`, includes nested folders. |
| `limit`     | number  | Optional hard cap on returned images. |
| `useProxy`  | boolean | Defaults to `1`; wraps URLs via `/.netlify/functions/image-proxy` when enabled. |

**Response**

```json
{
	"ok": true,
	"folder": "/EBAY",
	"count": 12,
	"items": [
		{
			"name": "sku123_01.jpg",
			"path": "/EBAY/sku123_01.jpg",
			"url": "https://dl.dropboxusercontent.com/...",
			"proxiedUrl": "https://app/.netlify/functions/image-proxy?..."
		}
	]
}
```

- Only lists files matching common image extensions; price sheets and non-images are omitted.
- Uses Dropbox shared links behind the scenes; repeated calls reuse existing links when present.

**Example**

```bash
curl -s "$BASE/.netlify/functions/dropbox-list-images?path=/EBAY/ToList&limit=5" \
	-H "Authorization: Bearer $TOKEN" | jq '.items[].proxiedUrl'
```

## GET /.netlify/functions/dropbox-list-grouped
**Purpose**: Legacy SKU-based grouping for Dropbox assets (`SKU_01.jpg`, `SKU_02.jpg`, `SKU_price.png`, …). Useful for the original listing wizard.

**Query Parameters**

| Name        | Type    | Notes |
|-------------|---------|-------|
| `path`      | string  | Folder prefix (default `/EBAY`). |
| `recursive` | boolean | Deep scan toggle. |
| `limit`     | number  | Optional group limit when testing. |
| `useProxy`  | boolean | Wraps image URLs via `image-proxy` when `1` (default). |
| `sku` / `skuPrefix` | string | When provided, filters to SKUs beginning with this prefix. |

**Response**

```json
{
	"ok": true,
	"folder": "/EBAY",
	"count": 3,
	"items": [
		{
			"sku": "SKU123",
			"images": ["https://.../SKU123_01.jpg", "https://.../SKU123_02.jpg"],
			"priceImage": "https://.../SKU123_price.png",
			"raw": { "main": "https://...", "others": ["https://..."], "price": "https://..." }
		}
	]
}
```

- Requires the same Dropbox OAuth context as other Dropbox endpoints.
- Ignores files without an underscore and enforces that at least one image exists per SKU.

**Example**

```bash
curl -s "$BASE/.netlify/functions/dropbox-list-grouped?path=/EBAY&sku=SKU" \
	-H "Authorization: Bearer $TOKEN" | jq '.items[0].images'
```

## GET|POST /.netlify/functions/dropbox-oauth-start
**Purpose**: Kick off the Dropbox OAuth 2.0 consent screen for the signed-in user.

- Accepts `returnTo` as either a JSON body field or query string; must be a relative path starting with `/`.
- When the client sends `Accept: application/json` (or `?mode=json=1`) the handler responds with `{ "redirect": "https://www.dropbox.com/oauth2/authorize?..." }`; otherwise it issues a `302` redirect.
- Requires a valid user bearer token so the issued OAuth state can be bound to that user.

**Example**

```bash
curl -s "$BASE/.netlify/functions/dropbox-oauth-start?mode=json=1" \
	-H "Authorization: Bearer $TOKEN" | jq '.redirect'
```

## GET /.netlify/functions/dropbox-oauth-callback
**Purpose**: Complete the Dropbox OAuth flow, persist the refresh token in Netlify Blobs, and send the user back to the app.

- Expects `code` and `state` query parameters from Dropbox.
- Validates and consumes the opaque state generated by `dropbox-oauth-start`; responds with `400` if the state is invalid or expired.
- On success stores `{ refresh_token }` under `users/{sub}/dropbox.json` and redirects (302) to the original `returnTo` value (default `/index.html`).

**Example**

```text
GET /.netlify/functions/dropbox-oauth-callback?code=...&state=...
302 Location: /setup.html
```

## GET /.netlify/functions/ebay-category-browse
**Purpose**: Browse eBay’s taxonomy tree for the configured marketplace (defaults to `EBAY_US`). Used by the listing wizard’s category picker.

**Query Parameters**

| Name         | Type   | Notes |
|--------------|--------|-------|
| `categoryId` | string | Optional. When absent, returns the root node and immediate children. When supplied, returns that subtree plus its breadcrumb trail. |

**Response**

```json
{
	"ok": true,
	"treeId": "0",
	"node": { "id": "0", "name": "Root", "path": "Root", "leaf": false },
	"children": [
		{ "id": "183454", "name": "Health & Beauty", "path": "Root > Health & Beauty", "leaf": false }
	],
	"breadcrumbs": [{ "id": "0", "name": "Root", "path": "Root", "leaf": false }]
}
```

- Uses the eBay application token, so no user auth is required.
- Returns `500` if the marketplace tree id cannot be resolved.

**Example**

```bash
curl -s "$BASE/.netlify/functions/ebay-category-browse?categoryId=177735" | jq '.children[].name'
```

## GET /.netlify/functions/ebay-category-suggestions
**Purpose**: Fetch keyword-based category suggestions from eBay’s taxonomy service.

**Query Parameters**

| Name | Type   | Notes |
|------|--------|-------|
| `q`  | string | Required search phrase (1–350 chars). |

**Response**

```json
{
	"ok": true,
	"treeId": "0",
	"suggestions": [
		{
			"categoryId": "180947",
			"categoryName": "Dietary Supplements",
			"categoryPath": "Health & Beauty > Vitamins & Lifestyle Supplements > Dietary Supplements",
			"relevance": 0.82
		}
	]
}
```

- Responds with `400` when `q` is missing.
- Internally reuses the default marketplace tree and eBay app token; no user auth needed.

**Example**

```bash
curl -s "$BASE/.netlify/functions/ebay-category-suggestions?q=protein" | jq '.suggestions[0]'
```

## GET /.netlify/functions/ebay-category-requirements
**Purpose**: Retrieve required item specifics and allowed conditions for a leaf category. Prefers a stored user OAuth token to reach the eBay Sell Metadata APIs but falls back to the app token when available.

**Query Parameters**

| Name       | Type   | Notes |
|------------|--------|-------|
| `categoryId` | string | Required eBay taxonomy id. Must reference a leaf category or a `400 category-not-leaf` error is returned. |
| `treeId`     | string | Optional override for non-default trees. When omitted the handler resolves the marketplace’s default tree. |

**Response**

```json
{
	"ok": true,
	"marketplaceId": "EBAY_US",
	"treeId": "0",
	"categoryId": "180947",
	"allowedConditions": [ { "id": "1000", "name": "New" } ],
	"requiredAspects": [
		{
			"localizedAspectName": "Brand",
			"aspectConstraint": { "aspectRequired": true }
		}
	],
	"optionalAspects": [ ... ],
	"raw": { "aspects": [...] }
}
```

- Returns `400` if `categoryId` is missing or if the category still has children.
- Proxies errors from eBay taxonomy/metadata endpoints (propagates HTTP status and body when non-OK).
- Requires the server to have either the app credentials configured or a stored user refresh token (for richer condition data).

**Example**

```bash
curl -s "$BASE/.netlify/functions/ebay-category-requirements?categoryId=180947" | jq '.requiredAspects[].localizedAspectName'
```

## POST /.netlify/functions/ebay-create-draft
Body: {
	items?: [ { inventory:{...}, offer:{...} } ],
	groups?: [TaxonomyGroup]
}
Resp: {
	dryRun:true,
	count,
	previews:[{ sku,title,price,quantity,categoryId,marketplaceId,aspects,meta }],
	invalid:[{ index,error,sku?,meta? }]
} | {
	dryRun:false,
	created,
	results:[{ offerId, sku, status, offer, meta?, draft? }],
	failures:[{ sku,error,detail?,meta?, draft? }],
	invalid:[{ index,error,sku?,meta? }]
}
Notes: When `groups` are provided, the function maps them server-side using the taxonomy registry and includes `_meta` with selected category + missing specifics for UI previews.

## POST /.netlify/functions/taxonomy-upsert
Body: CategoryDef (see taxonomy-schema.ts)
Resp: { ok:true, slug, version }

## GET /.netlify/functions/taxonomy-list
Resp: { categories: [CategoryDef...] }

## GET /.netlify/functions/taxonomy-get?slug=<slug>
Resp: CategoryDef

(…add new endpoints here as they’re created)
