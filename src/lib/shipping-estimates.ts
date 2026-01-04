/**
 * Shipping Estimates - Strategy-Based
 * 
 * Provides shipping cost estimates using multiple strategies:
 * - FLAT: User-defined fixed rate
 * - CATEGORY_ESTIMATE: Keyword-based category detection with tunable rates
 * - (Future) CARRIER_RATE: USPS/UPS API with real weights
 * 
 * @see docs/PRICING-OVERHAUL.md - Phase 4
 */

import { CompetitorPrice } from './delivered-pricing.js';

// ============================================================================
// Types
// ============================================================================

/** Shipping strategy mode */
export type ShippingMode = 'FLAT' | 'CATEGORY_ESTIMATE';

/** Source of shipping estimate (for logging/debugging) */
export type ShippingSource = 'flat' | 'category' | 'size-heuristic' | 'comps' | 'comp-median' | 'default';

/** Size signal extracted from product text */
export interface SizeSignal {
  signalType: 'weight' | 'volume' | 'count' | 'unknown';
  value: number;
  unit: string;
  band: 'light' | 'medium' | 'heavy' | 'extra-heavy' | 'unknown';
  bandCents: number;
}

export interface ShippingEstimate {
  cents: number;
  source: ShippingSource;
  confidence: 'high' | 'medium' | 'low';
  categoryDetected?: string;
  sizeSignal?: SizeSignal;
}

/** User-configurable shipping settings */
export interface ShippingConfig {
  mode: ShippingMode;
  
  // FLAT mode
  flatCents?: number;  // e.g., 600 for $6.00
  
  // CATEGORY_ESTIMATE mode - user can override defaults
  categoryRates?: Record<string, number>;
  
  // Size heuristic - enable/disable parsing "8 oz", "30 mL", etc.
  useSizeHeuristic?: boolean;
  
  // Shared settings
  minCents: number;
  maxCents: number;
  
  // Free shipping
  freeShippingEnabled?: boolean;
  freeShippingSubsidyCapCents?: number;
}

/** Legacy settings interface (for backward compatibility) */
export interface ShippingSettings {
  preferredSource: 'default' | 'category' | 'comps';
  defaultCents: number;
  minCents: number;
  maxCents: number;
}

// ============================================================================
// Category Shipping Table
// ============================================================================

/**
 * Shipping cost estimates by product category.
 * Based on typical USPS/UPS Ground rates for common eBay items.
 */
export const CATEGORY_SHIPPING: Record<string, number> = {
  // Beauty & Personal Care
  'beauty':           450,  // $4.50 - skincare, small items
  'skincare':         450,  // $4.50
  'cosmetics':        450,  // $4.50 - makeup
  'haircare':         500,  // $5.00 - shampoo, conditioner
  'fragrance':        550,  // $5.50 - perfume/cologne
  
  // Health & Supplements  
  'supplements':      500,  // $5.00 - vitamins, mints, pills
  'vitamins':         500,  // $5.00
  'health':           550,  // $5.50
  
  // Clothing & Fashion
  'clothing':         550,  // $5.50 - shirts, light apparel
  'shoes':            850,  // $8.50 - heavier, larger boxes
  'bags':             750,  // $7.50 - purses, backpacks
  'accessories':      500,  // $5.00 - small items
  'jewelry':          400,  // $4.00 - small, lightweight
  
  // Electronics
  'electronics':      650,  // $6.50 - varies widely
  'phones':           600,  // $6.00
  'computers':        950,  // $9.50 - laptops, monitors
  'audio':            700,  // $7.00
  
  // Media
  'books':            400,  // $4.00 - media mail eligible
  'dvds':             400,  // $4.00 - media mail
  'games':            500,  // $5.00
  
  // Home & Garden
  'home':             700,  // $7.00
  'kitchen':          750,  // $7.50
  'garden':           800,  // $8.00
  
  // Default fallback
  'default':          600,  // $6.00
};

// ============================================================================
// Category Detection
// ============================================================================

/**
 * Keywords that map to shipping categories
 */
