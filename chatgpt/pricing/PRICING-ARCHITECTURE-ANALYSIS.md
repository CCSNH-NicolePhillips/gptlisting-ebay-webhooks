# Pricing Architecture Analysis

> Generated: January 1, 2026

## 🏗️ Pricing Architecture Overview

The pricing system flows through these stages:

| Stage | Component | Data Flow |
|-------|-----------|-----------|
| **1. Vision/Identity** | `src/smartdrafts/pairing-v2-core.ts` | GPT-4o-mini extracts `brand`, `productName`, `netWeight`, `keyText`, `brandWebsite` |
| **2. Price Lookup** | `src/lib/price-lookup.ts` (line 897) | Tiered: eBay Sold → Amazon → RapidAPI → Brand MSRP |
| **3. Validation** | `src/lib/price-lookup.ts` (line 388) | `brandsMatch()`, `isAmazonSizeMismatch()`, `isAmazonBundlePage()` |
| **4. HTML Parsing** | `src/lib/html-price.ts` | `extractPriceWithShipping()`, `detectUnitsSoldFromTitle()` |
| **5. AI Arbitration** | `src/lib/price-lookup.ts` (line 694) | GPT-4o-mini selects best candidate |

---

## 🎯 Option 1: Input & Context Accuracy

**Current Gap:** The Vision API extracts `netWeight` and `keyText`, but these hints aren't always used effectively when searching Amazon.

### Key Areas to Investigate

1. **Search Query Construction** (`price-lookup.ts` lines 996-1040):
   - Size/weight is appended to search query, but only if `input.keyText` contains category hints
   - `netWeight` is only used in the **retry** path after initial rejection

2. **Brand Website URL Quality** - The Vision prompt asks GPT to construct URLs like:
   ```
   "https://brandname.com/product-name.html"
   ```
   But many brand sites use `/products/`, `/shop/`, or Shopify patterns that differ.

### Questions to Explore

- Is the `netWeight` extraction consistent? (e.g., "60 capsules" vs "60 tablets" vs actual weight)
- Are `keyText` hints like "hair", "skin", "supplement" being passed to search?
- Could we validate `brandWebsite` URLs before trusting them for MSRP?

---

## 📦 Option 2: Scraper Reliability & Buy Box Logic

**Current Implementation:** `html-price.ts` uses Cheerio to parse static HTML, but Amazon is heavily JavaScript-dependent.

### Key Vulnerabilities

1. **Static HTML Fetching** - `fetchHtml()` doesn't execute JS, so dynamic pricing may not render
2. **Buy Box Logic** - `extractPriceWithShipping()` looks for price elements, but doesn't distinguish:
   - Amazon's price vs 3rd party seller
   - "New" vs "Used" vs "Subscribe & Save"
3. **Variant Selection** - Amazon often lands on a default variant (wrong size)

### Current Safeguards

| Function | Location | Purpose |
|----------|----------|---------|
| `isAmazonSizeMismatch()` | `price-lookup.ts` lines 388-485 | Compares extracted sizes |
| `isAmazonBundlePage()` | `price-lookup.ts` lines 293-386 | Detects "48 Pack" type pages |
| `detectUnitsSoldFromTitle()` | `html-price.ts` line 165 | Parses pack counts from titles |

### Questions to Explore

- Should we use a headless browser (Puppeteer/Playwright) for Amazon?
- Can we use Amazon Product API (PA-API) instead of scraping?
- How do we ensure we're getting the **New** price from the **primary seller**?

---

## ⚖️ Option 3: Cross-API Arbitration

**Current Flow:** The `decideFinalPrice()` function (`price-lookup.ts` lines 653-850) uses GPT-4o-mini with these rules:

```
1. ALWAYS prefer Amazon price when available
2. Only use brand MSRP if NO Amazon price
3. Only use eBay sold if NO brand MSRP and NO Amazon
```

### Pre-Arbitration Filters

| Filter | Threshold | Purpose |
|--------|-----------|---------|
| `isProbablyBundlePrice()` | >1.8x ratio | Drops brand prices much higher than marketplace |
| Marketplace floor | $8 minimum | Catches suspiciously low Amazon prices |
| Final price floor | $5 minimum | Sanity check on recommended listing price |

### RapidAPI Fallback

`rapidapi-product-search.ts` - Used when Amazon returns nothing, aggregates Google Shopping data.

### Questions to Explore

- The 1.8x bundle detection ratio - is it too aggressive or too lenient?
- How do we handle when Amazon shows a **different product size** than what we're selling?
- Should the arbitration weight eBay sold data more heavily for used items?

---

## 🔍 Recommended Starting Point

Based on the code analysis, **Option 2: Scraper Reliability** is recommended because:

1. The `extractPriceWithShipping()` function is the **single point of truth** for Amazon pricing
2. If it returns wrong data, all downstream arbitration is compromised
3. The retry logic for size-focused searches suggests this is already a known pain point

---

## 📁 Key Files Reference

### Core Pricing Logic
- `src/lib/price-lookup.ts` - Main entry point (`lookupPrice()`)
- `src/lib/html-price.ts` - Amazon/brand site HTML parsing
- `src/lib/pricing-compute.ts` - Final price calculation
- `src/lib/pricing-config.ts` - User pricing settings

### Data Sources
- `src/lib/pricing/ebay-sold-prices.ts` - eBay completed listings API
- `src/lib/rapidapi-product-search.ts` - Google Shopping aggregation
- `src/lib/search.ts` - Brave search for Amazon URLs
- `src/lib/brand-registry.ts` - Known ASIN mappings

### Vision/Identity
- `src/smartdrafts/pairing-v2-core.ts` - Image classification prompt
- `src/lib/brand-map.ts` - Brand URL cache

---

## 🔧 Next Steps

1. **Audit the Amazon HTML parser** - Check if it's correctly handling variant pages and Buy Box logic
2. **Test specific product examples** - Run the pricing pipeline on real products to identify failure patterns
3. **Explore PA-API integration** - See if Amazon's official API can replace scraping (credentials already in `.env`)
