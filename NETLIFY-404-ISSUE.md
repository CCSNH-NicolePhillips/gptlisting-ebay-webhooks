# Netlify Function 404 Error - Need Help

## Problem
Netlify function `smartdrafts-scan-background` is returning 404 Not Found when called from `smartdrafts-scan-bg`, causing the entire pipeline to fail with 502 errors.

## Error Message
```
POST https://draftpilot-ai.netlify.app/.netlify/functions/smartdrafts-scan-bg 502 (Bad Gateway)
[API] 502 Error: Background worker returned 404 Not Found: Not Found - Request ID: 01KA1VY6BTTSGKDYB0GBZEW68H
```

## What We've Tried

### 1. Fixed Auth0 Token Refresh Issues ✅
- Implemented token refresh gating to prevent race conditions
- Made token fetching lazy (only on first API call, not during init)
- Auth is now working correctly - logs show successful token refresh

### 2. Fixed ALL crypto imports for esbuild
Changed from `'crypto'` to `'node:crypto'` in:
- **Netlify Functions:** (8 files)
  - `smartdrafts-scan-bg.ts`
  - `smartdrafts-scan-background.ts` 
  - `smartdrafts-pairing.ts`
  - `smartdrafts-create-drafts-bg.ts`
  - `ebay-mad.ts`
  - `ingest-local-upload.ts`
  - `dbx-list-tree-user.ts`
  - `analyze-images-bg.ts`
  - `analyze-images-bg-user.ts`

- **Source Libraries:** (2 files)
  - `src/lib/storage.ts`
  - `src/lib/merge.ts`

### 3. Verified Local Build
```bash
npm run build
# Succeeds with no errors
```

## Current Configuration

**netlify.toml:**
```toml
[build]
  command = "npm run build"
  publish = "public"
  functions = "netlify/functions"

[functions]
  node_bundler = "esbuild"
  directory = "netlify/functions"
  external_node_modules = ["openai", "@aws-sdk/client-s3", "@aws-sdk/s3-request-presigner"]
```

## The Call Flow
1. Frontend calls `/.netlify/functions/smartdrafts-scan-bg` (works - gets 200 response)
2. `smartdrafts-scan-bg` calls `/.netlify/functions/smartdrafts-scan-background` internally
3. **This returns 404 - function not found**
4. Error propagates back as 502

## Key Files

**smartdrafts-scan-bg.ts** (line 119):
```typescript
const target = `${baseUrl}/.netlify/functions/smartdrafts-scan-background`;

const resp = await fetch(target, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jobId, userId, folder, stagedUrls, ... })
});

if (!resp.ok) {
  const errorMsg = `Background worker returned ${resp.status} ${resp.statusText}`;
  // Returns 404 here
}
```

**smartdrafts-scan-background.ts** (exists, imports look correct):
```typescript
import type { Handler } from "@netlify/functions";
import { createHash } from "node:crypto";
import { runSmartDraftScan, type SmartDraftScanResponse } from "../../src/lib/smartdrafts-scan-core.js";
// ... other imports

export const handler: Handler = async (event) => {
  // Handler implementation
};
```

## Questions for ChatGPT

1. **Why would a Netlify function return 404 even after deployment?**
   - The file exists in the repo
   - It's in the correct directory (`netlify/functions/`)
   - Local build succeeds
   - Other functions in the same directory work

2. **Could esbuild still be failing to bundle this specific function?**
   - Even though `npm run build` (TypeScript) succeeds?
   - Are there any hidden import issues that would cause esbuild to skip it?

3. **Is there a way to verify which functions actually deployed to Netlify?**
   - CLI command or API to list deployed functions?
   - How to check Netlify build logs for function-specific errors?

4. **Could the issue be:**
   - Function name mismatch?
   - Missing export?
   - Async/bundling issue with dependencies?
   - Netlify function size limit exceeded?

5. **What else should we check?**

## Repository
- **Repo:** https://github.com/CCSNH-NicolePhillips/gptlisting-ebay-webhooks
- **Site:** https://draftpilot-ai.netlify.app
- **Recent commits:** All crypto import fixes pushed successfully
- **Deployment status:** Appears to succeed (no obvious errors in Netlify UI)

## Environment
- Node.js project with TypeScript
- Using esbuild via Netlify's node_bundler
- Functions call each other via HTTP fetch (not direct imports)
