/**
 * user-settings.service.ts
 *
 * Platform-agnostic service for user settings get/save.
 * Mirrors the logic of /.netlify/functions/user-settings-get
 * and /.netlify/functions/user-settings-save without any HTTP types.
 */

import { tokensStore } from '../lib/redis-store.js';
import { userScopedKey } from '../lib/_auth.js';
import { getDefaultPricingSettings } from '../lib/pricing-config.js';
import type { PricingSettings, ShippingStrategy, EbayShippingMode } from '../lib/pricing-config.js';

// ── types ────────────────────────────────────────────────────────────────────

export interface AutoPriceSettings {
  enabled: boolean;
  reduceBy?: number;
  everyDays?: number;
  minPriceType?: 'fixed' | 'percent';
  minPrice?: number;
  minPercent?: number;
}

export interface BestOfferSettings {
  enabled: boolean;
  autoDeclinePercent?: number;
  autoAcceptPercent?: number;
}

export interface UserSettingsResponse {
  autoPromoteEnabled: boolean;
  defaultPromotionRate: number | null;
  pricing: {
    discountPercent: number;
    shippingStrategy: ShippingStrategy;
    templateShippingEstimateCents: number;
    shippingSubsidyCapCents: number | null;
    minItemPriceCents: number;
    ebayShippingMode: EbayShippingMode;
    buyerShippingChargeCents: number;
    preferredCarrier: 'auto' | 'usps' | 'ups' | 'fedex';
  };
  autoPrice: Required<AutoPriceSettings>;
  bestOffer: Required<BestOfferSettings>;
  showPricingLogs: boolean;
}

export interface SaveSettingsInput {
  autoPromoteEnabled?: boolean;
  defaultPromotionRate?: number | null;
  pricing?: Partial<PricingSettings>;
  autoPrice?: AutoPriceSettings;
  bestOffer?: BestOfferSettings;
  showPricingLogs?: boolean;
}

export interface ValidationError {
  error: string;
}

// ── validation ───────────────────────────────────────────────────────────────

