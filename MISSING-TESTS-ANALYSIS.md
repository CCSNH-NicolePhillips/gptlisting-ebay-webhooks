# Missing Unit Tests - Critical Functions Analysis

**Date**: November 16, 2025  
**Purpose**: Identify critical functions lacking unit test coverage to prevent regressions

---

## Executive Summary

After scanning the codebase, I've identified **18 critical functions** that lack unit test coverage. These functions handle core business logic for:
- eBay API integration and OAuth
- Listing creation and publishing
- AI-powered content generation
- Pricing calculations
- Category selection
- Data transformation

**Risk Level**: HIGH - These functions are used in production and failures could cause:
- Failed listings
- Incorrect pricing
- Lost sales
- API errors
- User authentication issues

---

## Critical Missing Tests (Prioritized)

### 🔴 TIER 1: HIGHEST PRIORITY (Production-Critical)

#### 1. **eBay Service - Core API Functions** (`src/services/ebay.ts`)
**Missing Tests**:
- `ensureInventoryItem()` - Creates/updates eBay inventory items
- `createOffer()` - Creates eBay offers (listings)
- `publishOffer()` - Publishes offers live
- `ensureEbayPrereqs()` - Auto-provision policies and locations
- `getAccessToken()` - OAuth token refresh (authentication)

**Why Critical**:
- Powers entire eBay listing pipeline
- Handles authentication (token refresh)
- Any failure = broken listings
- Complex error handling logic needs validation

**Test Coverage Needed**:
```typescript
describe('eBay Service', () => {
  describe('ensureInventoryItem', () => {
    it('should create inventory item with valid data')
    it('should handle duplicate SKU errors')
    it('should validate image URLs')
    it('should enforce required fields')
  })
  
  describe('createOffer', () => {
    it('should create offer with valid SKU')
    it('should handle missing policy IDs')
    it('should validate price format')
    it('should handle marketplace validation errors')
  })
  
  describe('getAccessToken', () => {
    it('should refresh expired tokens')
    it('should handle invalid refresh tokens')
    it('should cache tokens appropriately')
  })
  
  describe('ensureEbayPrereqs', () => {
    it('should create all required policies')
    it('should handle duplicate policy errors')
    it('should reuse existing policies')
    it('should handle sandbox environment differences')
  })
})
```

**Existing Coverage**: ❌ NONE

---

#### 2. **Listing Enrichment - AI Content Generation** (`src/services/listing-enrichment.ts`)
**Missing Tests**:
- `enrichListingWithAI()` - ChatGPT title/description generation
- `buildEnrichmentPrompt()` - Prompt construction
- `generateFallbackListing()` - Fallback when AI fails

**Why Critical**:
- Generates customer-facing content
- Affects SEO and sales
- Expensive API calls (OpenAI)
- Must handle API failures gracefully

**Test Coverage Needed**:
```typescript
describe('Listing Enrichment', () => {
  describe('enrichListingWithAI', () => {
    it('should generate valid title under 80 chars')
    it('should generate compelling description')
    it('should handle OpenAI API errors')
    it('should fallback when no API key')
    it('should include product features in output')
  })
  
  describe('buildEnrichmentPrompt', () => {
    it('should include all product data')
    it('should format claims correctly')
    it('should handle missing optional fields')
  })
  
  describe('generateFallbackListing', () => {
    it('should create basic title from product data')
    it('should handle missing brand/product')
  })
})
```

**Existing Coverage**: ❌ NONE

---

#### 3. **Pricing Formula** (`netlify/functions/smartdrafts-create-drafts.ts` & background variant)
**Missing Tests**:
- `computeEbayPrice()` - Apply category-specific caps and discount formula

**Why Critical**:
- Determines actual selling price
- Category-specific caps prevent overpricing
- Formula errors = lost profit or unsellable items
- Currently in production use

**Test Coverage Needed**:
```typescript
describe('computeEbayPrice', () => {
  it('should apply 10% discount to base price')
  it('should add $5 for prices over $30')
  it('should cap books at $35')
  it('should cap DVDs at $25')
  it('should handle zero/negative prices')
  it('should round to 2 decimal places')
  
  // Specific examples
  it('should price $34.99 book as $31.50', () => {
    // $34.99 → $35 cap → $31.50 (10% off) → $31.50 (under $30, no +$5)
  })
  
  it('should price $50 supplement as $50', () => {
    // $50 → no cap → $45 (10% off) → $50 (over $30, +$5)
  })
})
```

**Existing Coverage**: ✅ EXISTS (`tests/smartdrafts/computeEbayPrice.test.ts`)

---

#### 4. **Category Selection** (`src/lib/taxonomy-select.ts`)
**Missing Tests**:
- `pickCategoryForGroup()` - Select best eBay category for product

**Why Critical**:
- Wrong category = listing rejected or poor visibility
- Complex matching logic (title, path, slug)
- Handles 20,000+ categories
- Fallback scoring algorithm