const CATEGORY_KEYWORDS: Record<string, string[]> = {
  'beauty': ['serum', 'moisturizer', 'cream', 'lotion', 'cleanser', 'toner', 'skincare', 'face', 'skin'],
  'haircare': ['shampoo', 'conditioner', 'hair', 'olaplex', 'treatment'],
  'cosmetics': ['makeup', 'mascara', 'lipstick', 'eyeshadow', 'foundation', 'concealer', 'blush'],
  'fragrance': ['perfume', 'cologne', 'fragrance', 'eau de'],
  'supplements': ['vitamin', 'supplement', 'mints', 'gummies', 'capsules', 'tablets', 'pills', 'neuro'],
  'clothing': ['shirt', 'pants', 'dress', 'jacket', 'sweater', 'top', 'blouse'],
  'shoes': ['shoes', 'sneakers', 'boots', 'sandals', 'heels', 'loafers'],
  'bags': ['bag', 'purse', 'backpack', 'tote', 'wallet', 'clutch'],
  'electronics': ['phone', 'laptop', 'tablet', 'charger', 'cable', 'headphone', 'speaker'],
  'books': ['book', 'novel', 'textbook', 'paperback', 'hardcover'],
};

/**
 * Detect product category from brand and product name
 */
export function detectCategory(brand: string, productName: string): string {
  const text = `${brand} ${productName}`.toLowerCase();
  
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const keyword of keywords) {
      if (text.includes(keyword)) {
        return category;
      }
    }
  }
  
  return 'default';
}

// ============================================================================
// Size/Weight Heuristic Parser
// ============================================================================

/**
 * Shipping bands based on estimated size/weight
 */
const SIZE_BANDS = {
  'light':       400,  // $4.00 - ≤2 oz or ≤60 mL
  'medium':      500,  // $5.00 - ≤8 oz or ≤250 mL  
  'heavy':       650,  // $6.50 - ≤16 oz or ≤500 mL
  'extra-heavy': 850,  // $8.50 - >16 oz
  'unknown':     600,  // $6.00 - fallback
};

/**
 * Parse size/weight signals from product text
 * 
 * Extracts patterns like:
 * - "8.5 oz", "16oz", "1.7 fl oz"
 * - "30 mL", "100ml", "250 ML"
 * - "120 capsules", "60 ct", "30 servings"
 * - "1 lb", "2.5 lbs"
 */
export function parseSizeSignal(productName: string): SizeSignal {
  const text = productName.toLowerCase();
  
  // Weight patterns (oz, lb)
  const ozMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:fl\.?\s*)?oz\b/);
  if (ozMatch) {
    const oz = parseFloat(ozMatch[1]);
    return {
      signalType: 'weight',
      value: oz,
      unit: 'oz',
      ...ozToBand(oz),
    };
  }
  
  const lbMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:lb|lbs)\b/);
  if (lbMatch) {
    const lb = parseFloat(lbMatch[1]);
    const oz = lb * 16;
    return {
      signalType: 'weight',
      value: lb,
      unit: 'lb',
      ...ozToBand(oz),
    };
  }
  
  // Volume patterns (mL, L)
  const mlMatch = text.match(/(\d+(?:\.\d+)?)\s*ml\b/);
  if (mlMatch) {
    const ml = parseFloat(mlMatch[1]);
    return {
      signalType: 'volume',
      value: ml,
      unit: 'ml',
      ...mlToBand(ml),
    };
  }
  
  const literMatch = text.match(/(\d+(?:\.\d+)?)\s*l\b/);
  if (literMatch) {
    const l = parseFloat(literMatch[1]);
    const ml = l * 1000;
    return {
      signalType: 'volume',
      value: l,
      unit: 'l',
      ...mlToBand(ml),
    };
  }
  
  // Count patterns (capsules, tablets, ct, servings)
  const countMatch = text.match(/(\d+)\s*(?:capsules?|tablets?|ct|count|servings?|pieces?|gummies?|mints?)/);
  if (countMatch) {
    const count = parseInt(countMatch[1]);
    return {
      signalType: 'count',
      value: count,
      unit: 'count',
      ...countToBand(count),
    };
  }
  
  // Gram/kg patterns
  const gMatch = text.match(/(\d+(?:\.\d+)?)\s*g\b/);
  if (gMatch) {
    const g = parseFloat(gMatch[1]);
    const oz = g / 28.35;
    return {
      signalType: 'weight',
      value: g,
      unit: 'g',
      ...ozToBand(oz),
    };
  }
  
  const kgMatch = text.match(/(\d+(?:\.\d+)?)\s*kg\b/);
  if (kgMatch) {
    const kg = parseFloat(kgMatch[1]);
    const oz = kg * 35.27;
    return {
      signalType: 'weight',
      value: kg,
      unit: 'kg',
      ...ozToBand(oz),
    };
  }
  
  return {
    signalType: 'unknown',
    value: 0,
    unit: '',
    band: 'unknown',
    bandCents: SIZE_BANDS.unknown,
  };
}

