import type { Handler } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Minimal placeholder: returns ok when both tokens exist.
// Later we can port the full /process logic here if desired.
export const handler: Handler = async () => {
  const tokens = getStore('tokens');
  const [dbx, ebay] = await Promise.all([
    tokens.get('dropbox.json', { type: 'json' }) as Promise<any>,
    tokens.get('ebay.json', { type: 'json' }) as Promise<any>,
  ]);
  if (!dbx?.refresh_token || !ebay?.refresh_token) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Connect Dropbox and eBay first' }) };
  }
  // TODO: call your existing logic to create drafts (from Express src/routes/process.ts)
  return { statusCode: 200, body: JSON.stringify({ ok: true, created: 0 }) };
};
