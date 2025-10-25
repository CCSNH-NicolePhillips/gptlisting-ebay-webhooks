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
 * Apply markdown and auto-reduction logic to a market average.
 */
export function applyPricingFormula(avg: number | null | undefined): PricingResult | null {
  if (!avg || avg <= 0) {
    return null;
  }

  // Step 1 — Base markdown
  let ebay = avg > 30 ? avg - 5 : avg * 0.9;

  // Step 2 — Round to .45 or .95 for clean display
  const cents = ebay % 1;
  ebay = cents < 0.5 ? Math.floor(ebay) + 0.45 : Math.floor(ebay) + 0.95;

  // Step 3 — Auto-reduction metadata
  const auto = {
    reduceBy: 1,
    everyDays: 3,
    minPrice: +(ebay * 0.8).toFixed(2),
  };

  return {
    base: +avg.toFixed(2),
    ebay: +ebay.toFixed(2),
    auto,
  };
}
