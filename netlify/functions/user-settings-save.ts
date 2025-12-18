import type { Handler } from '@netlify/functions';
import { tokensStore } from '../../src/lib/_blobs.js';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified, userScopedKey } from '../../src/lib/_auth.js';
import type { PricingSettings, ShippingStrategy } from '../../src/lib/pricing-config.js';

/**
 * Save user settings (promotion preferences, pricing config, etc.)
 * POST body: { 
 *   autoPromoteEnabled?: boolean, 
 *   defaultPromotionRate?: number,
 *   pricing?: Partial<PricingSettings>
 * }
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
    const pricing = body.pricing as Partial<PricingSettings> | undefined;

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

    // Validate pricing settings if provided
    if (pricing) {
      if (pricing.discountPercent !== undefined) {
        if (typeof pricing.discountPercent !== 'number' || pricing.discountPercent < 0 || pricing.discountPercent > 50) {
          return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'discountPercent must be between 0 and 50' })
          };
        }
      }
      if (pricing.shippingStrategy !== undefined) {
        const validStrategies: ShippingStrategy[] = ['ALGO_COMPETITIVE_TOTAL', 'DISCOUNT_ITEM_ONLY'];
        if (!validStrategies.includes(pricing.shippingStrategy)) {
          return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: `shippingStrategy must be one of: ${validStrategies.join(', ')}` })
          };
        }
      }
      if (pricing.templateShippingEstimateCents !== undefined) {
        if (typeof pricing.templateShippingEstimateCents !== 'number' || pricing.templateShippingEstimateCents < 0) {
          return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'templateShippingEstimateCents must be >= 0' })
          };
        }
      }
      if (pricing.shippingSubsidyCapCents !== undefined && pricing.shippingSubsidyCapCents !== null) {
        if (typeof pricing.shippingSubsidyCapCents !== 'number' || pricing.shippingSubsidyCapCents < 0) {
          return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'shippingSubsidyCapCents must be >= 0 or null' })
          };
        }
      }
      if (pricing.minItemPriceCents !== undefined) {
        if (typeof pricing.minItemPriceCents !== 'number' || pricing.minItemPriceCents < 0) {
          return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'minItemPriceCents must be >= 0' })
          };
        }
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

    // Update promotion settings
    if (autoPromoteEnabled !== undefined) settings.autoPromoteEnabled = autoPromoteEnabled;
    if (defaultPromotionRate !== undefined) settings.defaultPromotionRate = defaultPromotionRate;

    // Update pricing settings
    if (pricing) {
      if (!settings.pricing) settings.pricing = {};
      if (pricing.discountPercent !== undefined) settings.pricing.discountPercent = pricing.discountPercent;
      if (pricing.shippingStrategy !== undefined) settings.pricing.shippingStrategy = pricing.shippingStrategy;
      if (pricing.templateShippingEstimateCents !== undefined) settings.pricing.templateShippingEstimateCents = pricing.templateShippingEstimateCents;
      if (pricing.shippingSubsidyCapCents !== undefined) settings.pricing.shippingSubsidyCapCents = pricing.shippingSubsidyCapCents;
      if (pricing.minItemPriceCents !== undefined) settings.pricing.minItemPriceCents = pricing.minItemPriceCents;
    }

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
