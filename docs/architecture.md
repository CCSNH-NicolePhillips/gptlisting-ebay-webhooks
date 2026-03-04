# Architecture Guide

This document describes the repository structure, layering rules, and
contribution guidelines.  If you are unsure where code belongs, consult the
"Where do I put X?" section before creating a new file.

---

## Folder Structure

```
gptlisting-ebay-webhooks/
├── apps/
│   ├── api/                    ← Express HTTP server (Railway deployment)
│   │   └── src/
│   │       ├── index.ts        ← app entry-point (Express + middleware)
│   │       ├── routes/         ← one file per resource area (thin adapters only)
│   │       └── http/           ← shared HTTP helpers (respond.ts, validate.ts)
│   └── web/                    ← (reserved) future front-end SPA
│
├── packages/
│   ├── core/                   ← platform-agnostic business logic
│   │   └── src/
│   │       ├── pricing/        ← pricing rules, formulas, delivery math
│   │       ├── jobs/           ← background-job helpers
│   │       ├── shipping/       ← shipping estimate logic
│   │       └── taxonomy/       ← eBay taxonomy helpers
│   └── shared/
│       └── src/               ← cross-package TypeScript types
│           └── index.ts
│
├── src/                        ← LEGACY root package (frozen — do not add files)
│   ├── lib/                    ← legacy utilities — gradually migrated to packages/
│   │   ├── ebay-client.ts      ← eBay OAuth token helper (used by services)
│   │   ├── auth-user.ts        ← Auth0 JWT validation helper
│   │   ├── redis-store.ts      ← Upstash REST client
│   │   ├── _auth.ts            ← low-level token primitives
│   │   ├── _common.ts          ← tokenHosts(), accessTokenFromRefresh()
│   │   ├── pricing/            ← canonical pricing sub-modules
│   │   └── …                   ← many more helpers
│   ├── services/               ← platform-agnostic service layer (active)
│   │   ├── ebay-offers.service.ts
│   │   ├── ebay-listings.service.ts
│   │   ├── smartdrafts-create-drafts.service.ts
│   │   ├── user-settings.service.ts
│   │   └── user-status.service.ts
│   └── config.ts               ← centralised environment config
│
├── netlify/
│   └── functions/              ← LEGACY Netlify serverless handlers (145 total)
│       └── *.ts                ← being migrated to apps/api/src/routes/
│
├── tests/                      ← Jest test suite
│   ├── api/                    ← Supertest tests for Express routes
│   └── lib/                    ← Unit tests for lib/ and services/
│
├── scripts/                    ← Developer & CI utility scripts
│   ├── check-inventory.ps1     ← every netlify function must be in the inventory
│   ├── check-no-netlify-imports.ps1  ← apps/ and packages/ must not import netlify
│   ├── check-forbidden-imports.ps1   ← pricing-layer import guards
│   ├── check-structure.ps1     ← no new files may be added to src/lib/
│   └── …
│
├── docs/                       ← Documentation
│   ├── architecture.md         ← THIS FILE
│   ├── runbook.md              ← local dev + ops reference
│   ├── endpoints-migration.md  ← migration inventory (145 functions)
│   └── …
│
├── public/                     ← Static HTML/JS front-end (Netlify served)
│
├── eslint.config.cjs           ← ESLint flat config with layer-boundary rules
├── jest.config.js              ← Jest config (ts-jest ESM preset)
├── tsconfig.json               ← root TypeScript project
└── package.json                ← npm workspace root
```

---

## Layering Rules

The following dependency order is **strictly enforced** by ESLint and CI scripts.
Arrows mean "may import from".

```
shared   ←  core  ←  src/lib  ←  src/services  ←  apps/api/routes
                                                  ←  netlify/functions
```

### Hard rules

| Rule | Enforced by |
|---|---|
| `packages/core/**` MUST NOT import from `apps/**` | `lint:boundaries` (ESLint) |
| `packages/shared/**` MUST NOT import from `apps/**` or `packages/core/**` | `lint:boundaries` (ESLint) |
| `apps/api/**` MUST NOT import from `netlify/functions/**` | `check:no-netlify` (PowerShell) |
| `apps/api/**` MUST NOT import `@netlify/*` packages | `check:no-netlify` (PowerShell) |
| New `.ts` files MUST NOT be created in `src/lib/**` | `check:structure` (PowerShell) |
| Every `netlify/functions/*.ts` MUST appear in endpoints-migration.md | `check:inventory` (PowerShell) |

### Softcoded conventions

