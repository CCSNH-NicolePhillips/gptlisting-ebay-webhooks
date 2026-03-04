/**
 * carrier-rates.ts
 *
 * Embedded carrier rate tables for shipping cost estimation.
 * Used to compute realistic shipping cost for pricing decisions.
 *
 * RATES: 2025 commercial/discounted rates (eBay sellers qualify via eBay shipping labels).
 * Domestic rates use Zone 4-5 average (covers ~60% of US domestic shipments).
 * International rates use USPS Priority Mail International (cheapest available since
 * USPS discontinued First Class Package International in 2023).
 *
 * These are ESTIMATES for pricing purposes, not exact quotes.
 * Live API integration (UPS/FedEx/USPS OAuth) can replace these tables in the future.
 */

export type CarrierName = 'usps' | 'ups' | 'fedex';
export type PreferredCarrier = CarrierName | 'auto';

export type ServiceName =
  | 'usps_first_class'
  | 'usps_ground_advantage'
  | 'usps_priority'
  | 'usps_priority_flat_rate_small'
  | 'usps_priority_flat_rate_medium'
  | 'ups_ground'
  | 'fedex_ground_economy';

export interface RateResult {
  cents: number;
  carrier: CarrierName;
  service: ServiceName;
  weightOz: number;
  note?: string;
}

// ─── Rate table helpers ───────────────────────────────────────────────────────

interface RateBand {
  maxWeightOz: number; // inclusive upper bound
  cents: number;
}

function lookupBand(bands: RateBand[], weightOz: number): number {
  for (const band of bands) {
    if (weightOz <= band.maxWeightOz) return band.cents;
  }
  return bands[bands.length - 1].cents; // clamp at max
}

// ─── USPS First Class Package Service (domestic, commercial 2025) ─────────────
// Available for packages ≤ 15.999 oz.
// eBay sellers get ~15% discount vs retail through eBay shipping labels.
const USPS_FIRST_CLASS: RateBand[] = [
  { maxWeightOz: 1,   cents: 345 },
  { maxWeightOz: 2,   cents: 361 },
  { maxWeightOz: 3,   cents: 378 },
  { maxWeightOz: 4,   cents: 395 },
  { maxWeightOz: 6,   cents: 416 },
  { maxWeightOz: 8,   cents: 435 },
  { maxWeightOz: 10,  cents: 455 },
  { maxWeightOz: 12,  cents: 473 },
  { maxWeightOz: 15,  cents: 510 }, // max for First Class
];

// ─── USPS Ground Advantage (domestic, commercial 2025) ────────────────────────
// Replaced First Class Packages + Parcel Select for most items.
// Usually cheaper than Priority Mail for items over 1 lb.
const USPS_GROUND_ADVANTAGE: RateBand[] = [
  { maxWeightOz: 16,  cents: 650 },   // 1 lb
  { maxWeightOz: 32,  cents: 744 },   // 2 lb
  { maxWeightOz: 48,  cents: 838 },   // 3 lb
  { maxWeightOz: 64,  cents: 933 },   // 4 lb
  { maxWeightOz: 80,  cents: 1009 },  // 5 lb
  { maxWeightOz: 112, cents: 1155 },  // 7 lb
  { maxWeightOz: 160, cents: 1368 },  // 10 lb
  { maxWeightOz: 240, cents: 1720 },  // 15 lb
  { maxWeightOz: 320, cents: 2020 },  // 20 lb
];

// ─── USPS Priority Mail (domestic, commercial 2025, Zone 4 avg) ───────────────
// Faster (1-3 days) but more expensive. Best for items 1-5 lbs when speed matters.
const USPS_PRIORITY: RateBand[] = [
  { maxWeightOz: 16,  cents: 850 },   // 1 lb
  { maxWeightOz: 32,  cents: 918 },   // 2 lb
  { maxWeightOz: 48,  cents: 1010 },  // 3 lb
  { maxWeightOz: 64,  cents: 1118 },  // 4 lb
  { maxWeightOz: 80,  cents: 1224 },  // 5 lb
  { maxWeightOz: 112, cents: 1386 },  // 7 lb
  { maxWeightOz: 160, cents: 1650 },  // 10 lb
  { maxWeightOz: 240, cents: 2100 },  // 15 lb
  { maxWeightOz: 320, cents: 2560 },  // 20 lb
];

