# 🧹 Repository Cleanup Plan

**Branch:** `cleanup/remove-dead-code`  
**Created:** January 2, 2026  
**Purpose:** Remove dead code, deprecated files, and development artifacts

---

## 🔴 PHASE 1: HIGH PRIORITY - Delete Dead Code

### 1.1 Deprecated Source Files (src/routes/)
These were replaced by Netlify Functions and are no longer used.

| # | File | Status | Notes |
|---|------|--------|-------|
| 1 | `src/routes/admin.ts` | `@deprecated` | ❌ DELETE |
| 2 | `src/routes/auth-dropbox.ts` | `@deprecated` | ❌ DELETE |
| 3 | `src/routes/auth-ebay.ts` | `@deprecated` | ❌ DELETE |
| 4 | `src/routes/offers.ts` | `@deprecated` | ❌ DELETE |
| 5 | `src/routes/process.ts` | `@deprecated` | ❌ DELETE |
| 6 | `src/routes/setup.ts` | `@deprecated` | ❌ DELETE |

### 1.2 Deprecated Source Files (src/services/)
These were replaced by Netlify Functions.

| # | File | Status | Notes |
|---|------|--------|-------|
| 7 | `src/services/dropbox.ts` | `@deprecated` | ❌ DELETE |
| 8 | `src/services/ebay.ts` | `@deprecated` | ❌ DELETE |
| 9 | `src/services/listing-enrichment.ts` | `@deprecated` | ❌ DELETE |

### 1.3 Deprecated Source Files (src/lib/)
These have newer versions.

| # | File | Status | Notes |
|---|------|--------|-------|
| 10 | `src/lib/clip-client.ts` | `@deprecated` | Use `clip-client-split.ts` |
| 11 | `src/lib/directPairing.ts` | `@deprecated` | Use `pairing-v2-core.ts` |
| 12 | `src/lib/directPairingJobs.ts` | `@deprecated` | Use `pairingV2Jobs.ts` |

### 1.4 Deprecated Root Files

| # | File | Status | Notes |
|---|------|--------|-------|
| 13 | `src/index.ts` | `@deprecated` | Old Express server entry |

---

## 🟠 PHASE 2: Development/Triage Folders

### 2.1 Triage Folders (merged work, safe to delete)

| # | Folder | Contents | Notes |
|---|--------|----------|-------|
| 14 | `_triage_local_upload_2025-12-19/` | 10 files | Old triage work, already merged |
| 15 | `_pricing_triage_dump/` | 4 items | Old pricing work, already merged |
| 16 | `backups/` | 1 file | Old HTML backup |

### 2.2 Empty/Temp Folders

| # | Folder | Contents | Notes |
|---|--------|----------|-------|
| 17 | `chatgpt/` | EMPTY | ❌ DELETE |
| 18 | `logs/` | EMPTY | ❌ DELETE |

### 2.3 ChatGPT Analysis Folders (temporary work)

| # | Folder | Contents | Notes |
|---|--------|----------|-------|
| 19 | `chatgpt-temp/` | 8 items | Old analysis work |
| 20 | `chatgpt-temp/active-listings-investigation/` | Unknown | Old investigation |
| 21 | `chatgpt-temp/dropbox-images-bug/` | Unknown | Bug fix work |
| 22 | `chatgpt-temp/image-mismatch-issue/` | Unknown | Bug fix work |
| 23 | `chatgpt-temp/pricing-analysis-dec-23-2025/` | Unknown | Old analysis |
| 24 | `chatgpt-temp/pricing-regression-analysis/` | Unknown | Old analysis |
| 25 | `chatgpt-temp/quick-list-analysis/` | Unknown | Old analysis |

---

## 🟡 PHASE 3: Reference/Development Folders

### 3.1 ebay-promote-integration/ (Development Reference)

| # | Item | Status | Notes |
|---|------|--------|-------|
| 26 | `ebay-promote-integration/` | Reference only | Code migrated to `src/lib/ebay-promote.ts` |

**⚠️ WARNING:** Has tests in `tests/ebay-promote-integration/` that import from it!
**Action:** Delete tests first, then delete folder

### 3.2 copilot/ (Documentation)

| # | Item | Contents | Notes |
|---|------|----------|-------|
| 27 | `copilot/` | 7 files | Copilot context docs - REVIEW before deleting |

### 3.3 testDropbox/ (Test Images)

| # | Item | Contents | Notes |
|---|------|----------|-------|
| 28 | `testDropbox/` | 10 folders | Test images - may be needed for local testing |

### 3.4 tmp/ (Temporary Files)

| # | Item | Contents | Notes |
|---|------|----------|-------|
| 29 | `tmp/` | 23 files | Various test outputs, HTML samples |

---

## 🔵 PHASE 4: Root-Level Cruft

### 4.1 Test Output Files (safe to delete)

