/**
 * Tests for taxonomy-map.ts
 * Tests eBay draft mapping with taxonomy enrichment
 */

import type { CategoryDef } from '../../src/lib/taxonomy-schema';

// Mock dependencies
jest.mock('../../src/lib/taxonomy-autofill.js', () => ({
  buildItemSpecifics: jest.fn(),
}));

jest.mock('../../src/lib/taxonomy-select.js', () => ({
  pickCategoryForGroup: jest.fn(),
}));

describe('taxonomy-map', () => {
  let mapGroupToDraftWithTaxonomy: any;
  let mockBuildItemSpecifics: jest.Mock;
  let mockPickCategoryForGroup: jest.Mock;

  beforeEach(() => {
    jest.resetModules();
    
    // Get mocked functions
    mockBuildItemSpecifics = require('../../src/lib/taxonomy-autofill.js').buildItemSpecifics;
    mockPickCategoryForGroup = require('../../src/lib/taxonomy-select.js').pickCategoryForGroup;
    
    // Setup default mocks
    mockBuildItemSpecifics.mockReturnValue({ Brand: ['TestBrand'] });
    mockPickCategoryForGroup.mockResolvedValue(null);
    
    // Load module under test
    ({ mapGroupToDraftWithTaxonomy } = require('../../src/lib/taxonomy-map'));
  });

  describe('mapGroupToDraftWithTaxonomy', () => {
    describe('Basic validation', () => {
      it('should throw error for null group', async () => {
        await expect(mapGroupToDraftWithTaxonomy(null)).rejects.toThrow('Invalid group payload');
      });

      it('should throw error for undefined group', async () => {
        await expect(mapGroupToDraftWithTaxonomy(undefined)).rejects.toThrow('Invalid group payload');
      });

      it('should throw error for missing price', async () => {
        const group = {
          brand: 'TestBrand',
          product: 'TestProduct',
          images: ['https://example.com/img1.jpg'],
        };
        
        await expect(mapGroupToDraftWithTaxonomy(group)).rejects.toThrow('Group missing pricing data');
      });

      it('should throw error for invalid price', async () => {
        const group = {
          brand: 'TestBrand',
          product: 'TestProduct',
          price: -10,
          images: ['https://example.com/img1.jpg'],
        };
        
        await expect(mapGroupToDraftWithTaxonomy(group)).rejects.toThrow('Group missing pricing data');
      });

      it('should throw error for missing images', async () => {
        const group = {
          brand: 'TestBrand',
          product: 'TestProduct',
          price: 29.99,
          images: [],
        };
        
        await expect(mapGroupToDraftWithTaxonomy(group)).rejects.toThrow('Group missing image URLs');
      });

      it('should throw error when unable to derive title', async () => {
        const group = {
          price: 29.99,
          images: ['https://example.com/img1.jpg'],
        };
        
        await expect(mapGroupToDraftWithTaxonomy(group)).rejects.toThrow('Unable to derive title');
      });
    });

    describe('Title generation', () => {
      it('should use GPT-generated title if available', async () => {
        const group = {
          title: 'Custom GPT Title for Book',
          brand: 'TestBrand',
          product: 'TestProduct',
          price: 29.99,
          images: ['https://example.com/img1.jpg'],
        };
        
        const result = await mapGroupToDraftWithTaxonomy(group);
        
        expect(result.inventory.product.title).toBe('Custom GPT Title for Book');
      });

      it('should build title from brand, product, variant, size', async () => {
        const group = {
          brand: 'TestBrand',
          product: 'TestProduct',
          variant: 'Blue',
          size: '100ml',
          price: 29.99,
          images: ['https://example.com/img1.jpg'],
        };
        
        const result = await mapGroupToDraftWithTaxonomy(group);
        
        expect(result.inventory.product.title).toBe('TestBrand TestProduct Blue 100ml');
      });

      it('should truncate title at 80 characters', async () => {
        const group = {
          brand: 'VeryLongBrandName',
          product: 'VeryLongProductNameThatExceedsTheMaximumLengthAllowedByEBayForTitles',
          variant: 'VariantName',
          size: 'SizeName',
          price: 29.99,
          images: ['https://example.com/img1.jpg'],
        };
        
        const result = await mapGroupToDraftWithTaxonomy(group);
        
        expect(result.inventory.product.title.length).toBeLessThanOrEqual(80);
      });

      it('should handle missing variant and size', async () => {
        const group = {
          brand: 'TestBrand',
          product: 'TestProduct',
          price: 29.99,
          images: ['https://example.com/img1.jpg'],
        };
        
        const result = await mapGroupToDraftWithTaxonomy(group);
        
        expect(result.inventory.product.title).toBe('TestBrand TestProduct');
      });

      it('should normalize multiple spaces', async () => {
        const group = {
          brand: 'TestBrand',
          product: '  TestProduct  ',
          variant: '  Blue  ',
          price: 29.99,
          images: ['https://example.com/img1.jpg'],
        };
        
        const result = await mapGroupToDraftWithTaxonomy(group);
        
        expect(result.inventory.product.title).toBe('TestBrand TestProduct Blue');
      });
    });

    describe('SKU generation', () => {
      it('should generate SKU with brand and product initials', async () => {
        const group = {
          brand: 'Test Brand',
          product: 'Test Product',
          price: 29.99,
          images: ['https://example.com/img1.jpg'],
        };
        
        const result = await mapGroupToDraftWithTaxonomy(group);
        
        expect(result.sku).toMatch(/^TBTP[a-z0-9]+$/i);
      });

      it('should sanitize SKU to alphanumeric only', async () => {
        const group = {
          brand: 'Test-Brand!!!',
          product: 'Test@Product#',
          price: 29.99,
          images: ['https://example.com/img1.jpg'],
        };
        
        const result = await mapGroupToDraftWithTaxonomy(group);
        
        expect(result.sku).toMatch(/^[a-z0-9]+$/i);
      });

      it('should handle missing brand in SKU', async () => {
        const group = {
          product: 'Test Product',
          price: 29.99,
          images: ['https://example.com/img1.jpg'],
        };
        
        const result = await mapGroupToDraftWithTaxonomy(group);
        
        // SKU should start with product initials (TP) when brand is missing
        expect(result.sku).toMatch(/^TP[a-z0-9]+$/i);
      });

      it('should handle multi-word brand names', async () => {
        const group = {
          brand: 'Very Long Brand Name',
          product: 'Product',
          price: 29.99,
          images: ['https://example.com/img1.jpg'],
        };
        
        const result = await mapGroupToDraftWithTaxonomy(group);
        
        expect(result.sku).toMatch(/^VLBNP[a-z0-9]+$/i);
      });

      it('should limit SKU to 50 characters', async () => {
        const group = {
          brand: 'VeryLongBrandNameWithManyWords',
          product: 'VeryLongProductNameWithManyWords',
          price: 29.99,
          images: ['https://example.com/img1.jpg'],
        };
        
        const result = await mapGroupToDraftWithTaxonomy(group);
        
        expect(result.sku.length).toBeLessThanOrEqual(50);
      });
    });

    describe('Description generation', () => {
      it('should use GPT-generated description if available', async () => {
        const group = {
          brand: 'TestBrand',
          product: 'TestProduct',
          description: 'Custom GPT description with details',
          price: 29.99,
          images: ['https://example.com/img1.jpg'],
        };
        
        const result = await mapGroupToDraftWithTaxonomy(group);
        
        expect(result.inventory.product.description).toBe('Custom GPT description with details');
      });

      it('should build fallback description from title and variant', async () => {
        const group = {
          brand: 'TestBrand',
          product: 'TestProduct',
          variant: 'Blue',
          size: '100ml',
          price: 29.99,
          images: ['https://example.com/img1.jpg'],
        };
        
        const result = await mapGroupToDraftWithTaxonomy(group);
        
        expect(result.inventory.product.description).toContain('TestBrand TestProduct Blue 100ml');
        expect(result.inventory.product.description).toContain('Variant: Blue');
        expect(result.inventory.product.description).toContain('Size: 100ml');
      });

      it('should include claims in description', async () => {
        const group = {
          brand: 'TestBrand',
          product: 'TestProduct',
          claims: ['Feature 1', 'Feature 2', 'Feature 3'],
          price: 29.99,
          images: ['https://example.com/img1.jpg'],
        };
        
        const result = await mapGroupToDraftWithTaxonomy(group);
        
        expect(result.inventory.product.description).toContain('Key Features:');
        expect(result.inventory.product.description).toContain('• Feature 1');
        expect(result.inventory.product.description).toContain('• Feature 2');
        expect(result.inventory.product.description).toContain('• Feature 3');
      });

      it('should limit claims to 8 items', async () => {
        const group = {
          brand: 'TestBrand',
          product: 'TestProduct',
          claims: ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10'],
          price: 29.99,
          images: ['https://example.com/img1.jpg'],
        };
        
        const result = await mapGroupToDraftWithTaxonomy(group);
        
        const claimCount = (result.inventory.product.description.match(/•/g) || []).length;
        expect(claimCount).toBe(8);
      });

      it('should truncate description at 7000 characters', async () => {
        const longDescription = 'A'.repeat(8000);
        const group = {
          brand: 'TestBrand',
          product: 'TestProduct',
          description: longDescription,
          price: 29.99,
          images: ['https://example.com/img1.jpg'],
        };
        
        const result = await mapGroupToDraftWithTaxonomy(group);
        
        expect(result.inventory.product.description.length).toBeLessThanOrEqual(7000);
      });
    });

    describe('Image handling', () => {
      it('should normalize Dropbox URLs', async () => {
        const group = {
          brand: 'TestBrand',
          product: 'TestProduct',
          price: 29.99,
          images: ['https://www.dropbox.com/scl/fo/abc?dl=0'],
        };
        
        const result = await mapGroupToDraftWithTaxonomy(group);
        
        expect(result.inventory.product.imageUrls[0]).toBe('https://dl.dropboxusercontent.com/scl/fo/abc?raw=1');
      });

      it('should limit images to 12', async () => {
        const images = Array.from({ length: 20 }, (_, i) => `https://example.com/img${i}.jpg`);
        const group = {
          brand: 'TestBrand',
          product: 'TestProduct',
          price: 29.99,
          images,
        };
        
        const result = await mapGroupToDraftWithTaxonomy(group);
        
        expect(result.inventory.product.imageUrls.length).toBe(12);
      });

      it('should filter out invalid URLs', async () => {
        const group = {
          brand: 'TestBrand',
          product: 'TestProduct',
          price: 29.99,
          images: [
            'https://example.com/valid.jpg',
            'ftp://example.com/invalid.jpg',
            'not-a-url',
            '',
            '   ',
          ],
        };
        
        const result = await mapGroupToDraftWithTaxonomy(group);
        
        expect(result.inventory.product.imageUrls).toHaveLength(1);
        expect(result.inventory.product.imageUrls[0]).toBe('https://example.com/valid.jpg');
      });

      it('should handle non-Dropbox URLs unchanged', async () => {
        const group = {
          brand: 'TestBrand',
          product: 'TestProduct',
          price: 29.99,
          images: ['https://example.com/img1.jpg'],
        };
        
        const result = await mapGroupToDraftWithTaxonomy(group);
        
        expect(result.inventory.product.imageUrls[0]).toBe('https://example.com/img1.jpg');
      });
    });

    describe('Price handling', () => {
      it('should extract price from pricing.ebay and compute eBay price', async () => {
        const group = {
          brand: 'TestBrand',
          product: 'TestProduct',
          pricing: { ebay: 29.99 },
          images: ['https://example.com/img1.jpg'],
        };
        
        const result = await mapGroupToDraftWithTaxonomy(group);
        
        // Legacy pricing.ebay extracted as amazonItemPriceCents = 2999
        // Default settings: 10% discount, ALGO, templateShipping 600 cents
        // Target: $29.99 * 0.9 = $26.99
        // Subsidy: $6.00
        // eBay item price: $26.99 - $6.00 = $20.99
        expect(result.offer.price).toBe(20.99);
        expect(result._meta.price).toBe(20.99);
      });

      it('should use group.price as pre-computed eBay price when no priceMeta', async () => {
        const group = {
          brand: 'TestBrand',
          product: 'TestProduct',
          price: 35.50, // Pre-computed eBay price (publish mode)
          images: ['https://example.com/img1.jpg'],
        };
        
        const result = await mapGroupToDraftWithTaxonomy(group);
        
        // Should use price as-is (already computed during draft creation)
        // No discount or computation applied
        expect(result.offer.price).toBe(35.50);
      });

      it('should use pre-computed price as-is (no rounding)', async () => {
        const group = {
          brand: 'TestBrand',
          product: 'TestProduct',
          price: 29.999, // Pre-computed eBay price (publish mode)
          images: ['https://example.com/img1.jpg'],
        };
        
        const result = await mapGroupToDraftWithTaxonomy(group);
        
        // Should use price as-is (already computed during draft creation)
        expect(result.offer.price).toBe(29.999);
      });
    });

    describe('Condition mapping', () => {
      it('should map NEW to condition code 1000', async () => {
        mockPickCategoryForGroup.mockResolvedValue({
          id: '123',
          title: 'Test Category',
          slug: 'test-category',
          marketplaceId: 'EBAY_US',
          allowedConditions: [{ conditionId: '1000', displayName: 'New' }],
          defaults: { condition: 'NEW' },
        });

        const group = {
          brand: 'TestBrand',
          product: 'TestProduct',
          condition: 'NEW',
          price: 29.99,
          images: ['https://example.com/img1.jpg'],
        };
        
        const result = await mapGroupToDraftWithTaxonomy(group);
        
        expect(result.offer.condition).toBe(1000);
      });

      it('should map USED to condition code 3000', async () => {
        mockPickCategoryForGroup.mockResolvedValue({
          id: '123',
          title: 'Test Category',
          slug: 'test-category',
          marketplaceId: 'EBAY_US',
          allowedConditions: [{ conditionId: '3000', displayName: 'Used' }],
          defaults: { condition: 'USED' },
        });

        const group = {
          brand: 'TestBrand',
          product: 'TestProduct',
          condition: 'USED',
          price: 29.99,
          images: ['https://example.com/img1.jpg'],
        };
        
        const result = await mapGroupToDraftWithTaxonomy(group);
        
        expect(result.offer.condition).toBe(3000);
      });

      it('should map LIKE_NEW to 1500', async () => {
        mockPickCategoryForGroup.mockResolvedValue({
          id: '123',
          title: 'Test Category',
          slug: 'test-category',
          marketplaceId: 'EBAY_US',
          allowedConditions: [{ conditionId: '1500', displayName: 'Like New' }],
          defaults: { condition: 'LIKE_NEW' },
        });

        const group = {
          brand: 'TestBrand',
          product: 'TestProduct',
          condition: 'LIKE_NEW',
          price: 29.99,
          images: ['https://example.com/img1.jpg'],
        };
        
        const result = await mapGroupToDraftWithTaxonomy(group);
        
        expect(result.offer.condition).toBe(1500);
      });

      it('should fallback to NEW (1000) if condition not allowed', async () => {
        mockPickCategoryForGroup.mockResolvedValue({
          id: '123',
          title: 'Test Category',
          slug: 'test-category',
          marketplaceId: 'EBAY_US',
          allowedConditions: [
            { conditionId: '1000', displayName: 'New' },
            { conditionId: '3000', displayName: 'Used' },
          ],
          defaults: { condition: 'NEW' },
        });

        const group = {
          brand: 'TestBrand',
          product: 'TestProduct',
          condition: 'MANUFACTURER_REFURBISHED',
          price: 29.99,
          images: ['https://example.com/img1.jpg'],
        };
        
        const result = await mapGroupToDraftWithTaxonomy(group);
        
        expect(result.offer.condition).toBe(1000);
      });

      it('should fallback to USED (3000) if NEW not available', async () => {
        mockPickCategoryForGroup.mockResolvedValue({
          id: '123',
          title: 'Test Category',
          slug: 'test-category',
          marketplaceId: 'EBAY_US',
          allowedConditions: [
            { conditionId: '3000', displayName: 'Used' },
            { conditionId: '7000', displayName: 'For Parts' },
          ],
        });

        const group = {
          brand: 'TestBrand',
          product: 'TestProduct',
          condition: 'NEW',
          price: 29.99,
          images: ['https://example.com/img1.jpg'],
        };
        
        const result = await mapGroupToDraftWithTaxonomy(group);
        
        expect(result.offer.condition).toBe(3000);
      });

      it('should use first allowed condition as last resort', async () => {
        mockPickCategoryForGroup.mockResolvedValue({
          id: '123',
          title: 'Test Category',
          slug: 'test-category',
          marketplaceId: 'EBAY_US',
          allowedConditions: [
            { conditionId: '7000', displayName: 'For Parts' },
          ],
        });

        const group = {
          brand: 'TestBrand',
          product: 'TestProduct',
          condition: 'NEW',
          price: 29.99,
          images: ['https://example.com/img1.jpg'],
        };
        
        const result = await mapGroupToDraftWithTaxonomy(group);
        
        expect(result.offer.condition).toBe(7000);
      });
    });

    describe('Quantity derivation', () => {
      it('should use group quantity', async () => {
        const group = {
          brand: 'TestBrand',
          product: 'TestProduct',
          quantity: 5,
          price: 29.99,
          images: ['https://example.com/img1.jpg'],
        };
        
        const result = await mapGroupToDraftWithTaxonomy(group);
        
        expect(result.offer.quantity).toBe(5);
      });

      it('should fallback to qty field', async () => {
        const group = {
          brand: 'TestBrand',
          product: 'TestProduct',
          qty: 3,
          price: 29.99,
          images: ['https://example.com/img1.jpg'],
        };
        
        const result = await mapGroupToDraftWithTaxonomy(group);
        
        expect(result.offer.quantity).toBe(3);
      });

      it('should default to 1 if missing', async () => {
        const group = {
          brand: 'TestBrand',
          product: 'TestProduct',
          price: 29.99,
          images: ['https://example.com/img1.jpg'],
        };
        
        const result = await mapGroupToDraftWithTaxonomy(group);
        
        expect(result.offer.quantity).toBe(1);
      });

      it('should truncate fractional quantities', async () => {
        const group = {
          brand: 'TestBrand',
          product: 'TestProduct',
          quantity: 5.7,
          price: 29.99,
          images: ['https://example.com/img1.jpg'],
        };
        
        const result = await mapGroupToDraftWithTaxonomy(group);
        
        expect(result.offer.quantity).toBe(5);
      });

      it('should use category default if available', async () => {
        mockPickCategoryForGroup.mockResolvedValue({
          id: '123',
          title: 'Test Category',
          slug: 'test-category',
          marketplaceId: 'EBAY_US',
          defaults: { quantity: 10 },
        });

        const group = {
          brand: 'TestBrand',
          product: 'TestProduct',
          price: 29.99,
          images: ['https://example.com/img1.jpg'],
        };
        
        const result = await mapGroupToDraftWithTaxonomy(group);
        
        expect(result.offer.quantity).toBe(10);
      });
    });

    describe('Category and marketplace', () => {
      it('should use matched category', async () => {
        mockPickCategoryForGroup.mockResolvedValue({
          id: '12345',
          title: 'Health & Beauty',
          slug: 'health-beauty',
          marketplaceId: 'EBAY_US',
        });

        const group = {
          brand: 'TestBrand',
          product: 'TestProduct',
          price: 29.99,
          images: ['https://example.com/img1.jpg'],
        };
        
        const result = await mapGroupToDraftWithTaxonomy(group);
        
        expect(result.offer.categoryId).toBe('12345');
        expect(result._meta.categoryId).toBe('12345');
        expect(result._meta.selectedCategory).toEqual({
          id: '12345',
          title: 'Health & Beauty',
          slug: 'health-beauty',
        });
      });

      it('should use default category if no match', async () => {
        mockPickCategoryForGroup.mockResolvedValue(null);

        const group = {
          brand: 'TestBrand',
          product: 'TestProduct',
          price: 29.99,
          images: ['https://example.com/img1.jpg'],
        };
        
        const result = await mapGroupToDraftWithTaxonomy(group);
        
        expect(result.offer.categoryId).toBe('180959');
        expect(result._meta.selectedCategory).toBeNull();
      });

      it('should use matched marketplace', async () => {
        mockPickCategoryForGroup.mockResolvedValue({
          id: '12345',
          title: 'Test Category',
          slug: 'test-category',
          marketplaceId: 'EBAY_UK',
        });

        const group = {
          brand: 'TestBrand',
          product: 'TestProduct',
          price: 29.99,
          images: ['https://example.com/img1.jpg'],
        };
        
        const result = await mapGroupToDraftWithTaxonomy(group);
        
        expect(result.offer.marketplaceId).toBe('EBAY_UK');
        expect(result._meta.marketplaceId).toBe('EBAY_UK');
      });
    });

    describe('Policy IDs', () => {
      it('should use category default policy IDs', async () => {
        mockPickCategoryForGroup.mockResolvedValue({
          id: '12345',
          title: 'Test Category',
          slug: 'test-category',
          marketplaceId: 'EBAY_US',
          defaults: {
            fulfillmentPolicyId: 'fulfillment-123',
            paymentPolicyId: 'payment-456',
            returnPolicyId: 'return-789',
          },
        });

        const group = {
          brand: 'TestBrand',
          product: 'TestProduct',
          price: 29.99,
          images: ['https://example.com/img1.jpg'],
        };
        
        const result = await mapGroupToDraftWithTaxonomy(group);
        
        expect(result.offer.fulfillmentPolicyId).toBe('fulfillment-123');
        expect(result.offer.paymentPolicyId).toBe('payment-456');
        expect(result.offer.returnPolicyId).toBe('return-789');
      });

      it('should use environment variables as fallback', async () => {
        process.env.EBAY_FULFILLMENT_POLICY_ID = 'env-fulfillment';
        process.env.EBAY_PAYMENT_POLICY_ID = 'env-payment';
        process.env.EBAY_RETURN_POLICY_ID = 'env-return';
        
        mockPickCategoryForGroup.mockResolvedValue(null);

        const group = {
          brand: 'TestBrand',
          product: 'TestProduct',
          price: 29.99,
          images: ['https://example.com/img1.jpg'],
        };
        
        const result = await mapGroupToDraftWithTaxonomy(group);
        
        expect(result.offer.fulfillmentPolicyId).toBe('env-fulfillment');
        expect(result.offer.paymentPolicyId).toBe('env-payment');
        expect(result.offer.returnPolicyId).toBe('env-return');
        
        delete process.env.EBAY_FULFILLMENT_POLICY_ID;
        delete process.env.EBAY_PAYMENT_POLICY_ID;
        delete process.env.EBAY_RETURN_POLICY_ID;
      });
    });

    describe('Aspects integration', () => {
      it('should call buildItemSpecifics with matched category', async () => {
        const category = {
          id: '12345',
          title: 'Test Category',
          slug: 'test-category',
          marketplaceId: 'EBAY_US',
        };
        
        mockPickCategoryForGroup.mockResolvedValue(category);
        mockBuildItemSpecifics.mockReturnValue({ Brand: ['TestBrand'], Color: ['Blue'] });

        const group = {
          brand: 'TestBrand',
          product: 'TestProduct',
          price: 29.99,
          images: ['https://example.com/img1.jpg'],
        };
        
        await mapGroupToDraftWithTaxonomy(group);
        
        expect(mockBuildItemSpecifics).toHaveBeenCalledWith(category, group);
      });

      it('should call buildItemSpecifics with fallback category if no match', async () => {
        mockPickCategoryForGroup.mockResolvedValue(null);
        mockBuildItemSpecifics.mockReturnValue({ Brand: ['TestBrand'] });

        const group = {
          brand: 'TestBrand',
          product: 'TestProduct',
          price: 29.99,
          images: ['https://example.com/img1.jpg'],
        };
        
        await mapGroupToDraftWithTaxonomy(group);
        
        expect(mockBuildItemSpecifics).toHaveBeenCalledWith(
          expect.objectContaining({
            id: '180959',
            title: '',
            slug: '',
            marketplaceId: 'EBAY_US',
            itemSpecifics: [],
          }),
          group
        );
      });

      it('should track missing required aspects', async () => {
        mockBuildItemSpecifics.mockReturnValue({
          Brand: ['TestBrand'],
          RequiredField1: [],
          RequiredField2: [],
          OptionalField: ['Value'],
        });

        const group = {
          brand: 'TestBrand',
          product: 'TestProduct',
          price: 29.99,
          images: ['https://example.com/img1.jpg'],
        };
        
        const result = await mapGroupToDraftWithTaxonomy(group);
        
        expect(result._meta.missingRequired).toContain('RequiredField1');
        expect(result._meta.missingRequired).toContain('RequiredField2');
        expect(result._meta.missingRequired).not.toContain('Brand');
        expect(result._meta.missingRequired).not.toContain('OptionalField');
      });
    });

    describe('Complete draft structure', () => {
      it('should return complete draft structure', async () => {
        mockPickCategoryForGroup.mockResolvedValue({
          id: '12345',
          title: 'Test Category',
          slug: 'test-category',
          marketplaceId: 'EBAY_US',
        });

        mockBuildItemSpecifics.mockReturnValue({ Brand: ['TestBrand'] });

        const group = {
          brand: 'TestBrand',
          product: 'TestProduct',
          price: 29.99,
          images: ['https://example.com/img1.jpg'],
        };
        
        const result = await mapGroupToDraftWithTaxonomy(group);
        
        // Validate complete structure
        expect(result).toHaveProperty('sku');
        expect(result).toHaveProperty('inventory');
        expect(result).toHaveProperty('offer');
        expect(result).toHaveProperty('_meta');
        
        expect(result.inventory).toHaveProperty('condition');
        expect(result.inventory).toHaveProperty('product');
        expect(result.inventory.product).toHaveProperty('title');
        expect(result.inventory.product).toHaveProperty('description');
        expect(result.inventory.product).toHaveProperty('imageUrls');
        expect(result.inventory.product).toHaveProperty('aspects');
        
        expect(result.offer).toHaveProperty('sku');
        expect(result.offer).toHaveProperty('marketplaceId');
        expect(result.offer).toHaveProperty('categoryId');
        expect(result.offer).toHaveProperty('price');
        expect(result.offer).toHaveProperty('quantity');
        expect(result.offer).toHaveProperty('condition');
        expect(result.offer).toHaveProperty('description');
        
        expect(result._meta).toHaveProperty('selectedCategory');
        expect(result._meta).toHaveProperty('missingRequired');
        expect(result._meta).toHaveProperty('marketplaceId');
        expect(result._meta).toHaveProperty('categoryId');
        expect(result._meta).toHaveProperty('price');
      });

      it('should set SKU consistently across inventory and offer', async () => {
        const group = {
          brand: 'TestBrand',
          product: 'TestProduct',
          price: 29.99,
          images: ['https://example.com/img1.jpg'],
        };
        
        const result = await mapGroupToDraftWithTaxonomy(group);
        
        expect(result.sku).toBe(result.offer.sku);
        expect(result.sku).toBeTruthy();
      });
    });

    describe('Phase 3: Pricing with computeEbayItemPriceCents', () => {
      it('should compute offer.price using ALGO_COMPETITIVE_TOTAL strategy', async () => {
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
        
        // Default settings: 10% discount, ALGO, templateShipping 600 cents
        // Target: $57 * 0.9 = $51.30
        // Subsidy: $6.00
        // eBay item price: $51.30 - $6.00 = $45.30
        expect(result.offer.price).toBe(45.30);
        expect(result._meta.price).toBe(45.30);
      });

      it('should compute offer.price using default ALGO_COMPETITIVE_TOTAL strategy', async () => {
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
        
        // Default ALGO_COMPETITIVE_TOTAL: $57 * 0.9 = $51.30
        // Subsidy: $6.00
        // eBay item price: $51.30 - $6.00 = $45.30
        expect(result.offer.price).toBe(45.30);
      });

      it('should compute offer.price with Amazon shipping cost', async () => {
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
        
        // Target: ($57 + $5.99) * 0.9 = $56.69
        // Subsidy: $6.00
        // eBay item price: $56.69 - $6.00 = $50.69
        expect(result.offer.price).toBe(50.69);
      });

      it('should use group.price as pre-computed when priceMeta missing', async () => {
        const group = {
          brand: 'TestBrand',
          product: 'TestProduct',
          price: 57.00, // Pre-computed eBay price (publish mode)
          images: ['https://example.com/img1.jpg'],
        };
        
        const result = await mapGroupToDraftWithTaxonomy(group);
        
        // Should use price as-is (already computed during draft creation)
        // No discount or computation applied
        expect(result.offer.price).toBe(57.00);
      });

      it('should apply minimum item price floor', async () => {
        const group = {
          brand: 'TestBrand',
          product: 'TestProduct',
          images: ['https://example.com/img1.jpg'],
          priceMeta: {
            chosenSource: 'brand-msrp',
            basePrice: 1.00, // Very low price
            candidates: [
              {
                source: 'brand-msrp',
                price: 1.00,
                shippingCents: 0,
              },
            ],
          },
        };
        
        const result = await mapGroupToDraftWithTaxonomy(group);
        
        // Target: $1.00 * 0.9 = $0.90
        // Subsidy: $0.90 (capped at target)
        // eBay item price: would be $0, but clamped to minItemPriceCents (199 cents = $1.99)
        expect(result.offer.price).toBe(1.99);
      });

      it('should use pre-computed price when publishing draft (both price and priceMeta exist)', async () => {
        // PUBLISH SCENARIO: Draft already has computed price + original priceMeta
        // This happens when create-ebay-draft-user calls mapGroupToDraft with a draft object
        const group = {
          brand: 'TestBrand',
          product: 'TestProduct',
          images: ['https://example.com/img1.jpg'],
          price: 45.30, // Pre-computed draft price (already discounted)
          priceMeta: {
            chosenSource: 'brand-msrp',
            basePrice: 57.00, // Original retail price
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
        
        // Should use pre-computed price as-is, NOT recalculate from basePrice
        // If it recalculated: $57 * 0.9 = $51.30 - $6 = $45.30 (then again = $34.77)
        // Correct: use 45.30 directly without re-calculation
        expect(result.offer.price).toBe(45.30);
      });
    });
  });
});
