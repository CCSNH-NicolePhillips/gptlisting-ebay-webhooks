# Copilot Reference Notes

> This file holds reminders the user expects me to retain across sessions. Update it whenever the user says, "you already know this" or repeats an instruction.

## Domains & Environments
- Primary admin/API host: https://ebaywebhooks.netlify.app/
- Use this domain in testing instructions and curl examples unless the user explicitly asks for another environment.

## Tokens / Headers
- _TODO_: Record any reusable admin tokens, header requirements, or other auth details the user expects me to recall. Do **not** commit actual secret values; instead, note where they live (env var name, secret manager, etc.).

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

## Pending Questions
- Waiting on the user to confirm the canonical site URL(s) so I can stop using placeholders.
