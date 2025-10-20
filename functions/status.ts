import type { Handler } from '@netlify/functions';
import { tokensStore } from './_blobs.js';

export const handler: Handler = async (event) => {
  try {
    const tokens = tokensStore();
    if (event.httpMethod === 'POST') {
      if (event.queryStringParameters?.dropbox === 'disconnect') {
        await tokens.setJSON('dropbox.json', {});
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }
      if (event.queryStringParameters?.ebay === 'disconnect') {
        await tokens.setJSON('ebay.json', {});
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }
    }

    const [dbx, ebay] = await Promise.all([
      tokens.get('dropbox.json', { type: 'json' }) as Promise<any>,
      tokens.get('ebay.json', { type: 'json' }) as Promise<any>,
    ]);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dropbox: { connected: !!dbx?.refresh_token },
        ebay: { connected: !!ebay?.refresh_token },
      }),
    };
  } catch (e: any) {
    return { statusCode: 500, body: `status error: ${e.message}` };
  }
};
