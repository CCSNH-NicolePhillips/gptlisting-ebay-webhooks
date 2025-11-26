# Root Brands JSON-LD Analysis

## Found JSON-LD Scripts

The Root Zero-In product page contains **2 JSON-LD scripts**:

### Script 1: Yoast SEO (WebPage schema)
- Contains: WebPage, ImageObject, BreadcrumbList, WebSite, Organization
- **Does NOT contain Product or price information**

### Script 2: Product Schema ⭐
```json
{
  "@context": "https://schema.org/",
  "@graph": [
    {
      "@context": "https://schema.org/",
      "@type": "BreadcrumbList",
      "itemListElement": [...]
    },
    {
      "@context": "https://schema.org/",
      "@type": "Product",
      "@id": "https://therootbrands.com/product/zero-in/#product",
      "name": "ZERO-IN",
      "url": "https://therootbrands.com/product/zero-in/",
      "description": "",
      "image": "https://therootbrands.com/wp-content/uploads/2021/06/zero-in-en-1.png",
      "sku": "RW003",
      "offers": [
        {
          "@type": "Offer",
          "priceSpecification": [
            {
              "@type": "UnitPriceSpecification",
              "price": "84.00",  ← HERE IS THE PRICE!
              "priceCurrency": "USD",
              "valueAddedTaxIncluded": false,
              "validThrough": "2026-12-31"
            }
          ],
          "priceValidUntil": "2026-12-31",
          "availability": "http://schema.org/InStock",
          "url": "https://therootbrands.com/product/zero-in/",
          "seller": {
            "@type": "Organization",
            "name": "The ROOT Brands",
            "url": "https://therootbrands.com"
          }
        }
      ]
    }
  ]
}
```

## THE PROBLEM IDENTIFIED! 🎯

Our parser looks for:
```typescript
const priceFromOffer =
  toNumber((offer as any).price) ??                        // ❌ NOT HERE
  toNumber((offer as any).priceSpecification?.price) ??   // ❌ NOT HERE EITHER
  toNumber((offer as any).lowPrice);                      // ❌ NOT HERE
```

But Root Brands stores price as:
```
offer.priceSpecification[0].price  // Array, not object!
```

## The Fix

Change from:
```typescript
toNumber((offer as any).priceSpecification?.price)
```

To:
```typescript
// priceSpecification can be an array OR an object
const priceSpec = (offer as any).priceSpecification;
const priceFromSpec = Array.isArray(priceSpec)
  ? toNumber(priceSpec[0]?.price)
  : toNumber(priceSpec?.price);
```

## Why $15 is being extracted

Since JSON-LD fails, parser falls back to `extractFromBody()` regex.

Looking at the page text, somewhere in the HTML there's a $15 reference (likely shipping, related product, or promotional text).

Once we fix the JSON-LD parser to handle `priceSpecification` arrays, it should extract **$84.00** correctly.