// ─── USPS Priority Mail Flat Rate (domestic) ──────────────────────────────────
// Weight-independent — if product fits, this can be a great deal for heavier items.
export const USPS_FLAT_RATE_SMALL_CENTS  = 945;   // small flat rate box (~8.5"×5.5"×1.75")
export const USPS_FLAT_RATE_MEDIUM_CENTS = 1465;  // medium flat rate box (11"×8.5"×5.5")
export const USPS_FLAT_RATE_LARGE_CENTS  = 1965;  // large flat rate box (12"×12"×5.5")

// ─── UPS Ground (domestic, commercial 2025, Zone 4 avg) ───────────────────────
// Usually more expensive than USPS for under 5 lbs.
// Better for heavier items (5 lb+) or when driver pickup is available.
const UPS_GROUND: RateBand[] = [
  { maxWeightOz: 16,  cents: 1050 },  // 1 lb
  { maxWeightOz: 32,  cents: 1152 },  // 2 lb
  { maxWeightOz: 48,  cents: 1242 },  // 3 lb
  { maxWeightOz: 64,  cents: 1323 },  // 4 lb
  { maxWeightOz: 80,  cents: 1400 },  // 5 lb
  { maxWeightOz: 112, cents: 1590 },  // 7 lb
  { maxWeightOz: 160, cents: 1760 },  // 10 lb
  { maxWeightOz: 240, cents: 2200 },  // 15 lb
  { maxWeightOz: 320, cents: 2640 },  // 20 lb
];

// ─── FedEx Ground Economy (domestic, commercial 2025, Zone 4 avg) ─────────────
// Formerly "SmartPost". Slower than UPS Ground but cheaper; uses USPS for last mile.
const FEDEX_GROUND_ECONOMY: RateBand[] = [
  { maxWeightOz: 16,  cents: 911 },   // 1 lb
  { maxWeightOz: 32,  cents: 1002 },  // 2 lb
  { maxWeightOz: 48,  cents: 1084 },  // 3 lb
  { maxWeightOz: 64,  cents: 1158 },  // 4 lb
  { maxWeightOz: 80,  cents: 1227 },  // 5 lb
  { maxWeightOz: 112, cents: 1389 },  // 7 lb
  { maxWeightOz: 160, cents: 1546 },  // 10 lb
  { maxWeightOz: 240, cents: 1930 },  // 15 lb
  { maxWeightOz: 320, cents: 2310 },  // 20 lb
];

// ─── International: USPS Priority Mail International (2025) ───────────────────
// Only realistic option since USPS ended First Class Package International (2023).
// eBay sellers using eBay International Shipping (EIS) get a flat label rate —
// these are for sellers handling international shipments themselves.
//
// Zone 1 = Canada, Zone 2 = Mexico/Caribbean, Zone 3 = Europe/Australia/Japan

interface IntlRateBand {
  maxWeightOz: number;
  canadaCents: number;  // Zone 1 — Canada
  europeCents: number;  // Zone 3 — UK, Germany, France
  asiaPacCents: number; // Zone 5 — Australia, Japan
}

const USPS_INTL_PRIORITY: IntlRateBand[] = [
  // USPS Priority Mail International First-Class Package equivalent (< 4 lbs)
  { maxWeightOz: 16,  canadaCents: 2800, europeCents: 3900, asiaPacCents: 4100 },
  { maxWeightOz: 32,  canadaCents: 3200, europeCents: 4500, asiaPacCents: 4800 },
  { maxWeightOz: 48,  canadaCents: 3700, europeCents: 5200, asiaPacCents: 5600 },
  { maxWeightOz: 64,  canadaCents: 4200, europeCents: 6000, asiaPacCents: 6500 },
  { maxWeightOz: 160, canadaCents: 5800, europeCents: 8500, asiaPacCents: 9200 },
];

export type IntlRegion = 'canada' | 'europe' | 'asia_pacific' | 'mexico';

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Estimate domestic US shipping cost for a given weight.
 *
 * With `preferred = 'auto'`, selects the cheapest service for the weight:
 *   - ≤ 15 oz  → USPS First Class (always cheapest)
 *   - 16-80 oz → cheapest of Ground Advantage vs Priority
 *   - 80+ oz   → Ground Advantage (usually cheapest per oz)
 *
 * Explicit carrier selection forces that carrier's service but still falls
 * back to USPS First Class for very light packages where it's always cheaper.
 */
