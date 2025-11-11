# SmartDrafts & Taxonomy Updates — 2025-11-10

# Overview
Tracking SmartDrafts / taxonomy work completed the week of **2025-11-03 → 2025-11-10**.

## Timeline recap
- **Nov 3–5**: Added deep logging across SmartDrafts pipeline (`map-group-to-draft`, `taxonomy-map`, `taxonomy-autofill`, `create-ebay-draft-user`) to trace aspect loss issues.
- **Nov 6**: Fixed aspect drop by always invoking `buildItemSpecifics()` even when a taxonomy match fails. Added fallback `CategoryDef` to preserve ChatGPT-generated Brand/Type/etc.
- **Nov 7**: Integrated `/.netlify/functions/image-proxy` into SmartDrafts image flow so EXIF rotation is stripped before sending to eBay.
- **Nov 8**: Ensured ChatGPT descriptions are written through by preferring `group.description` when present.
- **Nov 9**: Refined taxonomy matching (title/slug exact matches, multi-part path matching, haystack keyword enhancement). Added default inventory package dimensions to satisfy eBay shipping validation. Hardened `ebay-category-browse` Netlify handler with fallbacks, logging, and defensive checks.
- **Nov 10**: Documented outstanding issues (missing draft, book pricing, incomplete taxonomy cache) and began planning Redis seeding to avoid taxonomy API rate limits.

## Code changes shipped (latest state)
- Preserve ChatGPT descriptions by using `group.description` when available.
- Proxy SmartDrafts product images through `/.netlify/functions/image-proxy` so EXIF rotation fixes reach eBay.
- Always build item specifics via fallback category to keep GPT-supplied aspects.
- Improve category selection heuristics to reduce defaulting to catch-all category `177011`.
- Add default package dimensions (6"×4"×3", 1 lb) to inventory payloads to satisfy eBay shipping rules.
- Harden `ebay-category-browse` (fallback tree id, better logging, HTTP/missing-node guards).

## Operational notes
- eBay taxonomy browsing is currently rate-limited (HTTP 429). Until the Redis taxonomy cache is fully seeded, browse requests may fall back to tree id `0`.
- SmartDrafts pricing still mirrors ChatGPT output; books are trending high and may require post-processing caps.
- Latest SmartDrafts job created only 3 of 4 drafts—need to inspect the stored job payload (`smartdrafts:job:<jobId>`) to identify the skipped group.

## Follow-up actions
1. Seed Redis taxonomy cache with remaining categories (especially Books) so SmartDrafts and the draft wizard resolve correct IDs and stop hitting eBay live taxonomy.
2. Add price normalization rules for books (e.g., cap at $24.99 or require supporting data) if GPT overshoots market pricing.
3. Investigate the missing fourth SmartDrafts item and improve UI/logging so skipped groups surface clearly.
4. After seeding taxonomy, retest both `/new-smartdrafts/` and the draft wizard browse modal to confirm no regressions and that item condition/category errors clear.