**Test Coverage Needed**:
```typescript
describe('taxonomy-select', () => {
  describe('pickCategoryForGroup', () => {
    it('should match category by ID')
    it('should match by exact title')
    it('should match by category path')
    it('should match last path segment')
    it('should use scoreRules fallback')
    it('should handle missing category data')
  })
})
```

**Existing Coverage**: ❌ NONE

---

#### 5. **Draft Mapping with Overrides** (`src/lib/map-group-to-draft.ts`)
**Missing Tests**:
- `mapGroupToDraft()` - Map product group to eBay draft format
- `applyOverride()` - Apply user edits to draft
- `mergeAspects()` - Merge aspect overrides

**Why Critical**:
- Transforms paired products into eBay-ready format
- Handles user edits (title, price, category changes)
- Proxies images through rotation handler
- Complex object merging logic

**Test Coverage Needed**:
```typescript
describe('map-group-to-draft', () => {
  describe('mapGroupToDraft', () => {
    it('should map basic product to draft')
    it('should apply user overrides')
    it('should proxy image URLs')
    it('should handle missing fields')
  })
  
  describe('applyOverride', () => {
    it('should override title')
    it('should override price')
    it('should override category')
    it('should merge aspects correctly')
    it('should handle null values')
  })
  
  describe('mergeAspects', () => {
    it('should add new aspects')
    it('should replace existing aspects')
    it('should delete null aspects')
    it('should sanitize string arrays')
  })
})
```

**Existing Coverage**: ❌ NONE

---

### 🟡 TIER 2: HIGH PRIORITY (Data Integrity)

#### 6. **GPT Response Parsing** (`netlify/functions/smartdrafts-create-drafts.ts`)
**Missing Tests**:
- `parseGptResponse()` - Strip markdown, parse JSON, validate fields

**Why Critical**:
- GPT responses often wrapped in ```json ... ```
- Invalid JSON = failed draft creation
- Field validation ensures data quality

**Test Coverage Needed**:
```typescript
describe('parseGptResponse', () => {
  it('should strip markdown code blocks')
  it('should parse valid JSON')
  it('should handle malformed JSON')
  it('should validate required fields')
  it('should handle missing optional fields')
})
```

**Existing Coverage**: ✅ EXISTS (`tests/smartdrafts/parseGptResponse.test.ts`)

---

#### 7. **Aspect Normalization** (`netlify/functions/smartdrafts-create-drafts.ts`)
**Missing Tests**:
- `normalizeAspects()` - Convert aspects to string arrays, ensure Brand/Size

**Why Critical**:
- eBay requires aspects as string arrays
- Must preserve Brand and Size
- GPT sometimes provides wrong format

**Test Coverage Needed**:
```typescript
describe('normalizeAspects', () => {
  it('should convert string to array')
  it('should preserve existing arrays')
  it('should ensure Brand exists')
  it('should ensure Size exists')
  it('should handle null/undefined')
})
```

**Existing Coverage**: ✅ EXISTS (`tests/smartdrafts/normalizeAspects.test.ts`)

---

#### 8. **Category List Generation** (`netlify/functions/smartdrafts-create-drafts.ts`)
**Missing Tests**:
- `getRelevantCategories()` - Filter 20k categories to 20 relevant ones

**Why Critical**:
- Expensive operation (loads 20k categories)
- Powers GPT category selection
- Fallback logic must work

**Test Coverage Needed**:
```typescript
describe('getRelevantCategories', () => {
  it('should return categories matching product keywords')
  it('should limit results to 20')
  it('should include aspect hints')
  it('should fallback to common categories')
  it('should handle empty product data')
})
```

**Existing Coverage**: ✅ EXISTS (`tests/smartdrafts/getRelevantCategories.test.ts`)

---

#### 9. **Prompt Building** (`netlify/functions/smartdrafts-create-drafts.ts`)
**Missing Tests**:
- `buildPrompt()` - Construct GPT prompt with product data + categories

**Why Critical**:
- Quality of prompt = quality of output
- Must include all relevant data
- Must format categories correctly

**Test Coverage Needed**:
```typescript
describe('buildPrompt', () => {
  it('should include all product fields')
  it('should include category list')
  it('should include category aspects')
  it('should format claims correctly')
  it('should handle missing optional fields')
})
```

**Existing Coverage**: ❌ NONE

---

### 🟢 TIER 3: MEDIUM PRIORITY (Supporting Functions)

#### 10. **Token Management** (`src/services/ebay.ts`)
**Missing Tests**:
- `readTokens()` - Read OAuth tokens from file
- `writeTokens()` - Write OAuth tokens to file
- `saveEbayTokens()` - Save user tokens after OAuth

**Why Critical**:
- Security-sensitive (OAuth tokens)
- File I/O can fail
- Must handle concurrent access

---

#### 11. **Policy Management** (`src/services/ebay.ts`)
**Missing Tests**:
- `ensurePaymentPolicy()` - Create/reuse payment policy
- `ensureReturnPolicy()` - Create/reuse return policy
- `ensureFulfillmentPolicy()` - Create/reuse shipping policy
- `ensureInventoryLocation()` - Create/reuse warehouse location

