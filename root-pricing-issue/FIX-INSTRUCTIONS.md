## CHATGPT INSTRUCTIONS

### Problem
Root Brands products extracting $15 instead of $84. HTML parser failing to read JSON-LD price.

### Root Cause
Root Brands uses `priceSpecification` as an **ARRAY**:
```json
"offers": [{
  "@type": "Offer",
  "priceSpecification": [  ← ARRAY, not object
    {
      "@type": "UnitPriceSpecification",
      "price": "84.00"
    }
  ]
}]
```

Current parser expects `priceSpecification` to be an **OBJECT**:
```typescript
toNumber((offer as any).priceSpecification?.price)  // undefined
```

### Fix Required
In `html-price.ts`, function `extractFromJsonLd()`, around line 54:

**BEFORE:**
```typescript
const priceFromOffer =
  toNumber((offer as any).price) ??
  toNumber((offer as any).priceSpecification?.price) ??  // Fails on arrays
  toNumber((offer as any).lowPrice);
```

**AFTER:**
```typescript
// Handle priceSpecification as array OR object
const priceSpec = (offer as any).priceSpecification;
const priceFromSpec = Array.isArray(priceSpec)
  ? toNumber(priceSpec[0]?.price)  // Array: take first element
  : toNumber(priceSpec?.price);    // Object: direct access

const priceFromOffer =
  toNumber((offer as any).price) ??
  priceFromSpec ??
  toNumber((offer as any).lowPrice);
```

### Files to Edit
- `c:\Users\hanri\OneDrive\Documents\GitHub\gptlisting-ebay-webhooks\src\lib\html-price.ts`

### Test
After fix, Root Zero-In should extract:
- JSON-LD price: **$84.00** ✅
- Final listing price: **~$71.40** (with 15% discount)

Instead of current:
- Fallback body price: **$15.00** ❌
- Final listing price: **$12.75** ❌