export function validateSaveInput(input: SaveSettingsInput): ValidationError | null {
  const { defaultPromotionRate, pricing, autoPrice, bestOffer } = input;

  if (defaultPromotionRate !== undefined && defaultPromotionRate !== null) {
    if (typeof defaultPromotionRate !== 'number' || defaultPromotionRate < 1 || defaultPromotionRate > 20) {
      return { error: 'defaultPromotionRate must be between 1 and 20' };
    }
  }

  if (pricing) {
    if (pricing.discountPercent !== undefined) {
      if (typeof pricing.discountPercent !== 'number' || pricing.discountPercent < 0 || pricing.discountPercent > 50) {
        return { error: 'discountPercent must be between 0 and 50' };
      }
    }
    if (pricing.shippingStrategy !== undefined) {
      const valid: ShippingStrategy[] = ['ALGO_COMPETITIVE_TOTAL', 'DISCOUNT_ITEM_ONLY'];
      if (!valid.includes(pricing.shippingStrategy)) {
        return { error: `shippingStrategy must be one of: ${valid.join(', ')}` };
      }
    }
    if (pricing.templateShippingEstimateCents !== undefined) {
      if (typeof pricing.templateShippingEstimateCents !== 'number' || pricing.templateShippingEstimateCents < 0) {
        return { error: 'templateShippingEstimateCents must be >= 0' };
      }
    }
    if (pricing.shippingSubsidyCapCents !== undefined && pricing.shippingSubsidyCapCents !== null) {
      if (typeof pricing.shippingSubsidyCapCents !== 'number' || pricing.shippingSubsidyCapCents < 0) {
        return { error: 'shippingSubsidyCapCents must be >= 0 or null' };
      }
    }
    if (pricing.minItemPriceCents !== undefined) {
      if (typeof pricing.minItemPriceCents !== 'number' || pricing.minItemPriceCents < 0) {
        return { error: 'minItemPriceCents must be >= 0' };
      }
    }
    if (pricing.ebayShippingMode !== undefined) {
      const validModes: EbayShippingMode[] = ['FREE_SHIPPING', 'BUYER_PAYS_SHIPPING'];
      if (!validModes.includes(pricing.ebayShippingMode as EbayShippingMode)) {
        return { error: `ebayShippingMode must be one of: ${validModes.join(', ')}` };
      }
    }
    if (pricing.buyerShippingChargeCents !== undefined) {
      if (typeof pricing.buyerShippingChargeCents !== 'number' || pricing.buyerShippingChargeCents < 0) {
        return { error: 'buyerShippingChargeCents must be >= 0' };
      }
    }
    if (pricing.preferredCarrier !== undefined) {
      const validCarriers = ['auto', 'usps', 'ups', 'fedex'];
      if (!validCarriers.includes(pricing.preferredCarrier as string)) {
        return { error: `preferredCarrier must be one of: ${validCarriers.join(', ')}` };
      }
    }
  }

  if (autoPrice?.enabled) {
    if (autoPrice.reduceBy !== undefined) {
      if (typeof autoPrice.reduceBy !== 'number' || autoPrice.reduceBy < 25 || autoPrice.reduceBy > 1000) {
        return { error: 'reduceBy must be between 25 and 1000 cents ($0.25 - $10.00)' };
      }
    }
    if (autoPrice.everyDays !== undefined) {
      if (typeof autoPrice.everyDays !== 'number' || autoPrice.everyDays < 1 || autoPrice.everyDays > 30) {
        return { error: 'everyDays must be between 1 and 30' };
      }
    }
    if (autoPrice.minPriceType !== undefined) {
      if (autoPrice.minPriceType !== 'fixed' && autoPrice.minPriceType !== 'percent') {
        return { error: 'minPriceType must be "fixed" or "percent"' };
      }
    }
    if (autoPrice.minPrice !== undefined) {
      if (typeof autoPrice.minPrice !== 'number' || autoPrice.minPrice < 99) {
        return { error: 'minPrice must be at least 99 cents ($0.99)' };
      }
    }
    if (autoPrice.minPercent !== undefined) {
      if (typeof autoPrice.minPercent !== 'number' || autoPrice.minPercent < 10 || autoPrice.minPercent > 90) {
        return { error: 'minPercent must be between 10 and 90' };
      }
    }
  }

  if (bestOffer) {
    if (bestOffer.autoDeclinePercent !== undefined) {
      if (typeof bestOffer.autoDeclinePercent !== 'number' || bestOffer.autoDeclinePercent < 10 || bestOffer.autoDeclinePercent > 95) {
        return { error: 'autoDeclinePercent must be between 10 and 95' };
      }
    }
    if (bestOffer.autoAcceptPercent !== undefined) {
      if (typeof bestOffer.autoAcceptPercent !== 'number' || bestOffer.autoAcceptPercent < 50 || bestOffer.autoAcceptPercent > 100) {
        return { error: 'autoAcceptPercent must be between 50 and 100' };
      }
    }
    if (
      bestOffer.autoDeclinePercent !== undefined &&
      bestOffer.autoAcceptPercent !== undefined &&
      bestOffer.autoDeclinePercent >= bestOffer.autoAcceptPercent
    ) {
      return { error: 'autoDeclinePercent must be less than autoAcceptPercent' };
    }
  }

  return null;
}

// ── read ─────────────────────────────────────────────────────────────────────

