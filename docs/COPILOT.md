# Copilot Playbook

This repo uses **Netlify Functions** + **TypeScript** + **Redis (Upstash)** and integrates with **eBay Sell APIs**.
Copilot MUST follow these rules for any change:

## 0) Golden rules
- **Small PRs.** One chunk = one PR.
- **Self-test locally.** Every PR includes a `smoke` result (REST calls + screenshots/log text).
- **DRY-RUN by default** for external APIs (eBay). Do not publish live unless PUBLISH_MODE says so.
- **Feature flags** via env vars. Never hardcode secrets.

## 1) Branching / Commit / PR
- Branch: `feat/<short-name>` or `fix/<short-name>`.
- Commits: Conventional (`feat: X`, `fix: Y`).
- PR Template: Use `.github/pull_request_template.md`.

## 2) Directory conventions
- Serverless functions: `netlify/functions/*`
- Shared libs: `src/lib/*`
- UI/admin pages: `src/admin/*`
- Scripts: `scripts/*`
- Docs: `docs/*`

## 3) Env & Secrets
- Runtime secrets come from **Netlify Env**. NEVER commit secrets.
- Required envs are documented in `docs/ENV.md` and checked in code (fail fast with readable errors).

## 4) Testing locally
- Use **Netlify Dev**: `npm run dev` (spins up `/.netlify/functions/*`).
- Use the **smoke scripts** in `scripts/smoke.sh` and `scripts/smoke.ps1` to hit the endpoints.
- For background jobs, poll the `status` endpoint until `complete`.

## 5) REST-first development style
For every new endpoint:
- Add to `docs/API.md` (route, method, body, sample curl).
- Create a **smoke test** entry (curl/PowerShell).
- Log a single structured JSON "done" line per request.

## 6) Lint/Format/Typecheck CI gates
- Lint: `npm run lint` (scoped to `netlify/functions` + `src`)
- Format: `npm run format`
- Typecheck: `npm run typecheck`
- PRs must pass all three.

## 7) TODO discipline
- Use `TODO.md` for work items. Copilot MUST:
  - Add a new task before coding a chunk.
  - Mark tasks done (✅) with a short note and PR link.
  - Keep sections: “Now”, “Next”, “Later”, “Blocked”.

## 8) Safety toggles
- **VISION_BYPASS_CACHE=false** unless testing cache bypass.
- **PUBLISH_MODE=draft** unless we explicitly publish.

## 9) Logs
- Each function ends with:  
  `console.log(JSON.stringify({ evt:"<fn>.done", ok:true, ...summaryFields }))`
- Do not log secrets or raw tokens.

## 10) When adding external calls
- Add a quick **timeout** and **retry** (with jitter).
- Respect quotas (e.g., Brave/SerpAPI caps). Check-and-skip if exhausted.