/** Convert oz to shipping band */
function ozToBand(oz: number): { band: SizeSignal['band']; bandCents: number } {
  if (oz <= 2)  return { band: 'light', bandCents: SIZE_BANDS.light };
  if (oz <= 8)  return { band: 'medium', bandCents: SIZE_BANDS.medium };
  if (oz <= 16) return { band: 'heavy', bandCents: SIZE_BANDS.heavy };
  return { band: 'extra-heavy', bandCents: SIZE_BANDS['extra-heavy'] };
}

/** Convert mL to shipping band (approximate - assumes water-like density) */
function mlToBand(ml: number): { band: SizeSignal['band']; bandCents: number } {
  // 30ml ≈ 1oz, so multiply by ~0.034
  if (ml <= 60)  return { band: 'light', bandCents: SIZE_BANDS.light };
  if (ml <= 250) return { band: 'medium', bandCents: SIZE_BANDS.medium };
  if (ml <= 500) return { band: 'heavy', bandCents: SIZE_BANDS.heavy };
  return { band: 'extra-heavy', bandCents: SIZE_BANDS['extra-heavy'] };
}

/** Convert count (capsules, etc.) to shipping band */
function countToBand(count: number): { band: SizeSignal['band']; bandCents: number } {
  // Most supplement bottles are light regardless of count
  // But very high counts suggest larger bottles
  if (count <= 60)  return { band: 'light', bandCents: SIZE_BANDS.light };
  if (count <= 120) return { band: 'light', bandCents: SIZE_BANDS.light };
  if (count <= 240) return { band: 'medium', bandCents: SIZE_BANDS.medium };
  return { band: 'heavy', bandCents: SIZE_BANDS.heavy };
}

// ============================================================================
// Comp-Based Shipping
// ============================================================================

/**
 * Calculate median shipping from competitor data
 */
function medianShipping(comps: CompetitorPrice[]): number {
  const ships = comps.map(c => c.shipCents).sort((a, b) => a - b);
  if (ships.length === 0) return 0;
  
  const mid = Math.floor(ships.length / 2);
  return ships.length % 2 === 0
    ? Math.round((ships[mid - 1] + ships[mid]) / 2)
    : ships[mid];
}

/**
 * Analyze competitor shipping patterns
 */
export function analyzeCompShipping(comps: CompetitorPrice[]): {
  medianCents: number;
  freeShipPercent: number;
  mostCommonCents: number;
  count: number;
} {
  if (comps.length === 0) {
    return { medianCents: 0, freeShipPercent: 0, mostCommonCents: 0, count: 0 };
  }
  
  const ships = comps.map(c => c.shipCents);
  const freeCount = ships.filter(s => s === 0).length;
  const freeShipPercent = Math.round((freeCount / ships.length) * 100);
  
  // Find most common shipping value
  const freq = new Map<number, number>();
  for (const s of ships) {
    freq.set(s, (freq.get(s) || 0) + 1);
  }
  let mostCommonCents = 0;
  let maxFreq = 0;
  for (const [val, count] of freq.entries()) {
    if (count > maxFreq) {
      mostCommonCents = val;
      maxFreq = count;
    }
  }
  
  return {
    medianCents: medianShipping(comps),
    freeShipPercent,
    mostCommonCents,
    count: comps.length,
  };
}

// ============================================================================
// Main Functions
// ============================================================================

export const DEFAULT_SHIPPING_SETTINGS: ShippingSettings = {
  preferredSource: 'category',
  defaultCents: 600,
  minCents: 300,
  maxCents: 1200,
};

export const DEFAULT_SHIPPING_CONFIG: ShippingConfig = {
  mode: 'CATEGORY_ESTIMATE',
  flatCents: 600,
  categoryRates: { ...CATEGORY_SHIPPING },  // Copy defaults, user can override
  useSizeHeuristic: true,
  minCents: 300,
  maxCents: 1200,
  freeShippingEnabled: true,
  freeShippingSubsidyCapCents: 500,
};

