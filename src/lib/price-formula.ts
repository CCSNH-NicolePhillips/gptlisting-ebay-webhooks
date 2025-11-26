export type PricingResult = {
  base: number;
  ebay: number;
  auto: {
    reduceBy: number;
    everyDays: number;
    minPrice: number;
  };
};

/**
 * Apply 10% discount to market average with $0.99 minimum.
 * TODO: Make discount percentage user-configurable.
 */
export function applyPricingFormula(avg: number | null | undefined): PricingResult | null {
  if (!avg || avg <= 0) {
    return null;
  }

  // Step 1 — Apply 10% discount
  let ebay = avg * 0.9;

  // Step 2 — Enforce minimum price of $0.99
  if (ebay < 0.99) {
    ebay = 0.99;
  }

  // Step 3 — Round to 2 decimal places
  ebay = +ebay.toFixed(2);

  // Step 4 — Auto-reduction metadata
  const auto = {
    reduceBy: 1,
    everyDays: 3,
    minPrice: +(ebay * 0.8).toFixed(2),
  };

  return {
    base: +avg.toFixed(2),
    ebay,
    auto,
  };
}
