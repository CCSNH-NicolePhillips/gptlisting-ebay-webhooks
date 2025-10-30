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

## POST /.netlify/functions/smartdrafts-scan
Body: {"path":"/EBAY", "limit":100}
Resp: { ok:true, folder, signature?, cached?, count, warnings?, groups:[{ groupId, name, brand?, product?, variant?, size?, confidence?, claims?, category?, images[] }], orphans?:[{ url, name, folder }] }
Notes: Auth required (Bearer). Fetches up to 100 images from the user’s Dropbox folder, groups them via the vision pipeline, caches the result in Upstash, and falls back to folder-based grouping when vision is unavailable.
Warnings include analyzer notices and fallback messages. `signature` is a SHA1 of Dropbox rev metadata; when unchanged, cached results are returned with `cached:true`. `orphans` lists images that failed to map to any group (useful for refiling). Use `limit` to throttle scanning when testing.

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
