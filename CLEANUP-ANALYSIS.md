# Codebase Cleanup Analysis
Date: 2025-11-22

## Summary
This document identifies deprecated/unused code that can be safely removed from the codebase. Items are organized by category with confidence levels.

---

## 1. OLD PAIRING SYSTEM (Replaced by pairing-v2)

### HIGH CONFIDENCE - Safe to Delete

#### A. Legacy Pairing Pipeline (index.ts)
- **File**: `index.ts`
- **Functions**: 
  - `runLegacyPairingPipeline()` (lines 1519-1586)
  - All Pass 1/Pass 2 helper functions
- **Reason**: Replaced by `runPairingPipeline()` which uses the new pairing system. Only used when `USE_LEGACY_PAIRING=true` (deprecated feature flag).
- **Evidence**: 
  - `runLegacyPairingPipeline` only called via feature flag (line 478)
  - New system is default and proven stable
  - Comments indicate this is "baseline known good" but superseded
- **Action**: Remove function and all related Pass 1/Pass 2 code

#### B. Backup File
- **File**: `src/pairing/runPairing-hp2-backup.ts`
- **Reason**: Backup file, never imported anywhere
- **Evidence**: Single grep match is just a comment in `runPairing.ts` referencing it
- **Action**: DELETE file

#### C. Direct Pairing System (Experimental, replaced by unified pairing)
- **Files**:
  - `src/lib/directPairing.ts`
  - `src/lib/directPairingJobs.ts`
  - `netlify/functions/smartdrafts-pairing-direct.ts`
  - `netlify/functions/smartdrafts-pairing-direct-start.ts`
  - `netlify/functions/smartdrafts-pairing-direct-status.ts`
- **Reason**: Experimental direct LLM pairing system that was replaced by unified `runPairing` with `mode='direct-llm'`
- **Evidence**: 
  - No HTML pages reference these endpoints
  - Only test scripts use them (`test-direct-pairing.mjs`)
  - Functionality now provided by `runPairing()` mode parameter
- **Action**: DELETE all 5 files

#### D. Old Pairing Labs Endpoint
- **Files**:
  - `netlify/functions/pairing-labs-run.ts`
  - `public/pairing-labs.html`
- **Reason**: Experimental testing interface for old pairing algorithms
- **Evidence**:
  - Only 3 references total, all self-referential
  - Comment says "Does not modify existing smartdrafts-pairing behavior"
  - Replaced by pairing-v2-labs
- **Action**: DELETE both files

### MEDIUM CONFIDENCE - Review Before Delete

#### E. Smartdrafts-Pairing Endpoint
- **File**: `netlify/functions/smartdrafts-pairing.ts` (483 lines)
- **Reason**: Original pairing endpoint with massive amounts of legacy code and fallbacks. Likely replaced by pairing-v2 endpoints.
- **Evidence**:
  - Contains extensive legacy Redis fallback code (ZF-2 comments)
  - Has disabled "old folder cache" code
  - Comment: "DISABLED: Old cache contains pre-Phase-5b pairing results"
  - Still uses `runPairing` from pairing system
- **Risk**: May still be used by production UI
- **Action**: Check if `smartdrafts-dropbox.html` or other pages call this, then decide

#### F. Pairing V2 Background Jobs
- **Files**:
  - `src/lib/pairingV2Jobs.ts`
  - `netlify/functions/smartdrafts-pairing-v2-start.ts`
  - `netlify/functions/smartdrafts-pairing-v2-status.ts`
  - `netlify/functions/pairing-v2-processor.ts`
  - `public/pairing-v2-labs.html`
- **Reason**: Background job system for pairing-v2 that may be superseded by synchronous pairing
- **Evidence**: 
  - Only used in labs HTML page
  - May be experimental infrastructure
- **Risk**: Could be used for production async pairing
- **Action**: Verify if production uses async pairing before removing

---

## 2. DEPRECATED HTML PAGES

### HIGH CONFIDENCE - Safe to Delete

#### A. Debug/Test Pages
- **Files**:
  - `public/test-sdk-load.html` - Auth0 SDK loading test
  - `public/auth-debug.html` - Auth0 debugging page (193 lines)
  - `public/auth-debug-esm.html` - ESM version of auth debug
  - `public/auth-esm.html` - ESM auth testing
- **Reason**: Development/debugging tools for Auth0 integration
- **Evidence**: 
  - Only used by `analyze.html` for debugging (2 references)
  - No navigation links from main UI
  - Named "debug" and "test"
- **Action**: DELETE all 4 files

#### B. Old Analyze Page
- **File**: `public/analyze.html` (480 lines)
- **Reason**: Standalone analysis page, likely replaced by integrated workflow
- **Evidence**:
  - No navigation references found
  - Doesn't appear in main flow (`index.html`, `quick-list.html`, etc.)
  - Has own analysis endpoint calls
- **Risk**: May be linked from documentation or external tools
- **Action**: Check if linked externally, then DELETE