**Why Critical**:
- Required for every listing
- Complex duplicate detection
- Sandbox vs Production differences

---

#### 12. **Image Utilities** (`src/lib/image-utils.ts`)
**Missing Tests**:
- `proxyImageUrls()` - Proxy images through rotation handler

**Why Critical**:
- Handles EXIF rotation
- Ensures images display correctly
- URL construction must be accurate

---

#### 13. **Taxonomy Store** (`src/lib/taxonomy-store.ts`)
**Missing Tests**:
- `listCategories()` - Load 20k categories from CSV
- `getCategoryById()` - Lookup category by ID

**Why Critical**:
- Performance-critical (caching)
- Powers category selection
- CSV parsing can fail

---

## Test Coverage Summary

| Module | Functions | Tested | Missing | Coverage |
|--------|-----------|--------|---------|----------|
| `services/ebay.ts` | 15 | 0 | 15 | 0% |
| `services/listing-enrichment.ts` | 5 | 0 | 5 | 0% |
| `lib/taxonomy-select.ts` | 3 | 0 | 3 | 0% |
| `lib/map-group-to-draft.ts` | 6 | 0 | 6 | 0% |
| `smartdrafts-create-drafts.ts` | 8 | 4 | 4 | 50% |
| `lib/taxonomy-store.ts` | 3 | 0 | 3 | 0% |
| `lib/image-utils.ts` | 2 | 0 | 2 | 0% |

**Overall Critical Functions**: 42 total  
**Tested**: 4 (9.5%)  
**Missing Tests**: 38 (90.5%)

---

## Recommended Action Plan

### Phase 1: Block Production Regressions (Week 1)
1. ✅ Test `computeEbayPrice()` - ALREADY EXISTS
2. ✅ Test `parseGptResponse()` - ALREADY EXISTS
3. ✅ Test `normalizeAspects()` - ALREADY EXISTS
4. ✅ Test `getRelevantCategories()` - ALREADY EXISTS
5. ⚠️ **ADD**: Test `ensureInventoryItem()` - eBay API
6. ⚠️ **ADD**: Test `createOffer()` - eBay API
7. ⚠️ **ADD**: Test `getAccessToken()` - OAuth

### Phase 2: Data Quality (Week 2)
8. ⚠️ **ADD**: Test `enrichListingWithAI()`
9. ⚠️ **ADD**: Test `buildEnrichmentPrompt()`
10. ⚠️ **ADD**: Test `pickCategoryForGroup()`
11. ⚠️ **ADD**: Test `mapGroupToDraft()`
12. ⚠️ **ADD**: Test `applyOverride()`

### Phase 3: Stability & Edge Cases (Week 3)
13. ⚠️ **ADD**: Test `ensureEbayPrereqs()`
14. ⚠️ **ADD**: Test policy creation functions
15. ⚠️ **ADD**: Test `buildPrompt()`
16. ⚠️ **ADD**: Test `proxyImageUrls()`

---

## Testing Strategy Recommendations

### Mock External APIs
```typescript
// Mock eBay API calls
jest.mock('undici', () => ({
  fetch: jest.fn()
}))

// Mock OpenAI
jest.mock('openai')

// Mock Redis (Upstash)
jest.mock('@upstash/redis')
```

### Test Data Fixtures
Create realistic test data:
- Sample product groups
- eBay API responses
- GPT responses (valid and malformed)
- Category taxonomy snapshots

### Integration Test Strategy
Some functions require integration testing:
- Token refresh (needs real OAuth flow)
- Image proxy (needs real images)
- Category loading (needs CSV file)

Consider:
- Separate `*.integration.test.ts` files
- Use sandbox eBay environment
- Run in CI but not on every commit

---

## Risk Assessment

### Without Tests:
- ❌ Price calculation bugs could lose money
- ❌ Category errors could prevent listings
- ❌ OAuth failures could break authentication
- ❌ Image proxy errors could show rotated images
- ❌ Aspect normalization bugs could cause eBay rejections

### With Tests:
- ✅ Catch regressions before deploy
- ✅ Safe refactoring
- ✅ Documented behavior
- ✅ Faster debugging
- ✅ Confident deployments

---

## Next Steps

1. **Review this analysis** with the team
2. **Prioritize** which tests to write first
3. **Create test fixtures** for product data, eBay responses, GPT responses
4. **Set up mocks** for external APIs
5. **Write tests** following the coverage plans above
6. **Add CI checks** to prevent coverage regression
7. **Set coverage targets**: Aim for 80%+ on critical functions

**Estimated Effort**: 2-3 weeks for comprehensive coverage of Tier 1 & 2 functions

---

## Conclusion

We have **excellent coverage** of SmartDrafts business logic (pricing, parsing, aspects, categories), but **zero coverage** of critical infrastructure:
- eBay API integration
- OAuth token management
- AI content generation
- Draft mapping/overrides

**Recommendation**: Prioritize eBay API and OAuth tests immediately, as these are most likely to cause production incidents.
