import { computeEbayItemPriceCents } from '../dist/src/lib/pricing-compute.js';
import { getDefaultPricingSettings } from '../dist/src/lib/pricing-config.js';

const settings = getDefaultPricingSettings();
const base = { amazonItemPriceCents: 5700, amazonShippingCents: 0 };

const result = computeEbayItemPriceCents({
  amazonItemPriceCents: 5700,
  amazonShippingCents: 0,
  settings,
});

console.log('PRICING_EVIDENCE', {
  amazonItemPriceCents: 5700,
  amazonShippingCents: 0,
  settings,
  ...result,
});

console.log('\n=== DISCOUNT_ITEM_ONLY ===');
console.log(
  computeEbayItemPriceCents({
    ...base,
    settings: { ...settings, shippingStrategy: 'DISCOUNT_ITEM_ONLY' },
  })
);

console.log('\n=== AMAZON SHIPPING 5.99 (ALGO) ===');
console.log(
  computeEbayItemPriceCents({
    amazonItemPriceCents: 5700,
    amazonShippingCents: 599,
    settings,
  })
);
