# Unit Tests

This directory contains unit tests to prevent regressions in critical SmartDrafts functionality.

## Test Coverage

### SmartDrafts Tests (`tests/smartdrafts/`)

#### `parseGptResponse.test.ts` - GPT Response Parsing
**Critical Fix:** This function had a bug where GPT was wrapping JSON in markdown code blocks (`\`\`\`json ... \`\`\``), causing parsing failures.

Tests cover:
- ✅ Markdown code block stripping (`\`\`\`json`, `\`\`\``)
- ✅ Field validation and sanitization (title 80 chars, description 1200 chars, bullets 5 max)
- ✅ Fallback handling for missing fields
- ✅ Error handling for invalid JSON
- ✅ Type coercion and conversion

**Regression Prevention:** Ensures GPT responses are always parseable, even with markdown wrappers.

---

#### `computeEbayPrice.test.ts` - Pricing Formula
**Critical Feature:** Category-specific price caps prevent unrealistic pricing (e.g., $150 used book).

Tests cover:
- ✅ Category caps (Books $35, DVDs $25)
- ✅ Discount formula (10% off + $5 if >$30)
- ✅ Rounding to 2 decimal places
- ✅ Edge cases (negative, zero, NaN, Infinity)
- ✅ Real-world scenarios

**Regression Prevention:** Ensures pricing stays accurate and competitive.

---

#### `normalizeAspects.test.ts` - Aspect Normalization
**Critical Feature:** Converts GPT aspects to eBay-compatible format (string arrays).

Tests cover:
- ✅ Array conversion (single values → arrays)
- ✅ Sanitization (trim whitespace, remove empty values)
- ✅ Brand/Size enforcement from product data
- ✅ Edge cases (null, undefined, non-objects)
- ✅ Real-world GPT responses

**Regression Prevention:** Ensures eBay listings have proper aspect formatting.

---

#### `getRelevantCategories.test.ts` - Category Filtering
**Critical Feature:** Filters 20,000+ eBay categories to 20 most relevant, includes item specifics.

Tests cover:
- ✅ Search term matching (product, brand, variant, categoryPath)
- ✅ Term length filtering (ignore ≤3 chars)
- ✅ Aspect inclusion (non-required, max 8, exclude Brand)
- ✅ Result limiting (20 max)
- ✅ Fallback to common categories
- ✅ Output formatting

**Regression Prevention:** Ensures GPT receives accurate category options with item specifics.

---

### Pairing Tests (`tests/pairing/`)

Existing tests for the pairing algorithm (role gating, brand matching, size equality, etc.)

## Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode (auto-rerun on changes)
npm run test:watch

# Run tests with coverage report
npm run test:coverage

# Run tests with verbose output
npm run test:verbose

# Run specific test file
npm test parseGptResponse

# Run tests matching pattern
npm test smartdrafts
```

## Coverage Goals

- **Critical Functions:** 100% coverage (parseGptResponse, computeEbayPrice, normalizeAspects)
- **Integration Points:** Test end-to-end workflows
- **Regression Prevention:** Add tests for every bug fix

## Test Structure

```
tests/
├── smartdrafts/           # SmartDrafts pipeline tests
│   ├── parseGptResponse.test.ts
│   ├── computeEbayPrice.test.ts
│   ├── normalizeAspects.test.ts
│   └── getRelevantCategories.test.ts
├── pairing/               # Pairing algorithm tests
│   ├── candidates.test.ts
│   ├── featurePrep.test.ts
│   └── schema.test.ts
└── golden/                # Golden file test data
```

## Writing New Tests

### Unit Test Template

```typescript
describe('functionName', () => {
  describe('Feature category', () => {
    test('should handle specific case', () => {
      const result = functionName(input);
      
      expect(result).toBe(expected);
    });
  });

  describe('Edge cases', () => {
    test('should handle null input', () => {
      expect(functionName(null)).toBe(fallback);
    });
  });
});
```

### When to Add Tests

1. **Bug Fixes:** Add test reproducing the bug before fixing
2. **New Features:** Add tests for happy path + edge cases
3. **Refactoring:** Add tests to ensure behavior doesn't change
4. **Integration Points:** Test external API interactions with mocks

## CI/CD Integration

Tests run automatically on:
- Pre-commit (via Husky)
- PR builds (GitHub Actions)
- Pre-deployment checks

## Debugging Failed Tests

```bash
# Run single test with verbose output
npm test -- --testNamePattern="should strip markdown"

# Run with debugging
node --inspect-brk node_modules/.bin/jest --runInBand

# Update snapshots (if using snapshot testing)
npm test -- --updateSnapshot
```

## Common Issues

### ESM Import Errors
If you see "Cannot use import statement outside a module":
- Check `jest.config.js` has `preset: 'ts-jest/presets/default-esm'`
- Ensure test files use `.test.ts` extension

### TypeScript Errors
- Run `npm run typecheck` to verify TypeScript compilation
- Check `tsconfig.json` includes test directory

### Timeout Errors
For slow tests (e.g., Redis/API calls):
```typescript
jest.setTimeout(10000); // 10 seconds
```

## Future Test Additions

- [ ] Integration test for full create-drafts workflow
- [ ] Mock Redis for category store tests
- [ ] Mock OpenAI API for GPT tests
- [ ] E2E tests for Quick List page
- [ ] Performance tests for large batch processing
