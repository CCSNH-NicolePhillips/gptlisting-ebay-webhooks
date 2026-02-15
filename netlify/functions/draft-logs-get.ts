import type { Handler } from '../../src/types/api-handler.js';
import { tokensStore } from '../../src/lib/redis-store.js';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified, userScopedKey } from '../../src/lib/_auth.js';
import { getDraftLogs, getDraftLogsByOfferId } from '../../src/lib/draft-logs.js';
import { getGroupIdBySku } from '../../src/lib/bind-store.js';

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

    // Get logs for this SKU using the same key format as storage
    let logs: any = null;
    
    if (sku) {
      // First try direct lookup by SKU (in case logs were stored with SKU)
      logs = await getDraftLogs(sub, sku);
      
      // If not found, the SKU might be the eBay-generated one
      // Look up the binding to find the original groupId/productId
      if (!logs) {
        console.log(`[draft-logs-get] No logs for SKU ${sku}, looking up groupId from binding...`);
        const groupId = await getGroupIdBySku(sub, sku);
        if (groupId) {
          console.log(`[draft-logs-get] Found groupId ${groupId} for SKU ${sku}`);
          logs = await getDraftLogs(sub, groupId);
        }
      }
    }
    
    // Also try offerId lookup if no SKU logs found
    if (!logs && offerId) {
      logs = await getDraftLogsByOfferId(sub, offerId);
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