- **Route files** (`apps/api/src/routes/*.ts`) must be **thin adapters** — their
  only job is to:
  1. Authenticate via `requireUserAuth(req.headers.authorization)`
  2. Validate inputs with `missingField()` from `apps/api/src/http/validate.ts`
  3. Call a service function from `src/services/`
  4. Return a response via `ok()` / `badRequest()` / `serverError()` from
     `apps/api/src/http/respond.ts`

  Business logic, eBay API calls, Redis reads — all go in the **service layer**.

- **Service files** (`src/services/*.service.ts`) must be **framework-agnostic**
  — no `express`, `HandlerEvent`, `Response`, etc.  They receive plain data and
  return plain data.  Use custom error classes (`EbayApiError`,
  `EbayNotConnectedError`) so callers can map them to HTTP status codes.

- **`src/lib/**`** is **frozen** for new code.  You may fix bugs in existing
  files but must not add new files.  New shared utilities belong in
  `packages/core/src/` or `src/services/`.

---

## Where Do I Put X?

### New endpoint (e.g. `GET /api/ebay/inventory/items`)

1. Implement business logic in a **service** file — create or extend
   `src/services/ebay-inventory.service.ts`.
2. Create `apps/api/src/routes/ebay-inventory.ts` (thin adapter).
3. Register it in `apps/api/src/routes/index.ts`.
4. Write Supertest coverage in `tests/api/ebay-inventory.test.ts`.
5. Add a `ported` row to `docs/endpoints-migration.md` (even for brand-new
   endpoints — so the inventory stays complete).

Template: `apps/api/src/routes/_template.ts`

### New eBay operation (e.g. withdraw an offer)

1. Add a function to `src/services/ebay-offers.service.ts` (or create a new
   service if it's a distinct resource).
2. Use `getEbayClient(userId)` from `src/lib/ebay-client.ts` to obtain a live
   access token — **do not copy the token-loading pattern inline**.
3. Throw `EbayApiError` on non-2xx eBay responses; throw `EbayNotConnectedError`
   when the user has no stored credentials.
4. Expose via a new route handler in the appropriate `apps/api/src/routes/*.ts`
   file.
5. Unit-test the service by mocking `getEbayClient`.

### Pricing rule change

1. All pricing logic lives in `src/lib/pricing/` (canonical sub-modules).
2. The public surface is `src/lib/pricing/index.ts` → `getPricingDecision()`.
   External callers (routes, services, Netlify functions) must use only this
   function — not internal sub-modules.
3. Run `npm run check:forbidden` to verify no new direct pricing imports crept in.
4. Update golden test fixtures in `tests/` if expected outputs change.

### Background job change

1. Background job state lives in Upstash Redis via `src/lib/job-store.ts`.
2. The job follows the pattern:
   - **Initiator**: create Redis job record → invoke background worker via
     Netlify background function → return `{ jobId }` immediately.
   - **Worker**: processes work (up to 10 min), updates Redis state at each step.
   - **Status poller**: client polls `job-status` until `state: "complete"`.
3. For new background jobs on Railway, use Express + a separate queueing
   mechanism (e.g. BullMQ) rather than Netlify background functions.
4. Add tests in `tests/lib/` that mock Redis and verify state transitions.

### New shared type

1. Add to `packages/shared/src/index.ts` (or a dedicated file in
   `packages/shared/src/types/`).
2. Import with the `@shared/` alias from any other package/app.
3. Shared types must be **pure TypeScript interfaces/types** — no runtime code.

### New utility helper

- **Platform-agnostic math / logic**: add to `packages/core/src/`.
- **Express-specific helper**: add to `apps/api/src/http/`.
- **Do NOT add to `src/lib/`** — that folder is frozen.

---

## Endpoint Migration Policy

We are migrating 145 Netlify functions to Express in priority order.

- The full inventory is in [`docs/endpoints-migration.md`](endpoints-migration.md).
- A migration checklist for each endpoint is in
  [`docs/migration-checklist.md`](migration-checklist.md).
- Every ported function goes through:
  1. Service extraction → `src/services/`
  2. Express route → `apps/api/src/routes/`
  3. Supertest tests → `tests/api/`
  4. Status updated to `ported` in the inventory

**Current status (as of 2026-03):**
- 12 ported, 0 stubbed, 133 not-started

Functions remain live on `/.netlify/functions/*` until:
1. Their Express counterpart is `ported`.
2. All frontend callers have been updated.
3. The Netlify function is deleted and the inventory row archived.
