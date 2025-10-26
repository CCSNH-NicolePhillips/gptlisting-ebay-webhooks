# API Surface

## POST /.netlify/functions/analyze-images
Body: {"images": [url...], "batchSize": 12}
Resp: { status, info, summary, warnings?, groups? }

Smoke (bash):
curl -s -X POST "$BASE/.netlify/functions/analyze-images" \
 -H "Content-Type: application/json" \
 -d '{"images":["https://...jpg"],"batchSize":12}' | jq .

## POST /.netlify/functions/analyze-images-bg
Body: {"images":[...], "batchSize": 12}
Resp: {"jobId":"..."}

## GET /.netlify/functions/analyze-images-status?jobId=...
Resp: { state: pending|running|complete|error, groups?, warnings?, summary? }

## GET /.netlify/functions/analyze-jobs?limit=50
Resp: { jobs:[JobSummary], count }
Notes: Auth required. Returns 503 if Redis (Upstash) not configured.

## GET /.netlify/functions/analyze-job?jobId=...
Resp: { job }
Notes: 404 when the job is missing/expired.

## POST /.netlify/functions/ebay-create-draft
Body: { items: [ { inventory:{...}, offer:{...} } ] }
Resp: { dryRun:true,count,note } | { ok:true, created, results:[{offerId, sku}] }

## POST /.netlify/functions/taxonomy-upsert
Body: CategoryDef (see taxonomy-schema.ts)
Resp: { ok:true, slug, version }

## GET /.netlify/functions/taxonomy-list
Resp: { categories: [CategoryDef...] }

## GET /.netlify/functions/taxonomy-get?slug=<slug>
Resp: CategoryDef

(…add new endpoints here as they’re created)
