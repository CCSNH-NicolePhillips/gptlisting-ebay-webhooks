import type { Handler } from '@netlify/functions';
import { tokensStore } from '../../src/lib/redis-store.js';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified, userScopedKey } from '../../src/lib/_auth.js';

/**
 * GET /.netlify/functions/draft-logs-get?sku=xxx
 * 
 * Retrieves pricing logs and AI reasoning for a specific draft.
 * Logs are stored in Redis when drafts are created and contain:
 * - ChatGPT vision analysis reasoning
 * - Pricing decision breakdown (sources, calculations, math)
 * - Auto-price reduction settings if applicable
 */
export const handler: Handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ ok: false, error: 'Method not allowed' }),
    };
  }

  try {
    // Auth
    const bearer = getBearerToken(event);
    let sub = (await requireAuthVerified(event))?.sub || null;
    if (!sub) sub = getJwtSubUnverified(event);
    if (!bearer || !sub) {
      return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'Unauthorized' }) };
    }

    const { sku, offerId } = event.queryStringParameters || {};
    
    if (!sku && !offerId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ ok: false, error: 'Missing sku or offerId parameter' }),
      };
    }

    const store = tokensStore();
    
    // Check if user has logs enabled in settings
    const settingsKey = userScopedKey(sub, 'settings.json');
    let settings: any = {};
    try {
      settings = (await store.get(settingsKey, { type: 'json' })) as any;
    } catch {}
    
    const logsEnabled = settings?.showPricingLogs ?? false;
    
    if (!logsEnabled) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ 
          ok: true, 
          enabled: false,
          message: 'Pricing logs display is disabled. Enable it in Settings.' 
        }),
      };
    }

    // Get logs for this SKU
    const logsKey = sku 
      ? userScopedKey(sub, `draft-logs:${sku}`)
      : userScopedKey(sub, `draft-logs-offer:${offerId}`);
    
    let logs: any = null;
    try {
      logs = await store.get(logsKey, { type: 'json' });
    } catch {}

    if (!logs) {
      // Try alternate key formats
      const altKey = sku
        ? `draft-logs:${sub}:${sku}`
        : `draft-logs-offer:${sub}:${offerId}`;
      try {
        logs = await store.get(altKey, { type: 'json' });
      } catch {}
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        enabled: true,
        logs: logs || null,
        hasLogs: !!logs,
      }),
    };
  } catch (e: any) {
    console.error('[draft-logs-get] Error:', e);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, error: e?.message || String(e) }),
    };
  }
};
