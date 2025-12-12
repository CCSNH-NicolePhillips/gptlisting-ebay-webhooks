import type { Handler } from '@netlify/functions';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified, userScopedKey } from '../../src/lib/_auth.js';
import { tokensStore } from '../../src/lib/_blobs.js';

function json(status: number, body: any) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export const handler: Handler = async (event) => {
  try {
    const bearer = getBearerToken(event);
    let sub = (await requireAuthVerified(event))?.sub || null;
    if (!sub) sub = getJwtSubUnverified(event);
    if (!bearer || !sub) return json(401, { ok: false, error: 'Unauthorized' });

    const service = event.queryStringParameters?.service;
    if (!service || (service !== 'ebay' && service !== 'dropbox')) {
      return json(400, { ok: false, error: 'Invalid service parameter. Must be "ebay" or "dropbox"' });
    }

    const store = tokensStore();
    const key = service === 'ebay' ? userScopedKey(sub, 'ebay.json') : userScopedKey(sub, 'dropbox.json');

    console.log(`[disconnect] Disconnecting ${service} for user ${sub}`);
    
    // Delete the stored token
    await store.delete(key);

    return json(200, { ok: true, service, message: `${service} disconnected successfully` });
  } catch (err) {
    console.error('[disconnect] Error:', err);
    return json(500, { ok: false, error: 'Failed to disconnect service' });
  }
};
