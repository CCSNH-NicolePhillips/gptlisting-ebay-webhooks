import type { Handler } from '@netlify/functions';
import { tokensStore } from '../../src/lib/_blobs.js';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified, userScopedKey } from '../../src/lib/_auth.js';
import { getDefaultPricingSettings } from '../../src/lib/pricing-config.js';

/**
 * Get user settings (promotion preferences, pricing config, auto-price reduction, etc.)
 * Returns: { 
 *   autoPromoteEnabled: boolean, 
 *   defaultPromotionRate: number | null,
 *   pricing: PricingSettings,
 *   autoPrice: { enabled, reduceBy, everyDays, minPrice }
 * }
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

    // Get pricing defaults
    const defaultPricing = getDefaultPricingSettings();

    // Default auto-price settings
    const defaultAutoPrice = {
      enabled: false,
      reduceBy: 100,    // $1.00 in cents
      everyDays: 7,
      minPriceType: 'fixed' as 'fixed' | 'percent',
      minPrice: 199,    // $1.99 in cents
      minPercent: 50    // 50%
    };

    // Return with defaults
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        autoPromoteEnabled: settings.autoPromoteEnabled || false,
        defaultPromotionRate: settings.defaultPromotionRate || null,
        pricing: {
          discountPercent: settings.pricing?.discountPercent ?? defaultPricing.discountPercent,
          shippingStrategy: settings.pricing?.shippingStrategy ?? defaultPricing.shippingStrategy,
          templateShippingEstimateCents: settings.pricing?.templateShippingEstimateCents ?? defaultPricing.templateShippingEstimateCents,
          shippingSubsidyCapCents: settings.pricing?.shippingSubsidyCapCents ?? defaultPricing.shippingSubsidyCapCents,
          minItemPriceCents: settings.pricing?.minItemPriceCents ?? defaultPricing.minItemPriceCents,
        },
        autoPrice: {
          enabled: settings.autoPrice?.enabled ?? defaultAutoPrice.enabled,
          reduceBy: settings.autoPrice?.reduceBy ?? defaultAutoPrice.reduceBy,
          everyDays: settings.autoPrice?.everyDays ?? defaultAutoPrice.everyDays,
          minPriceType: settings.autoPrice?.minPriceType ?? defaultAutoPrice.minPriceType,
          minPrice: settings.autoPrice?.minPrice ?? defaultAutoPrice.minPrice,
          minPercent: settings.autoPrice?.minPercent ?? defaultAutoPrice.minPercent,
        }
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
