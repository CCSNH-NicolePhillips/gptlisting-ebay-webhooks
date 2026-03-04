# Endpoint Migration Checklist

Use this checklist for every Netlify → Express migration.  
One endpoint at a time.  See `docs/endpoints-migration.md` for the full inventory.

---

## Before you start

- [ ] Read the original `netlify/functions/<name>.ts` top-to-bottom.
- [ ] Note the HTTP method(s), URL, auth type, and response shape.
- [ ] Check whether the endpoint is called from the frontend — `grep -r "functions/<name>" public/`.
- [ ] Check whether the endpoint is a background worker (does it invoke another function with `fetch`?).

---

## Step 1 — Extract business logic to a service

- [ ] Create (or reuse) a file in `src/services/<group>.service.ts`.
- [ ] Move all non-HTTP logic there (eBay calls, Redis reads, OpenAI, etc.).
- [ ] The service function must NOT import anything from `@netlify/functions`.
- [ ] Unit-test the service function in `tests/services/<group>.service.test.ts`.

---

## Step 2 — Write the Express route

- [ ] Copy `apps/api/src/routes/_template.ts` as a starting point.
- [ ] Add the route to an existing router file or create a new one.
- [ ] Register the router in `apps/api/src/routes/index.ts`.
- [ ] Match the **exact same JSON request body and response shape** as the original.
- [ ] Match the **exact same HTTP status codes** as the original.
- [ ] Apply the same auth guard as the original:
  - No auth → leave auth block out
  - User auth → `requireUserAuth(req.headers.authorization || '')`
  - Admin auth → `requireAdminAuth(req.headers.authorization || '')`
- [ ] Preserve `dryRun` flag forwarding for any eBay write operations.

---

## Step 3 — Write supertest tests

- [ ] Add tests to `tests/api/<group>.test.ts`.
- [ ] **Happy path** — valid input, mock service, expect 200 + correct shape.
- [ ] **Auth missing** — no `Authorization` header, expect 401 (if auth required).
- [ ] **Validation failure** — missing required fields, expect 400.
- [ ] **Service error** — service throws, expect 500.
- [ ] Run `npx jest tests/api/<group>.test.ts` to confirm all pass.

---

## Step 4 — Update the frontend caller(s)

- [ ] Find all frontend calls: `grep -r "\.netlify/functions/<name>" public/`.
- [ ] Update each URL from `/.netlify/functions/<name>` → `/api/...`.
- [ ] Verify the updated page still works manually (or with a smoke test).
- [ ] If the endpoint is a background job, update both the start URL **and** the
      status-poll URL together.

---

## Step 5 — Update the inventory

- [ ] Open `docs/endpoints-migration.md`.
- [ ] Change the `Status` column for this endpoint from `not-started` → `ported`.
- [ ] Update the Summary table counts at the bottom.

---

## Step 6 — CI checks

Run these locally before pushing:

```bash
npm run build              # TypeScript must compile cleanly
npm run typecheck          # tsc --noEmit
npm test                   # all 117+ suites must pass
npm run check:no-netlify   # apps/api + packages/core must not import netlify
npm run check:inventory    # every netlify function must be in the inventory
```

---

## Special cases

### Background workers (bg / -background suffix)

These Netlify functions are invoked by another function (not by the frontend
directly).  Migration needs **two** routes:

1. **Start route** — replaces the initiator function (e.g. `scan-bg`).
   Returns `{ ok: true, jobId }`.
2. **Worker route** — replaces the background worker itself (e.g. `scan-background`).
   Called by `setImmediate` / `setTimeout` after responding; never by the client.
   Alternatively, use a proper queue (BullMQ, etc.).

### OAuth flows (OAuth tag)

Redirect flows require HTTPS callback URLs.  In development, use `ngrok` or a
Cloudflare tunnel.  Update `EBAY_RUNAME` / Dropbox app settings to point to the
new Express callback URL before testing.

### Binary responses (binary tag)

Use `res.setHeader('Content-Type', ...)` and `res.send(Buffer)`.  Do **not**
use the `ok()` helper for binary routes.

### File uploads (upload tag)

Add `multer` middleware before the route handler.

```ts
import multer from 'multer';
const upload = multer({ storage: multer.memoryStorage() });
router.post('/upload', upload.single('file'), async (req, res) => { … });
```

---

## Suggested migration order

Port endpoints roughly in this priority:

1. **User-facing, no Redis** — lowest risk, quick wins  
   e.g. `get-public-config`, `me`, `status`, `taxonomy-list`, `taxonomy-get`

2. **User-facing, Redis read-only** — moderate complexity  
   e.g. `user-settings-get`, `connections`, `ebay-list-offers`, `ebay-list-locations`

3. **User-facing, Redis write** — touch Redis carefully  
   e.g. `user-settings-save`, `ebay-create-draft`, `smartdrafts-save-drafts`

4. **Admin / diagnostics** — low urgency, good for learning the codebase  
   e.g. `diag-*`, `admin-*`

5. **Background workers** — highest complexity, requires queue or background strategy  
   e.g. `smartdrafts-scan-bg` + `smartdrafts-scan-background` (must be ported as a pair)

6. **OAuth flows** — last, requires infrastructure (HTTPS callback URL) to be in place  
   e.g. `ebay-oauth-start` + `ebay-oauth-callback`, `dropbox-oauth-start` + `dropbox-oauth-callback`
