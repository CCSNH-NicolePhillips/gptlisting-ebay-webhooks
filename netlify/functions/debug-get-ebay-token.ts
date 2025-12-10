import type { Handler } from '@netlify/functions';
import { accessTokenFromRefresh } from '../../src/lib/_common.js';
import { tokensStore } from '../../src/lib/_blobs.js';
import { requireAuthVerified, userScopedKey } from '../../src/lib/_auth.js';

export const handler: Handler = async (event) => {
  console.log('[debug-get-ebay-token] TEMPORARY DEBUG ENDPOINT');
  
  try {
    const auth = await requireAuthVerified(event);
    const sub = auth?.sub;
    
    if (!sub) {
      return {
        statusCode: 401,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Unauthorized' }),
      };
    }

    // Load refresh token
    const store = tokensStore();
    const saved = (await store.get(userScopedKey(sub, 'ebay.json'), { type: 'json' })) as any;
    const refresh = saved?.refresh_token as string | undefined;
    
    if (!refresh) {
      return { 
        statusCode: 400, 
        body: JSON.stringify({ error: 'No eBay connection found' }) 
      };
    }

    console.log('[debug-get-ebay-token] Getting access token...');
    const { access_token, expires_in } = await accessTokenFromRefresh(refresh);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        access_token,
        expires_in,
        preview: access_token.substring(0, 50) + '...',
        instructions: 'Copy the access_token value and use it in your test script'
      }),
    };
  } catch (err: any) {
    console.error('[debug-get-ebay-token] Error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