| # | File | Notes |
|---|------|-------|
| 30 | `ebay09-final-test.txt` | Test output |
| 31 | `ebay09-full-test.txt` | Test output |
| 32 | `ebay09-pricing-test.txt` | Test output |
| 33 | `ebay09-summary.txt` | Test output |
| 34 | `ebay09-test-full-output.txt` | Test output |
| 35 | `ebay09-test-results.txt` | Test output |
| 36 | `ebay10-pricing-test.txt` | Test output |
| 37 | `ebay10-problem-products.txt` | Test output |
| 38 | `ebay10-scan-output.txt` | Test output |
| 39 | `hermon-test.txt` | Test output |
| 40 | `test-brand-results.txt` | Test output |
| 41 | `test-output-full.txt` | Test output |
| 42 | `test-output-phase1.txt` | Test output |
| 43 | `test-output.txt` | Test output |
| 44 | `logs.txt` | Old logs |

### 4.2 Test Script Files (review before deleting)

| # | File | Notes |
|---|------|-------|
| 45 | `test-inventory-api.mjs` | Manual test script |
| 46 | `test-js-price-detection.mjs` | Manual test script |
| 47 | `test-price-extraction-fix.mjs` | Manual test script |
| 48 | `test-simple-token.mjs` | Manual test script |
| 49 | `test-with-browser-token.mjs` | Manual test script |
| 50 | `test-with-token.mjs` | Manual test script |
| 51 | `test-aspect-logic.html` | Test HTML file |

### 4.3 Markdown Files (review before deleting)

| # | File | Notes |
|---|------|-------|
| 52 | `GET-REFRESH-TOKEN.md` | May be useful documentation |
| 53 | `GET-TOKEN-INSTRUCTIONS.md` | May be useful documentation |
| 54 | `PHASE3-PRICING-REVIEW.md` | Old work notes |
| 55 | `PRICING-FIX-VALIDATION.md` | Old work notes |
| 56 | `PRICING-REGRESSION-ANALYSIS-JAN-2026.md` | Old work notes |
| 57 | `SEARCHAPI-INTEGRATION-SUMMARY.md` | May be useful documentation |
| 58 | `TODO.md` | Review for active items |
| 59 | `QUICKSTART-INGESTION.md` | May be useful documentation |

### 4.4 Miscellaneous Files

| # | File | Notes |
|---|------|-------|
| 60 | `public.zip` | Archive file |
| 61 | `prod.env` | ⚠️ Should NOT be in repo! |
| 62 | `deno.lock` | Not using Deno |
| 63 | `index.ts` | Old entry point (root level) |
| 64 | `taxonomy-categories-EBAY_US.csv` | Data file - may be needed |

---

## ✅ EXECUTION CHECKLIST

### Phase 1: Deprecated Source Files
- [ ] 1. Delete `src/routes/` folder (6 files)
- [ ] 2. Delete `src/services/` folder (3 files)  
- [ ] 3. Delete deprecated `src/lib/` files (3 files)
- [ ] 4. Delete `src/index.ts`
- [ ] 5. Run tests: `npm test`
- [ ] 6. Commit: "chore: remove deprecated source files"

### Phase 2: Triage/Temp Folders
- [ ] 7. Delete `_triage_local_upload_2025-12-19/`
- [ ] 8. Delete `_pricing_triage_dump/`
- [ ] 9. Delete `backups/`
- [ ] 10. Delete `chatgpt/` (empty)
- [ ] 11. Delete `logs/` (empty)
- [ ] 12. Delete `chatgpt-temp/`
- [ ] 13. Run tests: `npm test`
- [ ] 14. Commit: "chore: remove triage and temp folders"

### Phase 3: Reference Folders
- [ ] 15. Delete `tests/ebay-promote-integration/` (tests for old code)
- [ ] 16. Delete `ebay-promote-integration/`
- [ ] 17. Run tests: `npm test`
- [ ] 18. Commit: "chore: remove ebay-promote-integration reference folder"

### Phase 4: Root Cruft
- [ ] 19. Delete test output `.txt` files (15 files)
- [ ] 20. Delete test `.mjs` scripts (6 files)
- [ ] 21. Move useful docs to `docs/` or delete
- [ ] 22. Delete `public.zip`, `deno.lock`, root `index.ts`
- [ ] 23. Move or gitignore `prod.env`
- [ ] 24. Run tests: `npm test`
- [ ] 25. Commit: "chore: remove root-level cruft"

### Final
- [ ] 26. Run full test suite
- [ ] 27. Build project
- [ ] 28. Merge to main

---

## 📊 Summary

| Phase | Items | Risk |
|-------|-------|------|
| Phase 1 | 13 files | Low - all marked deprecated |
| Phase 2 | 12 folders | Low - triage work already merged |
| Phase 3 | 2 folders | Medium - has tests pointing to it |
| Phase 4 | 35+ files | Low - mostly output/temp files |

**Total estimated items to delete:** ~65+ files/folders