/**
 * Get shipping estimate using configured mode
 * 
 * Modes:
 * - FLAT: Returns flatCents (simple, predictable)
 * - CATEGORY_ESTIMATE: Uses category detection + optional size heuristic
 * 
 * Size heuristic (when enabled) can refine category estimates:
 * - Extracts "8 oz", "30 mL", "120 capsules" from product name
 * - Maps to shipping bands: light ($4), medium ($5), heavy ($6.50)
 */
export function getShippingByMode(
  brand: string,
  productName: string,
  config: Partial<ShippingConfig> = {},
  comps: CompetitorPrice[] = []
): ShippingEstimate {
  const c = { ...DEFAULT_SHIPPING_CONFIG, ...config };
  
  // FLAT mode - simplest
  if (c.mode === 'FLAT') {
    const cents = Math.max(c.minCents, Math.min(c.flatCents ?? 600, c.maxCents));
    return {
      cents,
      source: 'flat',
      confidence: 'high',  // User explicitly set this
    };
  }
  
  // CATEGORY_ESTIMATE mode
  const category = detectCategory(brand, productName);
  const categoryRates = c.categoryRates ?? CATEGORY_SHIPPING;
  let baseCents = categoryRates[category] ?? categoryRates.default ?? 600;
  
  // Try size heuristic to refine estimate
  let sizeSignal: SizeSignal | undefined;
  if (c.useSizeHeuristic) {
    sizeSignal = parseSizeSignal(productName);
    
    // Use size-based estimate if we found a signal and it differs from category
    if (sizeSignal.signalType !== 'unknown') {
      // Size heuristic takes priority over generic category
      // But we average with category to smooth out errors
      const sizeWeight = 0.6;  // Trust size signal 60%
      const categoryWeight = 0.4;
      baseCents = Math.round(sizeSignal.bandCents * sizeWeight + baseCents * categoryWeight);
      
      return {
        cents: Math.max(c.minCents, Math.min(baseCents, c.maxCents)),
        source: 'size-heuristic',
        confidence: 'medium',
        categoryDetected: category,
        sizeSignal,
      };
    }
  }
  
  // Pure category-based
  return {
    cents: Math.max(c.minCents, Math.min(baseCents, c.maxCents)),
    source: 'category',
    confidence: category !== 'default' ? 'medium' : 'low',
    categoryDetected: category,
  };
}

/**
 * Get smart shipping estimate based on category and/or competitor data
 * (Legacy function - use getShippingByMode for new code)
 * 
 * Priority:
 * 1. Comp-based (if enough comps and requested)
 * 2. Category-based (if category detected)
 * 3. Default fallback
 */
export function getShippingEstimate(
  brand: string,
  productName: string,
  comps: CompetitorPrice[] = [],
  settings: Partial<ShippingSettings> = {}
): ShippingEstimate {
  const s = { ...DEFAULT_SHIPPING_SETTINGS, ...settings };
  
  // Try comp-based first if requested and enough data
  if (s.preferredSource === 'comps' && comps.length >= 3) {
    const analysis = analyzeCompShipping(comps);
    
    // If 70%+ offer free shipping, use lower estimate
    if (analysis.freeShipPercent >= 70) {
      return {
        cents: Math.max(s.minCents, 400), // $4.00 when most offer free
        source: 'comp-median',
        confidence: 'high',
      };
    }
    
    // Use median of competitor shipping
    const estimate = Math.max(s.minCents, Math.min(analysis.medianCents, s.maxCents));
    return {
      cents: estimate,
      source: 'comp-median',
      confidence: analysis.count >= 5 ? 'high' : 'medium',
    };
  }
  
  // Use new mode-based logic for category estimates
  return getShippingByMode(brand, productName, {
    mode: 'CATEGORY_ESTIMATE',
    useSizeHeuristic: true,  // Enable by default
    minCents: s.minCents,
    maxCents: s.maxCents,
  });
}

/**
 * Quick helper to get just the shipping cents
 */
export function estimateShipping(brand: string, productName: string): number {
  return getShippingEstimate(brand, productName).cents;
}
