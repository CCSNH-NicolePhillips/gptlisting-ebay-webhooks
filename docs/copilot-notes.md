# Copilot Reference Notes

> This file holds reminders the user expects me to retain across sessions. Update it whenever the user says, "you already know this" or repeats an instruction.

## Domains & Environments
- Primary admin/API host: https://ebaywebhooks.netlify.app/
- Use this domain in testing instructions and curl examples unless the user explicitly asks for another environment.

## Tokens / Headers
- Auth uses Auth0 bearer tokens via `window.authClient.authFetch()` or `window.authClient.ensureAuth()` loaded from `/auth-client.js`
- Admin API token available via `ADMIN_API_TOKEN` env var for server-side testing
- Never commit actual secret values; reference env var names instead

## Workflow Expectations
- The user expects references to their actual domain (see above) instead of placeholders.
- When giving testing instructions, default to their real domain.
- The user prefers that I commit and push code changes myself once builds/tests pass.
- When asked to test, I should:
	- set any required env vars (e.g., `ADMIN_API_TOKEN`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`) before running code;
	- run `npm run lint` and `npm run build` locally to ensure TypeScript output is current;
	- invoke the compiled Netlify handlers directly (using scripts under `tmp/`) to produce real responses instead of describing hypothetical results;
	- capture and report concrete status codes and response payloads from those handler runs;
	- summarize the exact commands and outputs in the response, plus note any required redeploy steps.

## Security & Secrets
- **NEVER hardcode secrets in HTML/JS files** (user caught this when I exposed DROPBOX_CLIENT_ID)
- Follow patterns from existing code like `smartdrafts-dropbox.html` which loads folders server-side without hardcoding client IDs
- Use `get-public-config` function to expose safe client-side config
- Dropbox client ID is public-safe but user prefers server-side patterns to avoid Netlify security scan failures

## SmartDrafts UI Work
- Building new isolated UI at `/new-smartdrafts/` using Preact + HTM (no build step)
- Phase UI-0 through UI-7 completed:
  - UI-0: Basic scaffold with tabs and mock data
  - UI-4: Folder input, Mock/Live toggle, Force Rescan checkbox
  - UI-5: Hard Reset button for cache clearing
  - UI-6: Live API wiring (analyze, pairing, reset, metrics endpoints)
  - UI-7: Dropbox picker integration and folder normalization
- Mock mode uses placeholder.com images to avoid 404s
- Live mode calls backend functions (not yet implemented):
  - `smartdrafts-analyze` (GET) - analyze folder images
  - `smartdrafts-pairing` (POST) - run pairing algorithm
  - `smartdrafts-reset` (POST) - clear cache for folder
  - `smartdrafts-metrics` (GET) - get metrics

## Pairing System
- v1.0.0 complete (Phases 1-7) with tag `pairing-v1.0.0`
- Located in `src/pairing/` directory
- Not yet integrated into UI - new isolated UI being built instead of modifying legacy code
- Uses vision role classification (front/back) to pair product images

## Pending Questions
- Backend functions (smartdrafts-analyze, smartdrafts-pairing, smartdrafts-reset, smartdrafts-metrics) need to be created next
- Should reference existing endpoints like `dropbox-list-images`, `analyze-images-bg-user`, etc.
