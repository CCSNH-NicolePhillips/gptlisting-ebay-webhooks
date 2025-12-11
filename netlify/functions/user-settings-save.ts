import type { Handler } from '@netlify/functions';
import { tokensStore } from '../../src/lib/_blobs.js';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified, userScopedKey } from '../../src/lib/_auth.js';

/**
 * Save user settings (promotion preferences, etc.)
 * POST body: { autoPromoteEnabled?: boolean, defaultPromotionRate?: number }
 */
export const handler: Handler = async (event) => {
  try {
    const bearer = getBearerToken(event);
    let sub = (await requireAuthVerified(event))?.sub || null;
    if (!sub) sub = getJwtSubUnverified(event);
    if (!bearer || !sub) return { statusCode: 401, body: 'Unauthorized' };

    const body = event.body ? JSON.parse(event.body) : {};
    const autoPromoteEnabled = body.autoPromoteEnabled as boolean | undefined;
    const defaultPromotionRate = body.defaultPromotionRate as number | undefined;

    // Validate promotion rate if provided
    if (defaultPromotionRate !== undefined && defaultPromotionRate !== null) {
      if (typeof defaultPromotionRate !== 'number' || defaultPromotionRate < 1 || defaultPromotionRate > 20) {
        return {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'defaultPromotionRate must be between 1 and 20' })
        };
      }
    }

    const store = tokensStore();
    const key = userScopedKey(sub, 'settings.json');
    
    // Load existing settings
    let settings: any = {};
    try {
      settings = (await store.get(key, { type: 'json' })) as any;
    } catch {}
    if (!settings || typeof settings !== 'object') settings = {};

    // Update settings
    if (autoPromoteEnabled !== undefined) settings.autoPromoteEnabled = autoPromoteEnabled;
    if (defaultPromotionRate !== undefined) settings.defaultPromotionRate = defaultPromotionRate;

    // Save to blob store
    await store.set(key, JSON.stringify(settings));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, settings })
    };
  } catch (e: any) {
    console.error('[user-settings-save] Error:', e);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: e?.message || String(e) })
    };
  }
};
