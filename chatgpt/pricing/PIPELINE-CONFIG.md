# Pricing Config - Actual Pipeline Usage

> Extracted from `smartdrafts-create-drafts-background.ts` on January 6, 2026

This shows the **actual** pricing config objects passed through the pipeline.

---

## 1. PricingSettings (User Settings Model)

This is loaded from user settings blob storage and passed to `createDraftForProduct()`:

```typescript
// From pricing-config.ts
interface PricingSettings {
  discountPercent: number;                    // Default: 10 (10% off Amazon)
  shippingStrategy: ShippingStrategy;         // Default: 'ALGO_COMPETITIVE_TOTAL'
  templateShippingEstimateCents: number;      // Default: 600 ($6.00)
  shippingSubsidyCapCents: number | null;     // Default: null (no cap)
  minItemPriceCents: number;                  // Default: 199 ($1.99)
  ebayShippingMode: EbayShippingMode;         // Default: 'BUYER_PAYS_SHIPPING'
  buyerShippingChargeCents: number;           // Default: 600 ($6.00)
  allowAutoFreeShippingOnLowPrice: boolean;   // Default: true
}

// Defaults
function getDefaultPricingSettings(): PricingSettings {
  return {
    discountPercent: 10,
    shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
    templateShippingEstimateCents: 600,
    shippingSubsidyCapCents: null,
    minItemPriceCents: 199,
    ebayShippingMode: 'BUYER_PAYS_SHIPPING',
    buyerShippingChargeCents: 600,
    allowAutoFreeShippingOnLowPrice: true,
  };
}
```

### How It's Loaded in Pipeline

```typescript
// Line 1467-1490 in smartdrafts-create-drafts-background.ts
let pricingSettings: PricingSettings = getDefaultPricingSettings();

if (userId) {
  const store = tokensStore();
  const settingsKey = `users/${encodeURIComponent(userId)}/settings.json`;
  const settingsBlob = await store.get(settingsKey);
  
  if (settingsBlob) {
    const settingsData = JSON.parse(settingsBlob);
    if (settingsData.pricing) {
      pricingSettings = {
        ...getDefaultPricingSettings(),
        ...settingsData.pricing,  // User overrides
      };
    }
  }
}

// ALSO: Check fulfillment policy for free shipping override
if (policyDefaults?.fulfillment) {
  const policy = await fetchPolicy(fulfillmentPolicyId);
  if (hasFreeShipping(policy)) {
    pricingSettings.templateShippingEstimateCents = 0;  // Override!
  }
}
```

---

## 2. DeliveredPricingSettings (Engine Config)

This is constructed FROM PricingSettings and passed to `getDeliveredPricing()`:

```typescript
// Line 943-950 in smartdrafts-create-drafts-background.ts
const deliveredSettings: Partial<DeliveredPricingSettings> = {
  mode: 'market-match',                                           // HARDCODED
  shippingEstimateCents: pricingSettings.templateShippingEstimateCents || 600,
  minItemCents: 499,                                              // HARDCODED $4.99
  lowPriceMode: 'FLAG_ONLY',                                      // HARDCODED
  useSmartShipping: true,                                         // HARDCODED
};

deliveredDecision = await getDeliveredPricing(
  product.brand || '',
  priceLookupTitle,
  deliveredSettings
);
```

### Full DeliveredPricingSettings Interface

```typescript
type PricingMode = 'market-match' | 'fast-sale' | 'max-margin';
type LowPriceMode = 'FLAG_ONLY' | 'AUTO_SKIP' | 'ALLOW_ANYWAY';

interface DeliveredPricingSettings {
  mode: PricingMode;                          // Default: 'market-match'
  shippingEstimateCents: number;              // Default: 600
  minItemCents: number;                       // Default: 499
  undercutCents: number;                      // Default: 100 (for fast-sale)
  allowFreeShippingWhenNeeded: boolean;       // Default: true
  freeShippingMaxSubsidyCents: number;        // Default: 500
  lowPriceMode: LowPriceMode;                 // Default: 'FLAG_ONLY'
  useSmartShipping: boolean;                  // Default: true
  shippingSettings?: ShippingSettings;        // Optional
}

const DEFAULT_PRICING_SETTINGS: DeliveredPricingSettings = {
  mode: 'market-match',
  shippingEstimateCents: 600,
  minItemCents: 499,
  undercutCents: 100,
  allowFreeShippingWhenNeeded: true,
  freeShippingMaxSubsidyCents: 500,
  lowPriceMode: 'FLAG_ONLY',
  useSmartShipping: true,
};
```

---

## 3. Data Flow Summary

```
┌─────────────────────────────────────────────────────────────────┐
│                    PIPELINE DATA FLOW                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. LOAD USER SETTINGS                                          │
│     └── Blob: users/{userId}/settings.json                      │
│     └── Field: settingsData.pricing → PricingSettings           │
│                                                                  │
│  2. OVERRIDE FROM FULFILLMENT POLICY                            │
│     └── If hasFreeShipping(policy) → templateShippingCents = 0  │
│     └── Else extractShippingCost(policy) → templateShippingCents│
│                                                                  │
│  3. BUILD DeliveredPricingSettings                              │
│     └── mode: 'market-match' (hardcoded)                        │
│     └── shippingEstimateCents: from PricingSettings             │
│     └── minItemCents: 499 (hardcoded)                           │
│     └── lowPriceMode: 'FLAG_ONLY' (hardcoded)                   │
│                                                                  │
│  4. CALL getDeliveredPricing()                                  │
│     └── Fetches Google Shopping comps                           │
│     └── Returns DeliveredPricingDecision                        │
│                                                                  │
│  5. CONVERT TO PriceDecision                                    │
│     └── finalItemCents / 100 = listing price                    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. Key Points

| Field | Source | Overridable? |
|-------|--------|--------------|
| `discountPercent` | User settings | ✅ Yes |
| `shippingStrategy` | User settings | ✅ Yes |
| `templateShippingEstimateCents` | User settings OR fulfillment policy | ✅ Yes |
| `minItemPriceCents` | User settings | ✅ Yes (but minItemCents in engine is hardcoded 499) |
| `ebayShippingMode` | User settings | ✅ Yes |
| `mode` (market-match/fast-sale) | Hardcoded | ❌ No |
| `lowPriceMode` | Hardcoded to FLAG_ONLY | ❌ No |
| `useSmartShipping` | Hardcoded to true | ❌ No |

---

## 5. User Settings Storage Format

The user settings blob looks like this:

```json
{
  "pricing": {
    "discountPercent": 10,
    "shippingStrategy": "ALGO_COMPETITIVE_TOTAL",
    "templateShippingEstimateCents": 600,
    "shippingSubsidyCapCents": null,
    "minItemPriceCents": 199,
    "ebayShippingMode": "BUYER_PAYS_SHIPPING",
    "buyerShippingChargeCents": 600,
    "allowAutoFreeShippingOnLowPrice": true
  }
}
```

Stored at: `users/{encodeURIComponent(userId)}/settings.json` in Netlify Blobs
