# SmartDrafts Pipeline: Complete Data Flow Documentation

**Generated**: January 1, 2026  
**Scope**: Image upload → Vision classification → Product pairing → Draft creation → Pricing

---

## Table of Contents
1. [High-Level Architecture](#high-level-architecture)
2. [Pipeline Overview (ASCII Flow)](#pipeline-overview-ascii-flow)
3. [Stage 1: Image Scan Pipeline](#stage-1-image-scan-pipeline)
4. [Stage 2: Draft Creation Pipeline](#stage-2-draft-creation-pipeline)
5. [Stage 3: Pricing Pipeline (DETAILED)](#stage-3-pricing-pipeline-detailed)
6. [Caching Strategy](#caching-strategy)
7. [External API Dependencies](#external-api-dependencies)
8. [Key File Reference](#key-file-reference)

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          SMARTDRAFTS PIPELINE                                │
│                                                                              │
│   ┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌──────────┐  │
│   │   STAGE 1   │────▶│   STAGE 2   │────▶│   STAGE 3   │────▶│  OUTPUT  │  │
│   │  Image Scan │     │   Pairing   │     │ Draft Create│     │   eBay   │  │
│   │   + Vision  │     │ (in scan)   │     │ + Pricing   │     │  Drafts  │  │
│   └─────────────┘     └─────────────┘     └─────────────┘     └──────────┘  │
│                                                                              │
│   External APIs: OpenAI Vision, Brave Search, SearchAPI, RapidAPI, Amazon   │
│   Storage: Upstash Redis (jobs), Netlify Blobs (tokens/cache)               │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Pipeline Overview (ASCII Flow)

```
USER REQUEST                           BACKGROUND WORKER                    OUTPUT
     │                                        │                                │
     ▼                                        ▼                                ▼
┌─────────────────┐                  ┌─────────────────┐               ┌──────────────┐
│ smartdrafts-    │  POST /scan      │ smartdrafts-    │  Async        │ Job Status   │
│ scan-bg.ts      │─────────────────▶│ scan-background │──────────────▶│ in Redis     │
│ (initiator)     │  jobId           │ .ts (worker)    │  groups[]     │              │
└─────────────────┘                  └─────────────────┘               └──────────────┘
                                            │
                                            ▼
                                     ┌─────────────────┐
                                     │ runSmartDraft   │
                                     │ Scan()          │
                                     │ (scan-core.ts)  │
                                     └─────────────────┘
                                            │
                           ┌────────────────┼────────────────┐
                           ▼                ▼                ▼
                    ┌──────────┐     ┌──────────┐     ┌──────────┐
                    │ Dropbox  │     │ Vision   │     │ Pairing  │
                    │ / Staged │     │ Analysis │     │ Logic    │
                    │ URLs     │     │ (GPT-4o) │     │          │
                    └──────────┘     └──────────┘     └──────────┘
                                            │
                                            ▼
                                      Product Groups
                                      (front/back pairs)


┌─────────────────┐                  ┌─────────────────┐               ┌──────────────┐
│ smartdrafts-    │  POST /drafts    │ smartdrafts-    │  Async        │ Drafts in    │
│ create-drafts-  │─────────────────▶│ create-drafts-  │──────────────▶│ Redis        │
│ bg.ts (init)    │  products[]      │ background.ts   │  drafts[]     │              │
└─────────────────┘                  └─────────────────┘               └──────────────┘
                                            │
                           ┌────────────────┼────────────────┐
                           ▼                ▼                ▼
                    ┌──────────┐     ┌──────────┐     ┌──────────┐
                    │ Category │     │ GPT-4o   │     │ PRICING  │◀─── This is the
                    │ Selection│     │ Listing  │     │ ENGINE   │     focus!
                    └──────────┘     └──────────┘     └──────────┘
```

---

## Stage 1: Image Scan Pipeline

### Entry Point: `netlify/functions/smartdrafts-scan-bg.ts`

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ POST /smartdrafts-scan-bg                                                   │
│                                                                              │
│ Input: { path: "/Dropbox/folder" } OR { stagedUrls: ["https://..."] }       │
│                                                                              │
│ Flow:                                                                        │
│   1. requireUserAuth() ─────────────▶ Validate JWT token                    │
│   2. canStartJob(userId) ────────────▶ Check Redis quota (max concurrent)   │
│   3. incRunning(userId) ─────────────▶ Reserve slot                         │
│   4. putJob(jobId, {...}) ───────────▶ Create job in Redis (state: pending) │
│   5. fetch(background-worker) ───────▶ Fire & forget to worker              │
│   6. Return { ok: true, jobId }                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Background Worker: `netlify/functions/smartdrafts-scan-background.ts`

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ POST /smartdrafts-scan-background (10-minute timeout)                       │
│                                                                              │
│ Input: { jobId, userId, folder, stagedUrls, force, limit, debug }           │
│                                                                              │
│ Flow:                                                                        │
│   1. writeJob(state: "running")                                              │
│   2. runSmartDraftScan({userId, folder, stagedUrls, ...})                   │
│      └───▶ src/lib/smartdrafts-scan-core.ts                                 │
│            │                                                                 │
│            ├── Check cache (SmartDraftGroupCache in Redis)                  │
│            ├── List files from Dropbox OR use stagedUrls                    │
│            ├── Send to Vision API (GPT-4o-mini, batches of 12)              │
│            │   └── Extract: brand, productName, role, categoryPath,         │
│            │       keyText, brandWebsite, netWeight, packageType            │
│            ├── Pair images (front+back matching)                            │
│            │   └── Two-pass: strict text → aggressive visual                │
│            └── Return: { groups, orphans, imageInsights }                   │
│                                                                              │
│   3. writeJob(state: "complete", groups, orphans, ...)                      │
│   4. Store analysis in Redis:                                                │
│      └── analysis:${jobId}                                                  │
│      └── analysis:byFolder:${folderSig}                                     │
│      └── analysis:lastJobId:${folderSig}                                    │
│   5. decRunning(userId) ─────────────▶ Release quota slot                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Vision API Data Extraction (per image)

```typescript
// GPT-4o-mini extracts from each image:
{
  role: "front" | "back" | "side",
  brand: "Natural Stacks",
  productName: "Dopamine Brain Food",
  title?: "Book Title",              // For books only
  categoryPath: "Dietary Supplement",
  brandWebsite: "https://naturalstacks.com/products/dopamine",
  keyText: ["60 Capsules", "L-Tyrosine", "Non-GMO"],
  netWeight: { value: 60, unit: "capsules" },
  packageType: "bottle",
  colorSignature: "#ff5733",
  layoutSignature: "vertical-center"
}
```

---

## Stage 2: Draft Creation Pipeline

### Entry Point: `netlify/functions/smartdrafts-create-drafts-bg.ts`

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ POST /smartdrafts-create-drafts-bg                                          │
│                                                                              │
│ Input: { products: [...], promotion: { enabled, rate } }                    │
│                                                                              │
│ Flow:                                                                        │
│   1. requireUserAuth() ─────────────▶ Validate JWT token                    │
│   2. putJob(jobId, state: "pending")                                        │
│   3. fetch(background-worker) with products[]                               │
│   4. Return { ok: true, jobId }                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Background Worker: `netlify/functions/smartdrafts-create-drafts-background.ts`

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ POST /smartdrafts-create-drafts-background                                  │
│                                                                              │
│ For EACH product in products[]:                                              │
│                                                                              │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ createDraftForProduct(product, promotion, pricingSettings)          │   │
│   │                                                                     │   │
│   │   1. PRICING (see detailed section below)                           │   │
│   │      └── lookupPrice(PriceLookupInput)                              │   │
│   │          └── Returns: { recommendedListingPrice, chosen, ... }      │   │
│   │                                                                     │   │
│   │   2. CATEGORY SELECTION                                             │   │
│   │      └── getRelevantCategories(product)                             │   │
│   │          └── Match product type to eBay taxonomy                    │   │
│   │      └── fetchCategoryAspects(categoryId)                           │   │
│   │          └── Get required/optional aspects from eBay API            │   │
│   │                                                                     │   │
│   │   3. GPT LISTING GENERATION                                         │   │
│   │      └── buildPrompt(product, category, aspects, prices)            │   │
│   │      └── callOpenAI(prompt) ─────▶ GPT-4o (30s timeout, 2 retries)  │   │
│   │      └── parseGptResponse() ─────▶ { title, description, bullets,   │   │
│   │                                      aspects, price, condition }    │   │
│   │                                                                     │   │
│   │   4. POST-PROCESSING                                                │   │
│   │      └── normalizeAspects() ─────▶ Ensure Brand is set              │   │
│   │      └── calculateShippingWeight() ─▶ netWeight + container buffer  │   │
│   │                                                                     │   │
│   │   5. BUILD DRAFT OBJECT                                             │   │
│   │      └── { productId, brand, title, description, price,             │   │
│   │           aspects, images, pricingStatus, priceMeta, ... }          │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│ writeJob(state: "complete", drafts: [...])                                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Stage 3: Pricing Pipeline (DETAILED)

### Main Entry Point: `src/lib/price-lookup.ts`

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        lookupPrice(PriceLookupInput)                        │
│                                                                              │
│ Input:                                                                       │
│   {                                                                          │
│     title: "Dopamine Brain Food 60 Capsules",                               │
│     brand: "Natural Stacks",                                                │
│     brandWebsite?: "https://naturalstacks.com/products/...",                │
│     keyText?: ["60 Capsules", "L-Tyrosine"],                                │
│     categoryPath?: "Dietary Supplement",                                    │
│     photoQuantity?: 1,          // Bottles visible in photo                 │
│     packCount?: null,           // Pack size (e.g., 24 for 24-pack)         │
│     netWeight?: { value: 60, unit: "capsules" },                            │
│     pricingSettings?: PricingSettings,                                      │
│     skipCache?: false                                                       │
│   }                                                                          │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CACHE CHECK                                     │
│                                                                              │
│ cacheKey = makePriceSig(brand, title)                                       │
│ cached = await getCachedPrice(cacheKey)                                     │
│                                                                              │
│ if (cached?.msrpCents >= $5.00):                                            │
│   └── Apply current user settings to cached MSRP                            │
│   └── computeEbayItemPrice({ msrpCents, settings }) ─▶ Return early         │
│                                                                              │
│ else: Continue to tiered lookup                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Tier Order (Priority: High → Low)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         TIERED PRICING ENGINE                                │
│                                                                              │
│  ╔════════════════════════════════════════════════════════════════════════╗ │
│  ║  TIER 1: eBay Sold Prices (via SearchAPI.io)                           ║ │
│  ║                                                                        ║ │
│  ║  └── fetchSoldPriceStats() ─▶ src/lib/pricing/ebay-sold-prices.ts     ║ │
│  ║      │                                                                 ║ │
│  ║      ├── Query: "brand + title" → SearchAPI.io (eBay scraping)        ║ │
│  ║      ├── Filter: Sold/completed items only (LH_Sold:1)                ║ │
│  ║      ├── Parse: Extract prices from organic_results                   ║ │
│  ║      └── Stats: p10, p35 (used), median, p90                          ║ │
│  ║                                                                        ║ │
│  ║  Source: 'ebay-sold' │ Price: p35 percentile                          ║ │
│  ║  Why p35? Conservative below-median for competitive pricing           ║ │
│  ╚════════════════════════════════════════════════════════════════════════╝ │
│                                     │                                        │
│                                     ▼                                        │
│  ╔════════════════════════════════════════════════════════════════════════╗ │
│  ║  TIER 2: Amazon Marketplace (THE GOLD STANDARD)                        ║ │
│  ║                                                                        ║ │
│  ║  Step 1: Find Amazon URL                                               ║ │
│  ║  └── Check brand registry: getAmazonAsin(brand, title)                ║ │
│  ║  └── OR: Brave Search: "brand title site:amazon.com"                  ║ │
│  ║      └── src/lib/search.ts → braveFirstUrl()                          ║ │
│  ║                                                                        ║ │
│  ║  Step 2: Fetch & Parse HTML                                            ║ │
│  ║  └── fetchHtml(amazonUrl)                                             ║ │
│  ║  └── extractPriceWithShipping(html) ─▶ src/lib/html-price.ts         ║ │
│  ║      │                                                                 ║ │
│  ║      ├── Parse JSON-LD (Product schema)                               ║ │
│  ║      ├── Parse meta tags (og:price:amount)                            ║ │
│  ║      ├── Parse DOM ($price, .a-price-whole)                           ║ │
│  ║      ├── Detect shipping: FREE Shipping vs paid                       ║ │
│  ║      └── Detect pack quantity: "2-pack" → divide price                ║ │
│  ║                                                                        ║ │
│  ║  Step 3: VALIDATION (Critical!)                                        ║ │
│  ║  ├── brandsMatch(input.brand, pageTitle) ─▶ Reject if mismatch        ║ │
│  ║  ├── isAmazonBundlePage(pageTitle) ─▶ Reject "48 Pack" pages          ║ │
│  ║  ├── isAmazonSizeMismatch(pageTitle) ─▶ Reject wrong size             ║ │
│  ║  └── amazonMatchesProductTerms() ─▶ Check "50 Billion" vs "5 Billion" ║ │
│  ║                                                                        ║ │
│  ║  Source: 'amazon' │ Confidence: high/medium/low                       ║ │
│  ║  ⚠️ Amazon price = NO DISCOUNT APPLIED (it IS the market price)       ║ │
│  ╚════════════════════════════════════════════════════════════════════════╝ │
│                                     │                                        │
│                                     ▼                                        │
│  ╔════════════════════════════════════════════════════════════════════════╗ │
│  ║  TIER 2.5: RapidAPI Product Search (Fallback for Amazon)              ║ │
│  ║                                                                        ║ │
│  ║  └── searchProductPrice() ─▶ src/lib/rapidapi-product-search.ts      ║ │
│  ║      │                                                                 ║ │
│  ║      ├── Query: Google Shopping aggregation API                       ║ │
│  ║      ├── Sources: Amazon, Target, Walmart, GNC, CVS, etc.            ║ │
│  ║      ├── Score results by: brand match, source priority, ratings     ║ │
│  ║      └── Return best match with confidence                            ║ │
│  ║                                                                        ║ │
│  ║  Source: 'brave-fallback' (legacy naming)                             ║ │
│  ║  Used when: Amazon search returned nothing                            ║ │
│  ╚════════════════════════════════════════════════════════════════════════╝ │
│                                     │                                        │
│                                     ▼                                        │
│  ╔════════════════════════════════════════════════════════════════════════╗ │
│  ║  TIER 3: Brand MSRP (Official Website)                                 ║ │
│  ║                                                                        ║ │
│  ║  Priority Order:                                                       ║ │
│  ║  1. Vision API brandWebsite (if provided, not homepage)               ║ │
│  ║     └── extractPriceFromBrand(url, brand, title)                      ║ │
│  ║     └── Try URL variations: /product/, /products/, /shop/             ║ │
│  ║                                                                        ║ │
│  ║  2. Brand Map (curated URLs)                                           ║ │
│  ║     └── getBrandUrls(signature) ─▶ src/lib/brand-map.ts              ║ │
│  ║                                                                        ║ │
│  ║  3. Brave Search for Brand Site                                        ║ │
│  ║     └── braveFirstUrlForBrandSite(brand, title)                       ║ │
│  ║     └── Extract price from HTML                                        ║ │
│  ║                                                                        ║ │
│  ║  Source: 'brand-msrp'                                                  ║ │
│  ║  ⚠️ Brand MSRP = DISCOUNT APPLIED (often inflated)                    ║ │
│  ╚════════════════════════════════════════════════════════════════════════╝ │
│                                     │                                        │
│                                     ▼                                        │
│  ╔════════════════════════════════════════════════════════════════════════╗ │
│  ║  TIER 4: Category-Based Estimate (Last Resort)                         ║ │
│  ║                                                                        ║ │
│  ║  if (candidates.length === 0):                                         ║ │
│  ║     └── Skincare: $24.99                                               ║ │
│  ║     └── Supplements: $29.99                                            ║ │
│  ║     └── Sports nutrition: $39.99                                       ║ │
│  ║     └── Fish oil: $24.99                                               ║ │
│  ║     └── Default: $29.99                                                ║ │
│  ║                                                                        ║ │
│  ║  Source: 'estimate'                                                    ║ │
│  ║  Status: NEEDS_REVIEW (requires manual verification)                  ║ │
│  ╚════════════════════════════════════════════════════════════════════════╝ │
└─────────────────────────────────────────────────────────────────────────────┘
```

### AI Arbitration: decideFinalPrice()

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        decideFinalPrice()                                    │
│                        Location: src/lib/price-lookup.ts ~line 670          │
│                                                                              │
│ Input: PriceLookupInput, candidates[], soldStats                            │
│                                                                              │
│ SANITY CHECKS BEFORE AI:                                                    │
│ ├── Remove low-confidence Amazon if Brand MSRP exists                       │
│ └── Filter bundle prices (brand > 1.8x marketplace = suspicious)            │
│                                                                              │
│ GPT-4o-mini Prompt:                                                          │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ PRICING RULES:                                                          │ │
│ │ 1. ALWAYS prefer Amazon price when available (market price)            │ │
│ │ 2. Only use brand MSRP if NO Amazon price                              │ │
│ │ 3. CONFIDENCE IS KING: high > low, even if low is cheaper              │ │
│ │ 4. Only use eBay sold if NO brand MSRP and NO Amazon                   │ │
│ │ 5. Return BASE price - system applies discounts                        │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│ AI Response:                                                                 │
│ { "chosenSource": "amazon", "basePrice": 29.99, "reasoning": "..." }        │
│                                                                              │
│ POST-PROCESSING (after AI decision):                                        │
│ └── Apply computeEbayItemPrice() with user settings                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Price Computation: computeEbayItemPrice()

File: `src/lib/pricing-compute.ts`

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    computeEbayItemPrice(input)                              │
│                                                                              │
│ Input (from pricing-config.ts):                                              │
│   {                                                                          │
│     amazonItemPriceCents: 2999,       // $29.99                             │
│     amazonShippingCents: 0,           // Free shipping                      │
│     discountPercent: 10,              // Default 10%                        │
│     shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',                             │
│     templateShippingEstimateCents: 600,   // $6.00                          │
│     shippingSubsidyCapCents: null,    // No cap                             │
│     minItemPriceCents: 199,           // $1.99 floor                        │
│   }                                                                          │
│                                                                              │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ STRATEGY: ALGO_COMPETITIVE_TOTAL                                        │ │
│ │                                                                         │ │
│ │ Step 1: Amazon total = item + shipping                                  │ │
│ │         $29.99 + $0.00 = $29.99                                         │ │
│ │                                                                         │ │
│ │ Step 2: Target delivered = total × (1 - discount%)                      │ │
│ │         $29.99 × 0.90 = $26.99                                          │ │
│ │                                                                         │ │
│ │ Step 3: eBay item price = target - template shipping                    │ │
│ │         $26.99 - $6.00 = $20.99                                         │ │
│ │                                                                         │ │
│ │ Step 4: Apply floor ($1.99 minimum)                                     │ │
│ │         $20.99 > $1.99 ✓                                                │ │
│ │                                                                         │ │
│ │ FINAL PRICE: $20.99                                                     │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │ STRATEGY: DISCOUNT_ITEM_ONLY (simpler)                                  │ │
│ │                                                                         │ │
│ │ Step 1: eBay item price = Amazon item × (1 - discount%)                 │ │
│ │         $29.99 × 0.90 = $26.99                                          │ │
│ │                                                                         │ │
│ │ (Ignores shipping in calculation)                                       │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│ ⚠️ CRITICAL: Amazon prices get NO discount (effectiveDiscount = 0)          │
│    Only Brand MSRP gets discounted!                                          │
│    Rationale: Amazon IS the competitive market price already.               │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Discount Logic: Who Gets Discounted?

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    DISCOUNT APPLICATION RULES                                │
│                                                                              │
│  SOURCE            │ DISCOUNT APPLIED? │ REASON                             │
│  ──────────────────┼───────────────────┼──────────────────────────────────  │
│  amazon            │ NO (0%)           │ Already competitive market price   │
│  brand-msrp        │ YES (10%)         │ Often inflated retail price        │
│  ebay-sold         │ NO                │ Already represents sold prices     │
│  brave-fallback    │ YES (10%)         │ May be inflated retailer price     │
│  estimate          │ NO                │ Already conservative estimate      │
│                                                                              │
│  Code (price-lookup.ts ~line 783):                                          │
│  const effectiveDiscount = chosen.source === 'amazon' ? 0 : settings.discount│
└─────────────────────────────────────────────────────────────────────────────┘
```

### Photo Quantity Adjustment (Lot Pricing)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    PHOTO QUANTITY / LOT PRICING                             │
│                                                                              │
│  Scenario: Photo shows 3 bottles, Amazon sells 1 bottle for $29.99         │
│                                                                              │
│  Step 1: Detect amazonPackSize from Amazon page                             │
│          (e.g., "2-pack" → amazonPackSize = 2)                              │
│                                                                              │
│  Step 2: Calculate per-unit price                                            │
│          perUnitPrice = $29.99 / 1 = $29.99                                 │
│                                                                              │
│  Step 3: Multiply by photoQuantity                                           │
│          lotRetailPrice = $29.99 × 3 = $89.97                               │
│                                                                              │
│  Step 4: Apply pricing computation to lotRetailPrice                         │
│          computeEbayItemPrice({ amazonItemPriceCents: 8997, ... })          │
│                                                                              │
│  Code (price-lookup.ts ~line 770):                                          │
│  const perUnitPrice = basePrice / amazonPackSize;                           │
│  const photoQty = input.photoQuantity || 1;                                 │
│  const lotRetailPriceCents = Math.round(perUnitPrice * photoQty * 100);     │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Fallback Decision (When AI Fails)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    fallbackDecision() Priority                              │
│                    Location: src/lib/price-lookup.ts ~line 860              │
│                                                                              │
│  PRIORITY 1: Amazon (Gold Standard)                                         │
│  └── Return amazon.price directly (no discount)                             │
│                                                                              │
│  PRIORITY 2: Brand MSRP                                                      │
│  └── Apply discount: computeEbayItemPrice(brandMsrp, settings)              │
│                                                                              │
│  PRIORITY 3: eBay Sold                                                       │
│  └── Return ebaySold.price directly (already competitive)                   │
│                                                                              │
│  PRIORITY 4: First Available                                                 │
│  └── Use whatever candidate exists (confidence: low)                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Caching Strategy

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          CACHING LAYERS                                      │
│                                                                              │
│ LAYER 1: Price Cache (Upstash Redis)                                        │
│ ├── Key: makePriceSig(brand, title) → SHA hash                              │
│ ├── TTL: 30 days                                                            │
│ ├── Stored: { msrpCents, chosen, candidates, cachedAt }                     │
│ ├── NOT stored: computed final price (settings may change)                  │
│ └── Validation: Reject if msrpCents < $5.00 (corrupted entry)              │
│                                                                              │
│ LAYER 2: Scan Results Cache (Redis)                                         │
│ ├── Key: analysis:${jobId}                                                  │
│ ├── Key: analysis:byFolder:${folderSig}                                     │
│ ├── TTL: 1 hour                                                             │
│ └── Stored: { groups, orphans, imageInsights, signature }                   │
│                                                                              │
│ LAYER 3: Category Cache (Netlify Blobs via cacheStore)                      │
│ ├── Key: taxonomy-categories-EBAY_US                                        │
│ ├── In-memory: categoriesCache (per function invocation)                    │
│ └── TTL: Long-lived (taxonomy doesn't change often)                         │
│                                                                              │
│ LAYER 4: Brand URL Cache (brand-map.ts)                                     │
│ ├── Curated brand → URL mappings                                            │
│ ├── Stored: { brand, requiresJs, lastChecked }                              │
│ └── Used to skip Brave search for known brands                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## External API Dependencies

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       EXTERNAL API DEPENDENCIES                              │
│                                                                              │
│ API                │ Used For                   │ Rate Limit Handling        │
│ ───────────────────┼────────────────────────────┼─────────────────────────── │
│ OpenAI GPT-4o      │ Listing generation         │ 30s timeout, 2 retries     │
│ OpenAI GPT-4o-mini │ Vision, Price arbitration  │ Batches of 12 images       │
│ Brave Search       │ Find Amazon/brand URLs     │ 500ms delay, 429 retry     │
│ SearchAPI.io       │ eBay sold prices           │ 1 call/second              │
│ RapidAPI Shopping  │ Multi-source price lookup  │ Per-request                │
│ Amazon (fetch)     │ Price extraction           │ 10s timeout                │
│ Brand websites     │ MSRP extraction            │ 10s timeout                │
│ Dropbox API        │ List/fetch images          │ OAuth refresh              │
│ eBay Taxonomy API  │ Category aspects           │ Cached                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Complete Pricing Flow Diagram

```
                              ┌──────────────────┐
                              │ lookupPrice()    │
                              └────────┬─────────┘
                                       │
                    ┌──────────────────┴──────────────────┐
                    │                                      │
                    ▼                                      ▼
            ┌───────────────┐                     ┌───────────────┐
            │ Check Cache   │                     │ Cache Miss    │
            │ (30-day TTL)  │                     │               │
            └───────┬───────┘                     └───────┬───────┘
                    │                                     │
                    │ HIT (msrpCents ≥ $5)                │
                    │                                     │
                    ▼                                     ▼
        ┌───────────────────────┐           ┌───────────────────────┐
        │ Apply User Settings   │           │ TIER 1: eBay Sold     │
        │ computeEbayItemPrice()│           │ SearchAPI.io          │
        │ (with cached MSRP)    │           └───────────┬───────────┘
        └───────────────────────┘                       │
                    │                                   ▼
                    │                       ┌───────────────────────┐
                    │                       │ TIER 2: Amazon        │
                    │                       │ Brave → Fetch → Parse │
                    │                       │ Validate brand/size   │
                    │                       └───────────┬───────────┘
                    │                                   │
                    │                    ┌──────────────┴──────────────┐
                    │                    │                             │
                    │                    ▼                             ▼
                    │        ┌───────────────────┐        ┌───────────────────┐
                    │        │ Amazon Found ✓    │        │ Amazon Not Found  │
                    │        │ Add to candidates │        │                   │
                    │        └───────────────────┘        │    TIER 2.5:      │
                    │                    │                │    RapidAPI       │
                    │                    │                └─────────┬─────────┘
                    │                    │                          │
                    │                    ▼                          ▼
                    │        ┌───────────────────────────────────────────────┐
                    │        │           TIER 3: Brand MSRP                  │
                    │        │  Vision URL → Brand Map → Brave Search       │
                    │        └───────────────────┬───────────────────────────┘
                    │                            │
                    │                            ▼
                    │        ┌───────────────────────────────────────────────┐
                    │        │           SANITY CHECKS                       │
                    │        │  • Remove low-confidence Amazon if Brand exists│
                    │        │  • Filter bundle prices (>1.8x market)        │
                    │        └───────────────────┬───────────────────────────┘
                    │                            │
                    │        ┌───────────────────┴───────────────────┐
                    │        │                                       │
                    │        ▼                                       ▼
                    │  ┌─────────────┐                       ┌─────────────┐
                    │  │ candidates  │                       │ No candidates│
                    │  │ exist       │                       │ → TIER 4     │
                    │  └──────┬──────┘                       │ Estimate     │
                    │         │                              └──────┬──────┘
                    │         ▼                                     │
                    │  ┌─────────────────────────┐                  │
                    │  │ AI Arbitration          │                  │
                    │  │ decideFinalPrice()      │                  │
                    │  │ GPT-4o-mini chooses     │                  │
                    │  │ best source             │                  │
                    │  └──────────┬──────────────┘                  │
                    │             │                                 │
                    │             ▼                                 │
                    │  ┌─────────────────────────────────────────────────┐
                    │  │              POST-PROCESSING                    │
                    │  │                                                 │
                    │  │  1. Pack Adjustment:                            │
                    │  │     perUnit = basePrice / amazonPackSize        │
                    │  │     lotPrice = perUnit × photoQuantity          │
                    │  │                                                 │
                    │  │  2. Discount Decision:                          │
                    │  │     if source === 'amazon': discount = 0%       │
                    │  │     else: discount = settings.discountPercent   │
                    │  │                                                 │
                    │  │  3. computeEbayItemPrice():                     │
                    │  │     ALGO: (total × discount) - shipping         │
                    │  │     ITEM_ONLY: item × discount                  │
                    │  │                                                 │
                    │  │  4. Floor check: max($1.99, computed)           │
                    │  └──────────────────┬──────────────────────────────┘
                    │                     │
                    └─────────────────────┼────────────────────────────────
                                          │
                                          ▼
                              ┌───────────────────────┐
                              │ CACHE RESULT          │
                              │ if msrpCents ≥ $5     │
                              │ setCachedPrice()      │
                              │ TTL: 30 days          │
                              └───────────────────────┘
                                          │
                                          ▼
                              ┌───────────────────────┐
                              │ RETURN PriceDecision  │
                              │ {                     │
                              │   ok: true,           │
                              │   source: 'amazon',   │
                              │   price: 20.99,       │
                              │   confidence: 'high', │
                              │   chosen: {...},      │
                              │   candidates: [...],  │
                              │   amazonUrl,          │
                              │   amazonWeight        │
                              │ }                     │
                              └───────────────────────┘
```

---

## Key File Reference

| File | Purpose |
|------|---------|
| `netlify/functions/smartdrafts-scan-bg.ts` | Scan initiator (auth, quota, job creation) |
| `netlify/functions/smartdrafts-scan-background.ts` | Scan worker (vision, pairing) |
| `netlify/functions/smartdrafts-create-drafts-bg.ts` | Draft initiator |
| `netlify/functions/smartdrafts-create-drafts-background.ts` | Draft worker (pricing, GPT listing) |
| `src/lib/smartdrafts-scan-core.ts` | Core scan logic |
| `src/lib/price-lookup.ts` | **MAIN PRICING ENGINE** |
| `src/lib/pricing-compute.ts` | Price math (discount, shipping) |
| `src/lib/pricing-config.ts` | User settings, defaults |
| `src/lib/pricing/ebay-sold-prices.ts` | eBay sold lookup (SearchAPI) |
| `src/lib/html-price.ts` | Amazon/brand HTML parsing |
| `src/lib/search.ts` | Brave Search wrapper |
| `src/lib/rapidapi-product-search.ts` | RapidAPI (brave-fallback) |
| `src/lib/brand-map.ts` | Brand URL registry |
| `src/lib/job-store.ts` | Redis cache helpers |

---

## Summary: Price Source Priority

```
1. CACHE HIT (30-day TTL, msrpCents stored, recomputed with current settings)
   ↓ miss
2. AMAZON (searched via Brave, validated for brand/size match)
   - NO DISCOUNT APPLIED - this IS the market price
   ↓ not found or rejected
3. RAPIDAPI (Google Shopping aggregation, labeled 'brave-fallback')
   ↓ not found
4. BRAND MSRP (Vision URL → Brand Map → Brave → HTML parse)
   - 10% DISCOUNT APPLIED
   ↓ not found
5. EBAY SOLD (SearchAPI.io, p35 percentile)
   ↓ not found or rate limited
6. CATEGORY ESTIMATE ($24.99-$39.99 based on product type)
   - Status: NEEDS_REVIEW
```

---

## ⚠️ KNOWN ISSUES (January 2026)

### Issue 1: OpenAI Web Search Not Used
The file `src/lib/openai-websearch.ts` exists with ChatGPT web search capability, but it is **NOT imported or called** from `price-lookup.ts`. This may explain why Amazon prices aren't being found - the system relies on Brave Search + HTML scraping instead of ChatGPT's more robust web search.

### Issue 2: Discount Applied to Non-Amazon Sources
When Amazon search fails and the system falls back to `brave-fallback` (RapidAPI) or `brand-msrp`, the 10% discount is applied. Combined with the $6 shipping subtraction, this can result in prices significantly below Amazon retail.

### Issue 3: Cache Returns Wrong Prices
Cached prices store the `msrpCents` but the `source` might be wrong (e.g., cached as `brave-fallback` when the correct source should be `amazon`). When cache is hit, it applies discount based on the cached source, not the correct source.
