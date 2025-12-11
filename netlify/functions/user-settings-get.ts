import type { Handler } from '@netlify/functions';
import { tokensStore } from '../../src/lib/_blobs.js';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified, userScopedKey } from '../../src/lib/_auth.js';

/**
 * Get user settings (promotion preferences, etc.)
 * Returns: { autoPromoteEnabled: boolean, defaultPromotionRate: number | null }
 */
export const handler: Handler = async (event) => {
  try {
    const bearer = getBearerToken(event);
    let sub = (await requireAuthVerified(event))?.sub || null;
    if (!sub) sub = getJwtSubUnverified(event);
    if (!bearer || !sub) return { statusCode: 401, body: 'Unauthorized' };

    const store = tokensStore();
    const key = userScopedKey(sub, 'settings.json');
    
    // Load settings
    let settings: any = {};
    try {
      settings = (await store.get(key, { type: 'json' })) as any;
    } catch {}
    if (!settings || typeof settings !== 'object') settings = {};

    // Return with defaults
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        autoPromoteEnabled: settings.autoPromoteEnabled || false,
        defaultPromotionRate: settings.defaultPromotionRate || null
      })
    };
  } catch (e: any) {
    console.error('[user-settings-get] Error:', e);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: e?.message || String(e) })
    };
  }
};