export function estimateDomesticRate(
  weightOz: number,
  preferred: PreferredCarrier = 'auto',
): RateResult {
  const w = Math.max(0.5, weightOz); // minimum half-ounce

  // ── USPS First Class: always cheapest for < 16 oz ──
  if (w < 16 && (preferred === 'auto' || preferred === 'usps')) {
    return {
      cents: lookupBand(USPS_FIRST_CLASS, w),
      carrier: 'usps',
      service: 'usps_first_class',
      weightOz: w,
    };
  }

  // For small items, even when user prefers UPS/FedEx, use USPS First Class
  // because commercial UPS/FedEx have minimums that make tiny packages expensive.
  if (w < 16) {
    return {
      cents: lookupBand(USPS_FIRST_CLASS, w),
      carrier: 'usps',
      service: 'usps_first_class',
      weightOz: w,
      note: 'USPS First Class used (cheapest for < 1 lb regardless of carrier preference)',
    };
  }

  switch (preferred) {
    case 'ups':
      return {
        cents: lookupBand(UPS_GROUND, w),
        carrier: 'ups',
        service: 'ups_ground',
        weightOz: w,
      };

    case 'fedex':
      return {
        cents: lookupBand(FEDEX_GROUND_ECONOMY, w),
        carrier: 'fedex',
        service: 'fedex_ground_economy',
        weightOz: w,
      };

    case 'usps': {
      const groundCents = lookupBand(USPS_GROUND_ADVANTAGE, w);
      const priorityCents = lookupBand(USPS_PRIORITY, w);
      if (groundCents <= priorityCents) {
        return { cents: groundCents, carrier: 'usps', service: 'usps_ground_advantage', weightOz: w };
      }
      return { cents: priorityCents, carrier: 'usps', service: 'usps_priority', weightOz: w };
    }

    default: {
      // auto — pick cheapest across all carriers
      const uspsGround   = lookupBand(USPS_GROUND_ADVANTAGE, w);
      const uspsPriority = lookupBand(USPS_PRIORITY, w);
      const upsGround    = lookupBand(UPS_GROUND, w);
      const fedexGE      = lookupBand(FEDEX_GROUND_ECONOMY, w);

      const cheapestUsps = Math.min(uspsGround, uspsPriority);
      const cheapestAll  = Math.min(cheapestUsps, upsGround, fedexGE);

      if (cheapestAll === fedexGE) {
        return { cents: fedexGE, carrier: 'fedex', service: 'fedex_ground_economy', weightOz: w };
      }
      if (cheapestAll === upsGround) {
        return { cents: upsGround, carrier: 'ups', service: 'ups_ground', weightOz: w };
      }
      if (cheapestAll === uspsGround) {
        return { cents: uspsGround, carrier: 'usps', service: 'usps_ground_advantage', weightOz: w };
      }
      return { cents: uspsPriority, carrier: 'usps', service: 'usps_priority', weightOz: w };
    }
  }
}

/**
 * Estimate international shipping cost.
 * Currently only covers USPS Priority Mail International (most practical for eBay sellers).
 * For sellers using eBay International Shipping (EIS), this is an internal cost estimate.
 */
export function estimateInternationalRate(weightOz: number, region: IntlRegion): RateResult {
  const w = Math.max(0.5, weightOz);

  for (const band of USPS_INTL_PRIORITY) {
    if (w <= band.maxWeightOz) {
      let cents: number;
      switch (region) {
        case 'canada':       cents = band.canadaCents; break;
        case 'europe':       cents = band.europeCents; break;
        case 'asia_pacific': cents = band.asiaPacCents; break;
        case 'mexico':       cents = Math.round(band.canadaCents * 1.1); break;
        default:             cents = band.europeCents;
      }
      return { cents, carrier: 'usps', service: 'usps_priority', weightOz: w };
    }
  }

  // Over max weight
  const last = USPS_INTL_PRIORITY[USPS_INTL_PRIORITY.length - 1];
  const cents = region === 'canada' ? last.canadaCents
    : region === 'asia_pacific' ? last.asiaPacCents
    : last.europeCents;
  return { cents, carrier: 'usps', service: 'usps_priority', weightOz: w };
}

/**
 * Human-readable service name for UI display.
 */
export function serviceDisplayName(service: ServiceName): string {
  const names: Record<ServiceName, string> = {
    usps_first_class:              'USPS First Class',
    usps_ground_advantage:         'USPS Ground Advantage',
    usps_priority:                 'USPS Priority Mail',
    usps_priority_flat_rate_small:  'USPS Priority Flat Rate (Small)',
    usps_priority_flat_rate_medium: 'USPS Priority Flat Rate (Medium)',
    ups_ground:                    'UPS Ground',
    fedex_ground_economy:          'FedEx Ground Economy',
  };
  return names[service] ?? service;
}
