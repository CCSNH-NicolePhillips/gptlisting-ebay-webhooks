# stagedUrls Fallback Fix - December 19, 2025

## Final Solution (CORRECT)

**File:** `netlify/functions/smartdrafts-scan-background.ts` (Line 129)

```typescript
stagedUrls: stagedUrls.length > 0 ? stagedUrls : payload.stagedUrls,
```

## Why This Works

### Priority/Fallback Logic:
1. **If input `stagedUrls` exist** → Use them (local upload case)
2. **If input is empty** → Use `payload.stagedUrls` (Dropbox case)

### Local Upload Flow:
- Browser → `ingest-local-upload` → stages to R2 → returns `stagedUrls`
- `quick-list.html` → sends `stagedUrls` in scan-bg request
- `scan-background` → input `stagedUrls.length > 0` is TRUE → uses input
- ✅ Works correctly

### Dropbox Flow:
- Browser → `quick-list.html` → sends folder path (NO stagedUrls)
- `scan-background` → input `stagedUrls.length > 0` is FALSE → falls back to `payload.stagedUrls`
- `scan-core` → uses DropboxAdapter → stages to R2 → populates `payload.stagedUrls`
- ✅ Works correctly

## Evolution of the Bug

### Version 1 (Original - BROKEN for Dropbox):
```typescript
stagedUrls: stagedUrls.length > 0 ? stagedUrls : undefined,
```
- ❌ Dropbox: Input empty, fallback to undefined → pairing gets no URLs

### Version 2 (First Fix - BROKEN for Local):
```typescript
stagedUrls: payload.stagedUrls,
```
- ❌ Local: `payload.stagedUrls` undefined → pairing gets no URLs
- ✅ Dropbox: Works

### Version 3 (Final - WORKS for Both):
```typescript
stagedUrls: stagedUrls.length > 0 ? stagedUrls : payload.stagedUrls,
```
- ✅ Local: Uses input `stagedUrls`
- ✅ Dropbox: Falls back to `payload.stagedUrls`

## Test Coverage

Created `tests/functions/smartdrafts-scan-background.test.ts` with 5 tests:
1. ✅ Dropbox scan stores response stagedUrls
2. ✅ Empty folder stores empty array
3. ✅ Local upload uses correct stagedUrls
4. ✅ Scan failure doesn't store stagedUrls
5. ✅ Quota management (decRunning called)

All tests passing: **2872 passed, 2 skipped**

## Key Insight

The architecture has **TWO sources** for `stagedUrls`:
1. **INPUT** (from request body): Pre-staged files (local uploads)
2. **OUTPUT** (from scan response): Just-staged files (Dropbox)

The correct solution handles **both** with priority/fallback logic.
