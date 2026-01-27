/**
 * Tests for pricing settings merge behavior in taxonomy-map.ts
 * Validates that user settings correctly override defaults without regressions
 */

// Mock dependencies
jest.mock('../../src/lib/taxonomy-autofill.js', () => ({
  buildItemSpecifics: jest.fn(),
}));

jest.mock('../../src/lib/taxonomy-select.js', () => ({
  pickCategoryForGroup: jest.fn(),
}));

jest.mock('../../src/lib/redis-store.js', () => ({
  tokensStore: jest.fn(),
}));

jest.mock('../../src/lib/pricing-compute.js', () => ({
  computeEbayItemPriceCents: jest.fn(),
  computeEbayOfferPricingCents: jest.fn(),
  formatPricingLogLine: jest.fn(() => '[pricing] mock log line'),
}));

describe('taxonomy-map: Pricing Settings Merge', () => {
  let mapGroupToDraftWithTaxonomy: any;
  let mockBuildItemSpecifics: jest.Mock;
  let mockPickCategoryForGroup: jest.Mock;
  let mockTokensStore: jest.Mock;
  let mockComputeEbayItemPriceCents: jest.Mock;
  let mockComputeEbayOfferPricingCents: jest.Mock;
  let mockStoreGet: jest.Mock;

  beforeEach(() => {
    jest.resetModules();
    
    // Get mocked functions
    mockBuildItemSpecifics = require('../../src/lib/taxonomy-autofill.js').buildItemSpecifics;
    mockPickCategoryForGroup = require('../../src/lib/taxonomy-select.js').pickCategoryForGroup;
    mockTokensStore = require('../../src/lib/redis-store.js').tokensStore;
    mockComputeEbayItemPriceCents = require('../../src/lib/pricing-compute.js').computeEbayItemPriceCents;
    mockComputeEbayOfferPricingCents = require('../../src/lib/pricing-compute.js').computeEbayOfferPricingCents;
    
    // Setup default mocks
    mockBuildItemSpecifics.mockReturnValue({ Brand: ['TestBrand'] });
    mockPickCategoryForGroup.mockResolvedValue(null);
    
    // Mock tokens store
    mockStoreGet = jest.fn();
    mockTokensStore.mockReturnValue({ get: mockStoreGet });
    
    // Mock pricing compute to return predictable result
    mockComputeEbayItemPriceCents.mockReturnValue({
      ebayItemPriceCents: 4530,
      targetDeliveredTotalCents: 5130,
      evidence: {
        shippingSubsidyAppliedCents: 600,
      },
    });
    
    // Mock offer pricing split (new function) - pass through delivered target
    mockComputeEbayOfferPricingCents.mockImplementation((opts: { baseDeliveredTargetCents: number }) => ({
      targetDeliveredTotalCents: opts.baseDeliveredTargetCents,
      itemPriceCents: opts.baseDeliveredTargetCents - 600, // subtract default shipping
      shippingChargeCents: 600,
      shippingCostEstimateCents: 600,
      effectiveShippingMode: 'BUYER_PAYS_SHIPPING',
      warnings: [],
      evidence: {},
    }));
    
    // Load module under test
    ({ mapGroupToDraftWithTaxonomy } = require('../../src/lib/taxonomy-map'));
  });

  describe('A) Settings Merge Behavior', () => {
    const baseGroup = {
      brand: 'TestBrand',
      product: 'TestProduct',
      images: ['https://example.com/img1.jpg'],
      priceMeta: {
        chosenSource: 'brand-msrp',
        basePrice: 57.00,
        candidates: [
          {
            source: 'brand-msrp',
            price: 57.00,
            shippingCents: 0,
          },
        ],
      },
    };

    it('1) No saved user settings: uses defaults', async () => {
      mockStoreGet.mockResolvedValue(null);
      
      await mapGroupToDraftWithTaxonomy(baseGroup, 'user-123');
      
      // Verify computeEbayItemPriceCents was called with default settings
      expect(mockComputeEbayItemPriceCents).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({
            shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
            discountPercent: 10,
            templateShippingEstimateCents: 600,
            shippingSubsidyCapCents: null,
            minItemPriceCents: 199,
          }),
        })
      );
    });

    it('2) Partial user overrides: preserves unspecified defaults', async () => {
      // User only overrides discountPercent
      const userSettings = {
        pricing: {
          discountPercent: 15,
        },
      };
      mockStoreGet.mockResolvedValue(JSON.stringify(userSettings));
      
      await mapGroupToDraftWithTaxonomy(baseGroup, 'user-123');
      
      // Verify merge: user value for discountPercent, defaults for rest
      expect(mockComputeEbayItemPriceCents).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({
            discountPercent: 15, // USER OVERRIDE
            shippingStrategy: 'ALGO_COMPETITIVE_TOTAL', // DEFAULT
            templateShippingEstimateCents: 600, // DEFAULT
            shippingSubsidyCapCents: null, // DEFAULT
            minItemPriceCents: 199, // DEFAULT
          }),
        })
      );
    });

    it('2b) Partial user overrides: multiple fields', async () => {
      const userSettings = {
        pricing: {
          discountPercent: 15,
          shippingStrategy: 'DISCOUNT_ITEM_ONLY',
          minItemPriceCents: 299,
        },
      };
      mockStoreGet.mockResolvedValue(JSON.stringify(userSettings));
      
      await mapGroupToDraftWithTaxonomy(baseGroup, 'user-123');
      
      expect(mockComputeEbayItemPriceCents).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({
            discountPercent: 15, // USER
            shippingStrategy: 'DISCOUNT_ITEM_ONLY', // USER
            minItemPriceCents: 299, // USER
            templateShippingEstimateCents: 600, // DEFAULT
            shippingSubsidyCapCents: null, // DEFAULT
          }),
        })
      );
    });

    it('3) Full user overrides: uses all saved values', async () => {
      const userSettings = {
        pricing: {
          discountPercent: 20,
          shippingStrategy: 'DISCOUNT_ITEM_ONLY',
          templateShippingEstimateCents: 800,
          shippingSubsidyCapCents: 1000,
          minItemPriceCents: 500,
        },
      };
      mockStoreGet.mockResolvedValue(JSON.stringify(userSettings));
      
      await mapGroupToDraftWithTaxonomy(baseGroup, 'user-123');
      
      // All values should match user settings exactly (plus defaults for new fields)
      expect(mockComputeEbayItemPriceCents).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({
            discountPercent: 20,
            shippingStrategy: 'DISCOUNT_ITEM_ONLY',
            templateShippingEstimateCents: 800,
            shippingSubsidyCapCents: 1000,
            minItemPriceCents: 500,
          }),
        })
      );
    });

    it('4a) Invalid saved blob: null - falls back to defaults', async () => {
      mockStoreGet.mockResolvedValue(null);
      
      const result = await mapGroupToDraftWithTaxonomy(baseGroup, 'user-123');
      
      // Should not throw, should use defaults
      expect(result).toBeDefined();
      expect(mockComputeEbayItemPriceCents).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({
            shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
            discountPercent: 10,
          }),
        })
      );
    });

    it('4b) Invalid saved blob: invalid JSON - falls back to defaults', async () => {
      mockStoreGet.mockResolvedValue('{ invalid json');
      
      const result = await mapGroupToDraftWithTaxonomy(baseGroup, 'user-123');
      
      // Should not throw, should use defaults
      expect(result).toBeDefined();
      expect(mockComputeEbayItemPriceCents).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({
            shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
            discountPercent: 10,
          }),
        })
      );
    });

    it('4c) Invalid saved blob: pricing is not an object - falls back to defaults', async () => {
      const userSettings = {
        pricing: 'invalid',
      };
      mockStoreGet.mockResolvedValue(JSON.stringify(userSettings));
      
      const result = await mapGroupToDraftWithTaxonomy(baseGroup, 'user-123');
      
      // Should not throw, should use defaults
      expect(result).toBeDefined();
      expect(mockComputeEbayItemPriceCents).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({
            shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
            discountPercent: 10,
          }),
        })
      );
    });

    it('4d) Blob store throws error - falls back to defaults without throwing', async () => {
      mockStoreGet.mockRejectedValue(new Error('Blob store unavailable'));
      
      const result = await mapGroupToDraftWithTaxonomy(baseGroup, 'user-123');
      
      // Should not throw, should use defaults
      expect(result).toBeDefined();
      expect(mockComputeEbayItemPriceCents).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({
            shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
            discountPercent: 10,
          }),
        })
      );
    });

    it('5) No userId provided - uses defaults without attempting to load', async () => {
      await mapGroupToDraftWithTaxonomy(baseGroup); // No userId
      
      // Should not attempt to load from store
      expect(mockStoreGet).not.toHaveBeenCalled();
      
      // Should use defaults
      expect(mockComputeEbayItemPriceCents).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({
            shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
            discountPercent: 10,
          }),
        })
      );
    });
  });

  describe('B) Pricing Compute Wiring', () => {
    it('1) priceMeta with amazonItemPriceCents=5700, amazonShippingCents=0, default ALGO → offer.price=45.30', async () => {
      mockStoreGet.mockResolvedValue(null); // Use defaults
      
      const group = {
        brand: 'TestBrand',
        product: 'TestProduct',
        images: ['https://example.com/img1.jpg'],
        priceMeta: {
          chosenSource: 'brand-msrp',
          basePrice: 57.00,
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
      
      // Verify computeEbayItemPriceCents called with correct inputs
      expect(mockComputeEbayItemPriceCents).toHaveBeenCalledWith({
        amazonItemPriceCents: 5700,
        amazonShippingCents: 0,
        settings: expect.objectContaining({
          shippingStrategy: 'ALGO_COMPETITIVE_TOTAL',
          discountPercent: 10,
          templateShippingEstimateCents: 600,
        }),
      });
      
      // Verify offer.price matches mocked result
      expect(result.offer.price).toBe(45.30); // 4530 cents / 100
    });

    it('2) Same input but DISCOUNT_ITEM_ONLY strategy → offer.price=51.30', async () => {
      // Mock different pricing result for DISCOUNT_ITEM_ONLY
      mockComputeEbayItemPriceCents.mockReturnValue({
        ebayItemPriceCents: 5130,
        targetDeliveredTotalCents: 5130,
        evidence: {
          shippingSubsidyAppliedCents: 0,
        },
      });
      
      // For DISCOUNT_ITEM_ONLY, the offer pricing should put full target into item price
      mockComputeEbayOfferPricingCents.mockReturnValue({
        targetDeliveredTotalCents: 5130,
        itemPriceCents: 5130, // Full target - no shipping split
        shippingChargeCents: 0,
        shippingCostEstimateCents: 600,
        effectiveShippingMode: 'FREE_SHIPPING',
        warnings: [],
        evidence: {},
      });
      
      const userSettings = {
        pricing: {
          shippingStrategy: 'DISCOUNT_ITEM_ONLY',
        },
      };
      mockStoreGet.mockResolvedValue(JSON.stringify(userSettings));
      
      const group = {
        brand: 'TestBrand',
        product: 'TestProduct',
        images: ['https://example.com/img1.jpg'],
        priceMeta: {
          chosenSource: 'brand-msrp',
          basePrice: 57.00,
          candidates: [
            {
              source: 'brand-msrp',
              price: 57.00,
              shippingCents: 0,
            },
          ],
        },
      };
      
      const result = await mapGroupToDraftWithTaxonomy(group, 'user-123');
      
      expect(mockComputeEbayItemPriceCents).toHaveBeenCalledWith({
        amazonItemPriceCents: 5700,
        amazonShippingCents: 0,
        settings: expect.objectContaining({
          shippingStrategy: 'DISCOUNT_ITEM_ONLY',
        }),
      });
      
      expect(result.offer.price).toBe(51.30); // 5130 cents / 100
    });

    it('3) priceMeta missing: treats group.price as pre-computed (publish mode)', async () => {
      mockStoreGet.mockResolvedValue(null);
      
      const group = {
        brand: 'TestBrand',
        product: 'TestProduct',
        price: 35.50, // Pre-computed eBay price (publish mode)
        images: ['https://example.com/img1.jpg'],
      };
      
      const result = await mapGroupToDraftWithTaxonomy(group);
      
      // Should NOT call compute function - price already computed
      expect(mockComputeEbayItemPriceCents).not.toHaveBeenCalled();
      
      expect(result).toBeDefined();
      expect(result.offer.price).toBe(35.50);
    });

    it('3b) priceMeta missing: falls back to group.pricing.ebay', async () => {
      mockStoreGet.mockResolvedValue(null);
      
      const group = {
        brand: 'TestBrand',
        product: 'TestProduct',
        pricing: { ebay: 42.99 },
        images: ['https://example.com/img1.jpg'],
      };
      
      const result = await mapGroupToDraftWithTaxonomy(group);
      
      expect(mockComputeEbayItemPriceCents).toHaveBeenCalledWith({
        amazonItemPriceCents: 4299, // 42.99 * 100
        amazonShippingCents: 0,
        settings: expect.any(Object),
      });
      
      expect(result).toBeDefined();
    });

    it('3c) No priceMeta and no legacy price: throws error', async () => {
      mockStoreGet.mockResolvedValue(null);
      
      const group = {
        brand: 'TestBrand',
        product: 'TestProduct',
        images: ['https://example.com/img1.jpg'],
        // No priceMeta, no price, no pricing.ebay
      };
      
      await expect(mapGroupToDraftWithTaxonomy(group)).rejects.toThrow(
        'Group missing pricing data'
      );
    });

    it('4) Amazon shipping cost included in calculation', async () => {
      mockStoreGet.mockResolvedValue(null);
      
      const group = {
        brand: 'TestBrand',
        product: 'TestProduct',
        images: ['https://example.com/img1.jpg'],
        priceMeta: {
          chosenSource: 'brand-msrp',
          basePrice: 57.00,
          candidates: [
            {
              source: 'brand-msrp',
              price: 57.00,
              shippingCents: 599, // $5.99 shipping
            },
          ],
        },
      };
      
      const result = await mapGroupToDraftWithTaxonomy(group);
      
      // Should pass shipping cost to pricing compute
      expect(mockComputeEbayItemPriceCents).toHaveBeenCalledWith({
        amazonItemPriceCents: 5700,
        amazonShippingCents: 599,
        settings: expect.any(Object),
      });
    });
  });
});
