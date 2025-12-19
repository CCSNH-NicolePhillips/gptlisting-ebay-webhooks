/**
 * Test for the specific bug: group.price without priceMeta causing double discount
 */

import { mapGroupToDraftWithTaxonomy } from '../../src/lib/taxonomy-map.js';

// Mock dependencies
jest.mock('../../src/lib/_blobs', () => ({
  getBlob: jest.fn(),
  setBlob: jest.fn(),
}));

jest.mock('../../src/lib/taxonomy-store', () => ({
  getCategoryData: jest.fn().mockResolvedValue(null),
  listCategories: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../src/lib/taxonomy-autofill', () => ({
  buildItemSpecifics: jest.fn().mockReturnValue({
    aspects: { Brand: ['TestBrand'] },
    aspectsCount: 1,
    hasAspects: true,
    hasBrand: true,
    aspectKeys: ['Brand'],
  }),
}));

describe('taxonomy-map price-only bug test', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('BUG TEST: group.price=45.30 without priceMeta should NOT apply discount again', async () => {
    // Scenario: Publishing a draft where:
    // - Original retail: $57.00
    // - Draft was created with 10% discount: $57 * 0.9 = $51.30 - $6 = $45.30
    // - Draft stored with group.price = 45.30 but priceMeta got lost/stripped
    // - BUG: Code treats 45.30 as retail, applies discount: $45.30 * 0.9 - $6 = $34.77
    
    const group = {
      brand: 'TestBrand',
      product: 'TestProduct',
      images: ['https://example.com/img1.jpg'],
      price: 45.30, // Pre-computed draft price (already discounted)
      // NO priceMeta - this is the critical condition that triggers the bug
    };

    const result = await mapGroupToDraftWithTaxonomy(group);

    // The price should stay 45.30 (not recalculated to 34.77)
    console.log('Result price:', result.offer.price);
    console.log('Expected: 45.30 (pre-computed)');
    console.log('Bug would give: 34.77 (double discount)');
    
    expect(result.offer.price).toBe(45.30);
  });

  it('CONTROL TEST: group.price + priceMeta should use pre-computed price', async () => {
    // This is the case we already fixed - should work
    const group = {
      brand: 'TestBrand',
      product: 'TestProduct',
      images: ['https://example.com/img1.jpg'],
      price: 45.30, // Pre-computed draft price
      priceMeta: {
        chosenSource: 'brand-msrp',
        basePrice: 57.00, // Original retail
        candidates: [
          {
            source: 'brand-msrp',
            price: 57.00,
            shippingCents: 0,
          },
        ],
      },
    };

    const result = await mapGroupToDraftWithTaxonomy(group);

    // Should use pre-computed price
    expect(result.offer.price).toBe(45.30);
  });

  it('NEW DRAFT TEST: priceMeta only (no group.price) should compute correctly', async () => {
    // This is creating a NEW draft with fresh pricing
    const group = {
      brand: 'TestBrand',
      product: 'TestProduct',
      images: ['https://example.com/img1.jpg'],
      priceMeta: {
        chosenSource: 'brand-msrp',
        basePrice: 57.00, // Retail price
        candidates: [
          {
            source: 'brand-msrp',
            price: 57.00,
            shippingCents: 0,
          },
        ],
      },
      // NO group.price - this is a new draft
    };

    const result = await mapGroupToDraftWithTaxonomy(group);

    // Should compute: $57 * 0.9 = $51.30 - $6 = $45.30
    expect(result.offer.price).toBe(45.30);
  });
});
