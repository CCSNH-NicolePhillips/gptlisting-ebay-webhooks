# 🧹 Repository Cleanup Plan

**Branch:** `cleanup/remove-dead-code`  
**Created:** January 2, 2026  
**Completed:** January 2, 2026  
**Purpose:** Remove dead code, deprecated files, and development artifacts

## ✅ Summary

| Phase | Description | Files Removed | Status |
|-------|-------------|---------------|--------|
| Phase 1 | Deprecated source files | 13 files | ✅ DONE |
| Phase 2 | Triage/temp folders | 13 files | ✅ DONE |
| Phase 3 | Reference folder + tests | 2 files | ✅ DONE |
| Phase 4 | Root-level cruft | 108 files | ✅ DONE |
| **Total** | | **136 files** | ✅ |

**Test Status:** 3253 passed, 2 skipped (down from 3300 - removed 47 duplicate tests)

---

## ✅ PHASE 1: Deprecated Source Files (COMPLETED)

### 1.1 Deleted: src/routes/ (6 files)

| # | File | Status |
|---|------|--------|
| 1 | `src/routes/admin.ts` | ✅ Deleted |
| 2 | `src/routes/auth-dropbox.ts` | ✅ Deleted |
| 3 | `src/routes/auth-ebay.ts` | ✅ Deleted |
| 4 | `src/routes/offers.ts` | ✅ Deleted |
| 5 | `src/routes/process.ts` | ✅ Deleted |
| 6 | `src/routes/setup.ts` | ✅ Deleted |

### 1.2 Deleted: src/services/ (3 files)

| # | File | Status |
|---|------|--------|
| 7 | `src/services/dropbox.ts` | ✅ Deleted |
| 8 | `src/services/ebay.ts` | ✅ Deleted |
| 9 | `src/services/listing-enrichment.ts` | ✅ Deleted |

### 1.3 Deleted: src/lib/ (3 files)

| # | File | Status |
|---|------|--------|
| 10 | `src/lib/clip-client.ts` | ✅ Deleted |
| 11 | `src/lib/directPairing.ts` | ✅ Deleted |
| 12 | `src/lib/directPairingJobs.ts` | ✅ Deleted |

### 1.4 Deleted: Root Entry Point

| # | File | Status |
|---|------|--------|
| 13 | `src/index.ts` | ✅ Deleted |

---

## ✅ PHASE 2: Triage/Temp Folders (COMPLETED)

| # | Folder | Status |
|---|--------|--------|
| 14 | `_triage_local_upload_2025-12-19/` | ✅ Deleted |
| 15 | `_pricing_triage_dump/` | ✅ Deleted |
| 16 | `backups/` | ✅ Deleted |
| 17 | `chatgpt/` | ✅ Deleted |
| 18 | `logs/` | ✅ Deleted |
| 19 | `chatgpt-temp/` | ✅ Deleted |

---

## ✅ PHASE 3: Reference Folder (COMPLETED)

| # | Item | Status |
|---|------|--------|
| 20 | `ebay-promote-integration/` | ✅ Deleted |
| 21 | `tests/ebay-promote-integration/` | ✅ Deleted |

---

## ✅ PHASE 4: Root-Level Cruft (COMPLETED)

### Deleted Test Output Files (15 files)

- `ebay09-final-test.txt`, `ebay09-full-test.txt`, `ebay09-pricing-test.txt`
- `ebay09-summary.txt`, `ebay09-test-full-output.txt`, `ebay09-test-results.txt`
- `ebay10-pricing-test.txt`, `ebay10-problem-products.txt`, `ebay10-scan-output.txt`
- `hermon-test.txt`, `test-brand-results.txt`, `test-output-full.txt`
- `test-output-phase1.txt`, `test-output.txt`, `logs.txt`

### Deleted Test Script Files (7 files)

- `test-inventory-api.mjs`, `test-js-price-detection.mjs`, `test-price-extraction-fix.mjs`
- `test-simple-token.mjs`, `test-with-browser-token.mjs`, `test-with-token.mjs`
- `test-aspect-logic.html`

### Deleted Analysis Docs (4 files)

- `PHASE3-PRICING-REVIEW.md`, `PRICING-FIX-VALIDATION.md`
- `PRICING-REGRESSION-ANALYSIS-JAN-2026.md`, `SEARCHAPI-INTEGRATION-SUMMARY.md`

### Deleted Misc Files (3 files)

- `public.zip`, `deno.lock`, `index.ts` (root)

### Deleted Folders

- `testDropbox/` (test images)
- `tmp/` (temporary files)

---

## 📋 Kept Files (Still Useful)

These files were reviewed and kept:

| File | Reason |
|------|--------|
| `GET-REFRESH-TOKEN.md` | Useful documentation |
| `GET-TOKEN-INSTRUCTIONS.md` | Useful documentation |
| `QUICKSTART-INGESTION.md` | Useful documentation |
| `TODO.md` | Active task tracking |
| `copilot/` | Copilot context docs |
| `docs/` | All documentation kept |

---

## Git Commits

| Commit | Description |
|--------|-------------|
| `186593e` | Phase 1: Remove deprecated source files |
| `541f2cd` | Phase 2: Remove triage and temp folders |
| `6bcc562` | Phase 3: Remove ebay-promote-integration |
| `8ad7066` | Phase 4: Remove root-level cruft |

---

## 📊 Final Stats

- **Files removed:** 138 files
- **Lines deleted:** ~10,800 lines
- **Tests remaining:** 3253 passed, 2 skipped
- **Build status:** ✅ Passing