export async function getUserSettings(sub: string): Promise<UserSettingsResponse> {
  const store = tokensStore();
  const key = userScopedKey(sub, 'settings.json');

  let settings: Record<string, any> = {};
  try {
    settings = ((await store.get(key, { type: 'json' })) as any) ?? {};
  } catch {}
  if (!settings || typeof settings !== 'object') settings = {};

  const defaultPricing = getDefaultPricingSettings();

  return {
    autoPromoteEnabled: settings.autoPromoteEnabled || false,
    defaultPromotionRate: settings.defaultPromotionRate || null,
    pricing: {
      discountPercent: settings.pricing?.discountPercent ?? defaultPricing.discountPercent,
      shippingStrategy: settings.pricing?.shippingStrategy ?? defaultPricing.shippingStrategy,
      templateShippingEstimateCents:
        settings.pricing?.templateShippingEstimateCents ??
        defaultPricing.templateShippingEstimateCents,
      shippingSubsidyCapCents:
        settings.pricing?.shippingSubsidyCapCents ?? defaultPricing.shippingSubsidyCapCents,
      minItemPriceCents:
        settings.pricing?.minItemPriceCents ?? defaultPricing.minItemPriceCents,
      ebayShippingMode:
        settings.pricing?.ebayShippingMode ?? defaultPricing.ebayShippingMode,
      buyerShippingChargeCents:
        settings.pricing?.buyerShippingChargeCents ?? defaultPricing.buyerShippingChargeCents,
      preferredCarrier:
        settings.pricing?.preferredCarrier ?? defaultPricing.preferredCarrier,
    },
    autoPrice: {
      enabled: settings.autoPrice?.enabled ?? false,
      reduceBy: settings.autoPrice?.reduceBy ?? 100,
      everyDays: settings.autoPrice?.everyDays ?? 7,
      minPriceType: settings.autoPrice?.minPriceType ?? 'fixed',
      minPrice: settings.autoPrice?.minPrice ?? 199,
      minPercent: settings.autoPrice?.minPercent ?? 50,
    },
    bestOffer: {
      enabled: settings.bestOffer?.enabled ?? false,
      autoDeclinePercent: settings.bestOffer?.autoDeclinePercent ?? 60,
      autoAcceptPercent: settings.bestOffer?.autoAcceptPercent ?? 90,
    },
    showPricingLogs: settings.showPricingLogs ?? false,
  };
}

// ── write ────────────────────────────────────────────────────────────────────

export async function saveUserSettings(
  sub: string,
  input: SaveSettingsInput,
): Promise<UserSettingsResponse> {
  const store = tokensStore();
  const key = userScopedKey(sub, 'settings.json');

  let settings: Record<string, any> = {};
  try {
    settings = ((await store.get(key, { type: 'json' })) as any) ?? {};
  } catch {}
  if (!settings || typeof settings !== 'object') settings = {};

  const { autoPromoteEnabled, defaultPromotionRate, pricing, autoPrice, bestOffer, showPricingLogs } = input;

  if (autoPromoteEnabled !== undefined) settings.autoPromoteEnabled = autoPromoteEnabled;
  if (defaultPromotionRate !== undefined) settings.defaultPromotionRate = defaultPromotionRate;

  if (pricing) {
    if (!settings.pricing) settings.pricing = {};
    if (pricing.discountPercent !== undefined) settings.pricing.discountPercent = pricing.discountPercent;
    if (pricing.shippingStrategy !== undefined) settings.pricing.shippingStrategy = pricing.shippingStrategy;
    if (pricing.templateShippingEstimateCents !== undefined)
      settings.pricing.templateShippingEstimateCents = pricing.templateShippingEstimateCents;
    if (pricing.shippingSubsidyCapCents !== undefined)
      settings.pricing.shippingSubsidyCapCents = pricing.shippingSubsidyCapCents;
    if (pricing.minItemPriceCents !== undefined)
      settings.pricing.minItemPriceCents = pricing.minItemPriceCents;
    if (pricing.ebayShippingMode !== undefined)
      settings.pricing.ebayShippingMode = pricing.ebayShippingMode;
    if (pricing.buyerShippingChargeCents !== undefined)
      settings.pricing.buyerShippingChargeCents = pricing.buyerShippingChargeCents;
    if (pricing.preferredCarrier !== undefined)
      settings.pricing.preferredCarrier = pricing.preferredCarrier;
  }

  if (autoPrice !== undefined) {
    settings.autoPrice = {
      enabled: autoPrice.enabled ?? false,
      reduceBy: autoPrice.reduceBy ?? 100,
      everyDays: autoPrice.everyDays ?? 7,
      minPriceType: autoPrice.minPriceType ?? 'fixed',
      minPrice: autoPrice.minPrice ?? 199,
      minPercent: autoPrice.minPercent ?? 50,
    };
  }

  if (bestOffer !== undefined) {
    settings.bestOffer = {
      enabled: bestOffer.enabled ?? false,
      autoDeclinePercent: bestOffer.autoDeclinePercent ?? 60,
      autoAcceptPercent: bestOffer.autoAcceptPercent ?? 90,
    };
  }

  if (showPricingLogs !== undefined) settings.showPricingLogs = showPricingLogs;

  await store.set(key, JSON.stringify(settings));

  return getUserSettings(sub);
}
