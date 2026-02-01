import type { Handler } from '@netlify/functions';
import { tokensStore } from '../../src/lib/redis-store.js';
import { getBearerToken, getJwtSubUnverified, requireAuthVerified, userScopedKey } from '../../src/lib/_auth.js';
import type { PricingSettings, ShippingStrategy } from '../../src/lib/pricing-config.js';

/**
 * Auto-price reduction settings
 */
interface AutoPriceSettings {
  enabled: boolean;
  reduceBy?: number;  // cents
  everyDays?: number;
  minPriceType?: 'fixed' | 'percent';  // how to calculate minimum price floor
  minPrice?: number;  // cents (used when minPriceType='fixed')
  minPercent?: number;  // percentage of listing price (used when minPriceType='percent')
}

/**
 * Best Offer settings for eBay listings
 */
interface BestOfferSettings {
  enabled: boolean;
  autoDeclinePercent?: number;  // Minimum offer to consider (e.g., 60 = 60% of listing price)
  autoAcceptPercent?: number;   // Auto-accept offers at or above this percent (e.g., 90 = 90% of listing price)
}

/**
 * Save user settings (promotion preferences, pricing config, auto-price reduction, best offer, etc.)
 * POST body: { 
 *   autoPromoteEnabled?: boolean, 
 *   defaultPromotionRate?: number,
 *   pricing?: Partial<PricingSettings>,
 *   autoPrice?: AutoPriceSettings,
 *   bestOffer?: BestOfferSettings
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
    const autoPrice = body.autoPrice as AutoPriceSettings | undefined;
    const bestOffer = body.bestOffer as BestOfferSettings | undefined;
    const showPricingLogs = body.showPricingLogs as boolean | undefined;

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

    // Validate auto-price settings if provided
    if (autoPrice && autoPrice.enabled) {
      if (autoPrice.reduceBy !== undefined) {
        if (typeof autoPrice.reduceBy !== 'number' || autoPrice.reduceBy < 25 || autoPrice.reduceBy > 1000) {
          return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'reduceBy must be between 25 and 1000 cents ($0.25 - $10.00)' })
          };
        }
      }
      if (autoPrice.everyDays !== undefined) {
        if (typeof autoPrice.everyDays !== 'number' || autoPrice.everyDays < 1 || autoPrice.everyDays > 30) {
          return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'everyDays must be between 1 and 30' })
          };
        }
      }
      if (autoPrice.minPriceType !== undefined) {
        if (autoPrice.minPriceType !== 'fixed' && autoPrice.minPriceType !== 'percent') {
          return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'minPriceType must be "fixed" or "percent"' })
          };
        }
      }
      if (autoPrice.minPrice !== undefined) {
        if (typeof autoPrice.minPrice !== 'number' || autoPrice.minPrice < 99) {
          return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'minPrice must be at least 99 cents ($0.99)' })
          };
        }
      }
      if (autoPrice.minPercent !== undefined) {
        if (typeof autoPrice.minPercent !== 'number' || autoPrice.minPercent < 10 || autoPrice.minPercent > 90) {
          return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'minPercent must be between 10 and 90' })
          };
        }
      }
    }

    // Validate best offer settings if provided
    if (bestOffer) {
      if (bestOffer.autoDeclinePercent !== undefined) {
        if (typeof bestOffer.autoDeclinePercent !== 'number' || bestOffer.autoDeclinePercent < 10 || bestOffer.autoDeclinePercent > 95) {
          return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'autoDeclinePercent must be between 10 and 95' })
          };
        }
      }
      if (bestOffer.autoAcceptPercent !== undefined) {
        if (typeof bestOffer.autoAcceptPercent !== 'number' || bestOffer.autoAcceptPercent < 50 || bestOffer.autoAcceptPercent > 100) {
          return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'autoAcceptPercent must be between 50 and 100' })
          };
        }
      }
      // Validate that autoDecline < autoAccept if both are set
      if (bestOffer.autoDeclinePercent !== undefined && bestOffer.autoAcceptPercent !== undefined) {
        if (bestOffer.autoDeclinePercent >= bestOffer.autoAcceptPercent) {
          return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'autoDeclinePercent must be less than autoAcceptPercent' })
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

    // Update auto-price reduction settings
    if (autoPrice !== undefined) {
      settings.autoPrice = {
        enabled: autoPrice.enabled ?? false,
        reduceBy: autoPrice.reduceBy ?? 100,  // default $1.00
        everyDays: autoPrice.everyDays ?? 7,  // default 7 days
        minPriceType: autoPrice.minPriceType ?? 'fixed',  // default to fixed amount
        minPrice: autoPrice.minPrice ?? 199,  // default $1.99
        minPercent: autoPrice.minPercent ?? 50  // default 50%
      };
    }

    // Update best offer settings
    if (bestOffer !== undefined) {
      settings.bestOffer = {
        enabled: bestOffer.enabled ?? false,
        autoDeclinePercent: bestOffer.autoDeclinePercent ?? 60,  // default auto-decline below 60% of price
        autoAcceptPercent: bestOffer.autoAcceptPercent ?? 90     // default auto-accept at 90% of price
      };
    }

    // Update show pricing logs setting
    if (showPricingLogs !== undefined) {
      settings.showPricingLogs = showPricingLogs;
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
