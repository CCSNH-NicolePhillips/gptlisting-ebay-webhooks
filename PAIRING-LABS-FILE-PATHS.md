# SmartDrafts Analysis & Pairing Pipeline - File Paths

**Repository**: `CCSNH-NicolePhillips/gptlisting-ebay-webhooks`  
**Branch**: `main`  
**Date**: November 20, 2025

---

## Core Analysis Pipeline

- `src/lib/smartdrafts-scan-core.ts` - Main analysis engine (Vision, OCR, grouping, role detection)
- `src/smartdrafts/analysisCore.ts` - Shared analysis wrapper (Phase 2)
- `src/lib/analyze-core.ts` - Vision API integration
- `src/lib/role-confidence.ts` - Front/back role confidence scoring
- `src/lib/smartdrafts-store.ts` - Cache management for analysis results

---

## Pairing System

- `src/pairing/runPairing.ts` - Main pairing orchestrator (HP1, HP2 LLM pairing)
- `src/pairing/pairImages.ts` - Pairing algorithms and logic
- `src/pairing/types.ts` - TypeScript type definitions for pairing

---

## Netlify Functions (Serverless Endpoints)

- `netlify/functions/pairing-labs-run.ts` - **Phase 2 Labs endpoint** (analysis only)
- `netlify/functions/smartdrafts-scan.ts` - Standard analysis endpoint
- `netlify/functions/smartdrafts-pairing.ts` - Pairing endpoint (includes HP2)
- `netlify/functions/smartdrafts-scan-background.ts` - Background analysis jobs

---

## Frontend/UI

- `public/pairing-labs.html` - **Phase 2 Labs UI** (experimental pairing interface)
- `public/smartdrafts-dropbox.html` - Main SmartDrafts UI with pairing
- `public/new-smartdrafts/index.html` - New SmartDrafts React UI

---

## Configuration & Utilities

- `src/config/smartdrafts.ts` - SmartDrafts configuration loader
- `src/config.ts` - Global feature flags (USE_CLIP, USE_NEW_SORTER, etc.)
- `src/utils/roles.ts` - Role mapping utilities (front/back detection)
- `src/utils/groupingHelpers.ts` - Brand normalization, Jaccard similarity, tokenization
- `src/utils/displayUrl.ts` - Display URL generation
- `src/utils/finalizeDisplay.ts` - Final URL hydration
- `src/utils/urlKey.ts` - URL normalization and key generation
- `src/utils/urlSanitize.ts` - URL sanitization

---

## Vision & CLIP (AI/ML)

- `src/lib/clip-client-split.ts` - CLIP embeddings (image/text similarity)
- `src/lib/image-insight.ts` - Image insight type definitions

---

## Sorter (Front/Back Selection)

- `src/lib/sorter/frontBackStrict.ts` - Strict front/back sorting algorithm

---

## Authentication

- `src/lib/auth-user.ts` - User authentication (JWT validation)
- `src/lib/_auth.ts` - Auth utilities (userScopedKey)

---

## Storage

- `src/lib/_blobs.ts` - Blob storage interface (Netlify Blobs)

---

## HTTP Utilities

- `src/lib/http.ts` - HTTP helpers (CORS, JSON responses)

---

## Merge/Sanitization

- `src/lib/merge.ts` - URL merging and Dropbox URL conversion

---

## Quota Management

- `src/lib/quota.ts` - Image quota tracking and enforcement

---

## Key Files for Phase 3 (Pairing Implementation)

**Must Read**:
1. `src/pairing/runPairing.ts` - Contains HP2 LLM pairing implementation
2. `src/lib/smartdrafts-scan-core.ts` - Provides groups/insights to pairing
3. `netlify/functions/pairing-labs-run.ts` - Where Phase 3 pairing will be added
4. `public/pairing-labs.html` - UI that will display pairing results

**Phase 2 Completed**:
- ✅ Created `src/smartdrafts/analysisCore.ts` (shared analysis module)
- ✅ Updated `netlify/functions/pairing-labs-run.ts` (calls analysis, returns groups)
- ✅ Updated `public/pairing-labs.html` (displays analysis summary)
- ✅ Added authentication (requireUserAuth, authClient)

**Phase 3 Next**:
- Add pairing logic to `pairing-labs-run.ts`
- Call `runPairing()` from `src/pairing/runPairing.ts`
- Return paired results in response
- Update UI to show pairs, singletons, debug info

---

## GitHub Fetch Example

```json
{
  "repository_full_name": "CCSNH-NicolePhillips/gptlisting-ebay-webhooks",
  "path": "src/lib/smartdrafts-scan-core.ts",
  "ref": "main"
}
```

Replace `path` with any path from this document to fetch that file.
