import type { Handler } from '@netlify/functions';
import { resolveEbayEnv } from '../../src/lib/_common.js';

export const handler: Handler = async () => {
  try {
    const EBAY_ENV = resolveEbayEnv(process.env.EBAY_ENV);
    const DEFAULT_MARKETPLACE_ID = process.env.DEFAULT_MARKETPLACE_ID || process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';
    const MERCHANT_LOCATION_KEY = process.env.EBAY_MERCHANT_LOCATION_KEY || null;
    const SITE_URL = process.env.URL || process.env.DEPLOY_URL || null;
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ EBAY_ENV, DEFAULT_MARKETPLACE_ID, MERCHANT_LOCATION_KEY, SITE_URL }),
    };
  } catch (e: any) {
    return { statusCode: 500, body: JSON.stringify({ error: e?.message || 'diag-env failed' }) };
  }
};
