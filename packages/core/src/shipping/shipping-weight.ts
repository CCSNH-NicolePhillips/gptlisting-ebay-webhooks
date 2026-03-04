/**
 * shipping-weight.ts
 *
 * Converts a product's net weight (as read from the label by vision classification)
 * into a realistic shipping weight in ounces.
 *
 * Shipping weight = net content weight + packaging overhead.
 * The result is used to look up carrier rates in carrier-rates.ts.
 *
 * WHY THIS EXISTS:
 * The label says "8 oz" but that's the NET product weight.  The shipping weight
 * includes the bottle, box, bubble wrap, and padded mailer — easily 3-6 oz extra
 * for a typical small health/beauty item.  Using gross shipping weight prevents
 * us from under-estimating our carrier cost.
 */

export interface NetWeight {
  value: number;
  unit: string;
}

// ─── Packaging overhead by net-weight size band ────────────────────────────────
// These represent typical overwrap + protective mailer weight.
//   tiny   : < 2 oz net  → small poly bag or padded envelope  (+2 oz)
//   small  : 2-8 oz net  → small bottle or vial in padded mailer  (+3 oz)
//   medium : 8-24 oz net → medium jar/bottle in small box  (+5 oz)
//   large  : 24-64 oz net → large jar or tub in standard box  (+8 oz)
//   xlarge : > 64 oz net  → bulk container, heavy box  (+12 oz)
const PACKAGING_OVERHEAD_OZ: Record<string, number> = {
  tiny:   2,
  small:  3,
  medium: 5,
  large:  8,
  xlarge: 12,
};

function overheadForNetOz(netOz: number): number {
  if (netOz < 2)  return PACKAGING_OVERHEAD_OZ.tiny;
  if (netOz < 8)  return PACKAGING_OVERHEAD_OZ.small;
  if (netOz < 24) return PACKAGING_OVERHEAD_OZ.medium;
  if (netOz < 64) return PACKAGING_OVERHEAD_OZ.large;
  return PACKAGING_OVERHEAD_OZ.xlarge;
}

// ─── Category-based defaults when weight is unknown ───────────────────────────
// Gross shipping weight (net + packaging).
const CATEGORY_SHIPPING_WEIGHT_OZ: Record<string, number> = {
  jewelry:     3,    // ring, bracelet, necklace
  cosmetics:   6,    // small makeup compact/tube
  skincare:    8,    // serum bottle
  fragrance:   10,   // perfume/cologne in box
  supplements: 10,   // typical vitamin bottle
  vitamins:    10,
  haircare:    14,   // shampoo/conditioner bottle
  shoes:       32,   // average shoe box (2 lbs)
  clothing:    12,   // folded shirt in poly bag
  bags:        24,   // handbag
  accessories: 6,    // small accessory
  electronics: 18,   // typical small electronics
  phones:      12,
  audio:       20,
  books:       14,   // average trade paperback
  dvds:        6,    // standard DVD case
  games:       8,
  home:        24,
  kitchen:     28,
  default:     12,   // safe fallback
};

/**
 * Convert a net weight measurement to ounces.
 * Returns null for count-based units (capsules, tablets, etc.)
 * so the caller can fall back to count-based estimation.
 */
function netWeightToOz(value: number, unit: string): number | null {
  const u = unit.toLowerCase().trim();

  if (['oz', 'fl oz', 'fl. oz', 'ounce', 'ounces', 'fluid ounce', 'fluid ounces'].some(k => u.includes(k))) {
    return value;
  }
  if (['g', 'gram', 'grams'].some(k => u === k || u.startsWith(k + ' '))) {
    return value * 0.03527; // grams to oz
  }
  if (['ml', 'milliliter', 'milliliters', 'millilit'].some(k => u.startsWith(k))) {
    return value * 0.03381; // water-density approximation
  }
  if (['l', 'liter', 'liters', 'litre', 'litres'].some(k => u === k)) {
    return value * 33.814;
  }
  if (['kg', 'kilogram', 'kilograms'].some(k => u.startsWith(k))) {
    return value * 35.274;
  }
  if (['lb', 'lbs', 'pound', 'pounds'].some(k => u.startsWith(k))) {
    return value * 16;
  }

  // Count units — return null; handled separately
  return null;
}

/**
 * Estimate shipping weight in ounces for a product.
 *
 * @param netWeight - Product net weight from vision classification (label text)
 * @param category  - Product category keyword for fallback (optional)
 * @returns Estimated gross shipping weight in ounces (net + packaging)
 */
export function estimateShippingWeightOz(
  netWeight: NetWeight | null | undefined,
  category?: string,
): number {
  if (!netWeight) {
    return categoryDefaultOz(category);
  }

  const { value, unit } = netWeight;
  const u = unit.toLowerCase().trim();

  // ── Physical weight units (oz, g, ml, lb, kg) ─────────────────────────────
  const netOz = netWeightToOz(value, unit);
  if (netOz !== null) {
    const shippingOz = netOz + overheadForNetOz(netOz);
    return shippingOz;
  }

  // ── Count units: estimate weight from count + unit type ───────────────────
  let estimatedNetOz: number;

  if (['capsule', 'cap', 'softgel', 'vcap', 'vegcap', 'tablet', 'tab'].some(k => u.includes(k))) {
    // Typical capsule/tablet: ~500 mg average → ~0.018 oz each
    estimatedNetOz = value * 0.018;
  } else if (['gummy', 'gummies', 'gummie'].some(k => u.includes(k))) {
    // Typical gummy: ~3 g → ~0.1 oz each
    estimatedNetOz = value * 0.1;
  } else if (['stick', 'packet', 'sachet', 'serving', 'pouch'].some(k => u.includes(k))) {
    // Typical stick/packet: ~10 g → ~0.38 oz each
    estimatedNetOz = value * 0.38;
  } else {
    // Unknown count unit or generic piece count — use category default
    return categoryDefaultOz(category);
  }

  const shippingOz = estimatedNetOz + overheadForNetOz(estimatedNetOz);
  return shippingOz;
}

function categoryDefaultOz(category: string | undefined): number {
  if (!category) return CATEGORY_SHIPPING_WEIGHT_OZ.default;
  const cat = category.toLowerCase();
  for (const [key, oz] of Object.entries(CATEGORY_SHIPPING_WEIGHT_OZ)) {
    if (cat.includes(key)) return oz;
  }
  return CATEGORY_SHIPPING_WEIGHT_OZ.default;
}
