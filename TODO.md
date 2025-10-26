# TODO

## Now
- [ ] CHUNK-21: Taxonomy registry (store, select, autofill, wire into draft)
- [ ] BG HEAD checker: parallel 6 + 2s timeout (Dropbox)

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
