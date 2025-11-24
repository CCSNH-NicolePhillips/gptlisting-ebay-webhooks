import type { Handler } from '@netlify/functions';
import { tokensStore } from '../../src/lib/_blobs.js';
import { requireAuthVerified, userScopedKey } from '../../src/lib/_auth.js';

export const handler: Handler = async (event) => {
  try {
    const auth = await requireAuthVerified(event);
    if (!auth) {
      return {
        statusCode: 401,
        headers: { 'Content-Type': 'text/html' },
        body: '<h1>Not logged in</h1><p>Please log in to draftpilot.app first</p>',
      };
    }

    const store = tokensStore();
    const key = userScopedKey(auth.sub, 'ebay.json');
    const data: any = await store.get(key, { type: 'json' });

    if (!data || !data.refresh_token) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'text/html' },
        body: '<h1>No eBay Token</h1><p>You need to connect eBay first at <a href="/setup.html">setup page</a></p>',
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html' },
      body: `
        <h1>Your eBay Refresh Token</h1>
        <p>Copy this token and paste it when prompted:</p>
        <pre style="background: #f4f4f4; padding: 20px; border-radius: 5px; overflow-x: auto;">${data.refresh_token}</pre>
        <p><small>Keep this private! Don't share it publicly.</small></p>
      `,
    };
  } catch (error: any) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'text/html' },
      body: `<h1>Error</h1><pre>${error.message}</pre>`,
    };
  }
};
