import type { Handler } from '@netlify/functions';
import { tokensStore } from './_blobs.js';
import { getJwtSubUnverified, userScopedKey } from './_auth.js';

// Minimal placeholder: returns ok when both tokens exist.
// Later we can port the full /process logic here if desired.
export const handler: Handler = async (event) => {
  const tokens = tokensStore();
  const sub = getJwtSubUnverified(event);
  const [dbx, ebay] = await Promise.all([
    (async () => (await tokens.get(userScopedKey(sub, 'dropbox.json'), { type: 'json' })) || (await tokens.get('dropbox.json', { type: 'json' })))(),
    (async () => (await tokens.get(userScopedKey(sub, 'ebay.json'), { type: 'json' })) || (await tokens.get('ebay.json', { type: 'json' })))(),
  ] as any);
  if (!dbx?.refresh_token || !ebay?.refresh_token) {
    return {
      statusCode: 400,
      body: JSON.stringify({ ok: false, error: 'Connect Dropbox and eBay first' }),
    };
  }
  // TODO: call your existing logic to create drafts (from Express src/routes/process.ts)
  return { statusCode: 200, body: JSON.stringify({ ok: true, created: 0 }) };
};
