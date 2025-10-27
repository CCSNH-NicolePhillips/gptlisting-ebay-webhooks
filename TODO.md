# TODO

## Now
- [ ] CHUNK-21: Taxonomy registry (store, select, autofill, wire into draft)
- [ ] BG HEAD checker: parallel 6 + 2s timeout (Dropbox)
- [ ] PHASE-0: Add auth-admin.ts, auth-user.ts, http.ts, user-keys.ts.
- [ ] PHASE-0: Wrap admin endpoints with requireAdminAuth + json() (no logic change).
- [ ] PHASE-0: Update background worker to accept userId and optional job key override.
- [ ] PHASE-0: Guard external eBay calls with EBAY_DRY_RUN + PUBLISH_MODE.
- [ ] PHASE-0: Add .eslintignore and scoped lint scripts.
- [ ] PHASE-0: Run smoke (admin jobs list/detail, preflight).

## Next
- [ ] Provider router + vision batch cache (env switch OpenAI/Anthropic/Gemini)
- [ ] Jobs dashboard polish: filter/search/export
- [ ] Chunk 14 — reliable market price lookup + fallback bands

## Later
- [ ] Auto Price Reduction (native Sell API block on Offer)
- [ ] Internal Market Price Fetcher (Amazon/Walmart APIs, brand JSON-LD, headless fallback)

## Blocked
- [ ] Obtain EBAY_* policy IDs in production
- [ ] Increase OpenAI tier or add Anthropic/Gemini keys

## Done
- [ ] ✅ Add “Create Drafts” button on job detail (posts mapped groups to ebay-create-draft) – commit 794de3b
- [ ] ✅ BG worker split (`analyze-images-bg` trigger + `analyze-images-background` true background) – PR #123
- [ ] ✅ Pricing formula + warnings – PR #118
