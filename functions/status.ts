import type { Handler } from '@netlify/functions';
import { tokensStore } from './_blobs.js';
import { getJwtSubUnverified, userScopedKey } from './_auth.js';

export const handler: Handler = async (event) => {
  try {
    const tokens = tokensStore();
    const sub = getJwtSubUnverified(event);
    if (event.httpMethod === 'POST') {
      if (event.queryStringParameters?.dropbox === 'disconnect') {
        const key = userScopedKey(sub, 'dropbox.json');
        await tokens.setJSON(key, {});
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }
      if (event.queryStringParameters?.ebay === 'disconnect') {
        const key = userScopedKey(sub, 'ebay.json');
        await tokens.setJSON(key, {});
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }
    }

    // Prefer per-user tokens; fallback to legacy global for backward-compat
    const [dbx, ebay] = await Promise.all([
      (async () => (await tokens.get(userScopedKey(sub, 'dropbox.json'), { type: 'json' })) || (await tokens.get('dropbox.json', { type: 'json' })))(),
      (async () => (await tokens.get(userScopedKey(sub, 'ebay.json'), { type: 'json' })) || (await tokens.get('ebay.json', { type: 'json' })))(),
    ] as any);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dropbox: { connected: !!(dbx as any)?.refresh_token },
        ebay: { connected: !!(ebay as any)?.refresh_token },
      }),
    };
  } catch (e: any) {
    return { statusCode: 500, body: `status error: ${e.message}` };
  }
};