#### C. Old Draft Wizard
- **File**: `public/draft-wizard.html`
- **Reason**: Redirects to `/quick-list.html` (line 156) unless dev mode
- **Evidence**: 
  - Code: `if (!window.location.search.includes('dev')) { window.location.href = '/quick-list.html'; }`
  - Functionality moved to quick-list
- **Action**: DELETE file (or keep as redirect-only if needed)

### MEDIUM CONFIDENCE

#### D. Admin Pages
- **Files in**: `public/admin/`
  - `analyze.html`
  - `fetch-categories.html`
  - `export-utils.js`
  - `test/` subdirectory
- **Reason**: Admin tools that may or may not be actively used
- **Evidence**: Not referenced in main navigation
- **Risk**: May be used by admin workflows
- **Action**: Review admin usage before deciding

---

## 3. UNUSED NETLIFY FUNCTIONS

### LOW CONFIDENCE - Keep for Now

Most Netlify functions appear to be actively used or are part of the API surface. No obvious deprecated endpoints found beyond those listed in Section 1.

### Review Candidates
- Check if these are still called:
  - `analyze-images-background.ts` vs newer background systems
  - Old analytics functions if replaced by newer metrics

---

## 4. DEAD UTILITY FUNCTIONS

### Analysis Complete - All Used

Checked all utility files in `src/utils/` and `src/lib/`:
- All 8 files in `src/utils/` are imported and used:
  - `displayUrl.ts`, `finalizeDisplay.ts`, `grouping.ts`, `groupingHelpers.ts`
  - `pricing.ts`, `roles.ts`, `urlKey.ts`, `urlSanitize.ts`
- All are imported by `src/lib/smartdrafts-scan-core.ts` or `src/routes/process.ts`

No dead utility functions found.

---

## 5. ROOT-LEVEL TEST FILES

### HIGH CONFIDENCE - Safe to Delete

- **Files**:
  - `test-rco.mjs` - R+Co feature/candidate test script
  - `test-pairing-direct.mjs` - Direct pairing endpoint test
  - `test-direct-pairing.mjs` - Another direct pairing test
- **Reason**: Ad-hoc test scripts in root directory, functionality tested elsewhere
- **Evidence**: 
  - Not part of test suite
  - Located in root instead of `tests/` or `scripts/`
  - Test deprecated pairing endpoints
- **Action**: DELETE all 3 .mjs files from root

---

## 6. EMPTY/PLACEHOLDER DIRECTORIES

### HIGH CONFIDENCE
- **Directory**: `public/test/`
- **Contents**: Only `.gitkeep` file
- **Action**: Can delete if not needed as placeholder

---

## PRIORITY DELETION ORDER

### Phase 1: Zero-Risk Deletions (Start Here)
1. `src/pairing/runPairing-hp2-backup.ts` - Backup file
2. Root test files: `test-rco.mjs`, `test-pairing-direct.mjs`, `test-direct-pairing.mjs`
3. Debug HTML pages: `test-sdk-load.html`, `auth-debug.html`, `auth-debug-esm.html`, `auth-esm.html`
4. `public/test/` directory (just .gitkeep)

**Estimated LOC Reduction**: ~600 lines

### Phase 2: High-Confidence Deletions
5. Direct pairing system (5 files):
   - `src/lib/directPairing.ts`
   - `src/lib/directPairingJobs.ts`
   - `netlify/functions/smartdrafts-pairing-direct*.ts` (3 files)
6. Pairing labs:
   - `netlify/functions/pairing-labs-run.ts`
   - `public/pairing-labs.html`
7. Legacy pairing code in `index.ts`:
   - `runLegacyPairingPipeline()` and helpers

**Estimated LOC Reduction**: ~1,500 lines

### Phase 3: Medium-Risk Deletions (Verify First)
8. Check production usage of `smartdrafts-pairing.ts` endpoint
9. Review pairing-v2 background jobs necessity
10. Check `analyze.html` and `draft-wizard.html` usage
11. Review admin pages in `public/admin/`

**Potential LOC Reduction**: ~1,000+ lines

---

## TOTAL POTENTIAL CLEANUP

- **Phase 1 (Zero Risk)**: ~600 lines, 8 files
- **Phase 2 (High Confidence)**: ~1,500 lines, 8 files  
- **Phase 3 (Needs Verification)**: ~1,000+ lines, 5+ files
- **Grand Total**: ~3,100+ lines across 21+ files

---

## RECOMMENDATIONS

1. **Start with Phase 1** - No risk, immediate cleanup benefit
2. **Test Phase 2** - Deploy to staging, verify pairing still works
3. **Phase 3 requires user research** - Check analytics/logs for:
   - Which endpoints are actually called
   - Whether admin pages are used
   - If old HTML pages have external links

4. **Feature Flag Removal**:
   - Remove `USE_LEGACY_PAIRING` env var support after deleting legacy code
   - Document migration in changelog

5. **Create backup branch** before deletions (already created: `backup-before-cleanup-2025-11-22`)

---

## NOTES

- The pairing system has evolved significantly: Legacy → Direct → V2 → Unified
- Current production should use `runPairing()` with mode switching
- Many "experimental" files are from iterative development and never cleaned up
- Some HTML pages appear to be one-off debug tools left in place
