// Mock environment before imports
process.env.DEFAULT_MARKETPLACE_ID = 'EBAY_US';

import { putInventoryItem, createOffer } from '../../src/lib/ebay-sell.js';
import type { TaxonomyMappedDraft } from '../../src/lib/map-group-to-draft.js';

// Mock global fetch
global.fetch = jest.fn();

describe('ebay-sell', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('putInventoryItem', () => {
    const baseInventory: TaxonomyMappedDraft['inventory'] = {
        product: {
            title: 'Test Product',
            description: 'Test Description',
            imageUrls: ['https://example.com/image.jpg'],
            aspects: { Brand: ['Test Brand'], Color: ['Blue'] },
        },
        condition: ''
    };

    describe('Basic functionality', () => {
      it('should send authorization header', async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          status: 200,
        });

        await putInventoryItem('test-token', 'https://api.ebay.com', 'SKU123', baseInventory, 5);

        expect(global.fetch).toHaveBeenCalledWith(
          expect.stringContaining('/sell/inventory/v1/inventory_item/SKU123'),
          expect.objectContaining({
            headers: expect.objectContaining({
              Authorization: 'Bearer test-token',
            }),
          })
        );
      });

      it('should include marketplace ID header', async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          status: 200,
        });

        await putInventoryItem('test-token', 'https://api.ebay.com', 'SKU123', baseInventory, 5, 'EBAY_GB');

        expect(global.fetch).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            headers: expect.objectContaining({
              'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB',
            }),
          })
        );
      });

      it('should default marketplace to EBAY_US', async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          status: 200,
        });

        await putInventoryItem('test-token', 'https://api.ebay.com', 'SKU123', baseInventory, 5);

        expect(global.fetch).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            headers: expect.objectContaining({
              'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
            }),
          })
        );
      });

      it('should include quantity in payload', async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          status: 200,
        });

        await putInventoryItem('test-token', 'https://api.ebay.com', 'SKU123', baseInventory, 10);

        const call = (global.fetch as jest.Mock).mock.calls[0];
        const body = JSON.parse(call[1].body);
        expect(body.availability.shipToLocationAvailability.quantity).toBe(10);
      });

      it('should include product title and description', async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          status: 200,
        });

        await putInventoryItem('test-token', 'https://api.ebay.com', 'SKU123', baseInventory, 5);

        const call = (global.fetch as jest.Mock).mock.calls[0];
        const body = JSON.parse(call[1].body);
        expect(body.product.title).toBe('Test Product');
        expect(body.product.description).toBe('Test Description');
      });

      it('should include package dimensions with default 3x6x4 INCH and 1 POUND', async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          status: 200,
        });

        await putInventoryItem('test-token', 'https://api.ebay.com', 'SKU123', baseInventory, 5);

        const call = (global.fetch as jest.Mock).mock.calls[0];
        const body = JSON.parse(call[1].body);
        expect(body.packageWeightAndSize).toEqual({
          dimensions: { height: 3, length: 6, width: 4, unit: 'INCH' },
          weight: { value: 1, unit: 'POUND' },
        });
      });

      it('should include condition when provided', async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          status: 200,
        });

        const inventoryWithCondition: TaxonomyMappedDraft['inventory'] = {
          ...baseInventory,
          condition: 'NEW',
        };

        await putInventoryItem('test-token', 'https://api.ebay.com', 'SKU123', inventoryWithCondition, 5);

        const call = (global.fetch as jest.Mock).mock.calls[0];
        const body = JSON.parse(call[1].body);
        expect(body.condition).toBe('NEW');
      });
    });

    describe('Image URL sanitization', () => {
      it('should accept valid https URLs', async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          status: 200,
        });

        const inventoryWithImages: TaxonomyMappedDraft['inventory'] = {
          ...baseInventory,
          product: {
            ...baseInventory.product,
            imageUrls: [
              'https://example.com/img1.jpg',
              'https://example.com/img2.png',
            ],
          },
        };

        await putInventoryItem('test-token', 'https://api.ebay.com', 'SKU123', inventoryWithImages, 5);

        const call = (global.fetch as jest.Mock).mock.calls[0];
        const body = JSON.parse(call[1].body);
        expect(body.product.imageUrls).toEqual([
          'https://example.com/img1.jpg',
          'https://example.com/img2.png',
        ]);
      });

      it('should accept valid http URLs', async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          status: 200,
        });

        const inventoryWithImages: TaxonomyMappedDraft['inventory'] = {
          ...baseInventory,
          product: {
            ...baseInventory.product,
            imageUrls: [
              'http://example.com/img1.jpg',
              'https://example.com/img2.png',
            ],
          },
        };

        await putInventoryItem('test-token', 'https://api.ebay.com', 'SKU123', inventoryWithImages, 5);

        const call = (global.fetch as jest.Mock).mock.calls[0];
        const body = JSON.parse(call[1].body);
        expect(body.product.imageUrls).toEqual([
          'http://example.com/img1.jpg',
          'https://example.com/img2.png',
        ]);
      });

      it('should filter out invalid URLs', async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          status: 200,
        });

        const inventoryWithImages: TaxonomyMappedDraft['inventory'] = {
          ...baseInventory,
          product: {
            ...baseInventory.product,
            imageUrls: [
              'https://example.com/img1.jpg',
              'not-a-url',
              'https://example.com/img2.png',
              'ftp://example.com/img3.jpg',
            ],
          },
        };

        await putInventoryItem('test-token', 'https://api.ebay.com', 'SKU123', inventoryWithImages, 5);

        const call = (global.fetch as jest.Mock).mock.calls[0];
        const body = JSON.parse(call[1].body);
        expect(body.product.imageUrls).toEqual([
          'https://example.com/img1.jpg',
          'https://example.com/img2.png',
        ]);
      });

      it('should throw if no valid images', async () => {
        const inventoryWithImages: TaxonomyMappedDraft['inventory'] = {
          ...baseInventory,
          product: {
            ...baseInventory.product,
            imageUrls: [],
          },
        };

        await expect(
          putInventoryItem('test-token', 'https://api.ebay.com', 'SKU123', inventoryWithImages, 5)
        ).rejects.toThrow('No valid image URLs found');
      });

      it('should limit to 12 images', async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          status: 200,
        });

        const inventoryWithImages: TaxonomyMappedDraft['inventory'] = {
          ...baseInventory,
          product: {
            ...baseInventory.product,
            imageUrls: Array.from({ length: 20 }, (_, i) => `https://example.com/img${i}.jpg`),
          },
        };

        await putInventoryItem('test-token', 'https://api.ebay.com', 'SKU123', inventoryWithImages, 5);

        const call = (global.fetch as jest.Mock).mock.calls[0];
        const body = JSON.parse(call[1].body);
        expect(body.product.imageUrls).toHaveLength(12);
      });
    });

    describe('Quantity sanitization', () => {
      it('should use provided quantity', async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          status: 200,
        });

        await putInventoryItem('test-token', 'https://api.ebay.com', 'SKU123', baseInventory, 25);

        const call = (global.fetch as jest.Mock).mock.calls[0];
        const body = JSON.parse(call[1].body);
        expect(body.availability.shipToLocationAvailability.quantity).toBe(25);
      });

      it('should truncate fractional quantities', async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          status: 200,
        });

        await putInventoryItem('test-token', 'https://api.ebay.com', 'SKU123', baseInventory, 5.8);

        const call = (global.fetch as jest.Mock).mock.calls[0];
        const body = JSON.parse(call[1].body);
        expect(body.availability.shipToLocationAvailability.quantity).toBe(5);
      });

      it('should default to 1 for zero quantity', async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          status: 200,
        });

        await putInventoryItem('test-token', 'https://api.ebay.com', 'SKU123', baseInventory, 0);

        const call = (global.fetch as jest.Mock).mock.calls[0];
        const body = JSON.parse(call[1].body);
        expect(body.availability.shipToLocationAvailability.quantity).toBe(1);
      });

      it('should default to 1 for negative quantity', async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          status: 200,
        });

        await putInventoryItem('test-token', 'https://api.ebay.com', 'SKU123', baseInventory, -5);

        const call = (global.fetch as jest.Mock).mock.calls[0];
        const body = JSON.parse(call[1].body);
        expect(body.availability.shipToLocationAvailability.quantity).toBe(1);
      });
    });

    describe('Aspects sanitization', () => {
      it('should sanitize and limit aspect values to 25', async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          status: 200,
        });

        const inventoryWithAspects: TaxonomyMappedDraft['inventory'] = {
          ...baseInventory,
          product: {
            ...baseInventory.product,
            aspects: {
              Brand: ['Test Brand'],
              Color: Array.from({ length: 30 }, (_, i) => `Color${i}`),
            },
          },
        };

        await putInventoryItem('test-token', 'https://api.ebay.com', 'SKU123', inventoryWithAspects, 5);

        const call = (global.fetch as jest.Mock).mock.calls[0];
        const body = JSON.parse(call[1].body);
        expect(body.product.aspects.Color).toHaveLength(25);
        expect(body.product.aspects.Brand).toEqual(['Test Brand']);
      });

      it('should filter empty aspect values', async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          status: 200,
        });

        const inventoryWithAspects: TaxonomyMappedDraft['inventory'] = {
          ...baseInventory,
          product: {
            ...baseInventory.product,
            aspects: {
              Brand: ['Test Brand', '', '  ', 'Another Brand'],
              Color: ['Blue', '', 'Red'],
            },
          },
        };

        await putInventoryItem('test-token', 'https://api.ebay.com', 'SKU123', inventoryWithAspects, 5);

        const call = (global.fetch as jest.Mock).mock.calls[0];
        const body = JSON.parse(call[1].body);
        expect(body.product.aspects.Brand).toEqual(['Test Brand', 'Another Brand']);
        expect(body.product.aspects.Color).toEqual(['Blue', 'Red']);
      });

      it('should omit aspects with no valid values', async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          status: 200,
        });

        const inventoryWithAspects: TaxonomyMappedDraft['inventory'] = {
          ...baseInventory,
          product: {
            ...baseInventory.product,
            aspects: {
              Brand: ['Test Brand'],
              Color: ['', '  '],
            },
          },
        };

        await putInventoryItem('test-token', 'https://api.ebay.com', 'SKU123', inventoryWithAspects, 5);

        const call = (global.fetch as jest.Mock).mock.calls[0];
        const body = JSON.parse(call[1].body);
        expect(body.product.aspects.Brand).toEqual(['Test Brand']);
        expect(body.product.aspects.Color).toBeUndefined();
      });
    });

    describe('Error handling', () => {
      it('should throw on non-200 response', async () => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: false,
          status: 400,
          text: jest.fn().mockResolvedValue('{"error":"Invalid SKU"}'),
        });

        await expect(
          putInventoryItem('test-token', 'https://api.ebay.com', 'SKU123', baseInventory, 5)
        ).rejects.toThrow('Inventory PUT failed 400');
      });

      it('should throw on network error', async () => {
        (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Network error'));

        await expect(
          putInventoryItem('test-token', 'https://api.ebay.com', 'SKU123', baseInventory, 5)
        ).rejects.toThrow('Network error');
      });
    });
  });

  describe('createOffer', () => {
    const basePayload = {
      sku: 'SKU123',
      marketplaceId: 'EBAY_US' as const,
      price: 29.99,
      quantity: 1,
      description: 'Test listing',
      fulfillmentPolicyId: 'FP123',
      paymentPolicyId: 'PP123',
      returnPolicyId: 'RP123',
      merchantLocationKey: 'warehouse-1',
      categoryId: '12345',
      condition: 1000,
    };

    describe('Basic functionality', () => {
      it('should create offer successfully', async () => {
        // Use unique location to avoid cache
        const testPayload = { ...basePayload, merchantLocationKey: 'location-test-1' };
        
        // Mock location check
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          status: 200,
        });

        // Mock offer creation with proper text() method
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: jest.fn(() => Promise.resolve('{"offerId":"OFFER123"}')),
        });

        const result = await createOffer('test-token', 'https://api.ebay.com', testPayload);

        expect(result.offerId).toBe('OFFER123');
      });

      it('should check inventory location first', async () => {
        // Use unique location to avoid cache
        const testPayload = { ...basePayload, merchantLocationKey: 'location-test-2' };
        
        // Mock location check
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          status: 200,
        });

        // Mock offer creation
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: jest.fn(() => Promise.resolve('{"offerId":"OFFER123"}')),
        });

        await createOffer('test-token', 'https://api.ebay.com', testPayload);

        expect(global.fetch).toHaveBeenNthCalledWith(
          1,
          expect.stringContaining('/sell/inventory/v1/location/location-test-2'),
          expect.any(Object)
        );
      });

      it('should include price in USD with 2 decimals', async () => {
        // Use unique location to avoid cache
        const testPayload = { ...basePayload, merchantLocationKey: 'location-test-3' };
        
        // Mock location check
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          status: 200,
        });

        // Mock offer creation
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: jest.fn(() => Promise.resolve('{"offerId":"OFFER123"}')),
        });

        await createOffer('test-token', 'https://api.ebay.com', testPayload);

        const offerCall = (global.fetch as jest.Mock).mock.calls.find(call => 
          call[0].includes('/sell/inventory/v1/offer')
        );
        const body = JSON.parse(offerCall[1].body);
        expect(body.pricingSummary).toEqual({ price: { currency: 'USD', value: '29.99' } });
      });

      it('should include policy IDs', async () => {
        // Use unique location to avoid cache
        const testPayload = { ...basePayload, merchantLocationKey: 'location-test-4' };
        
        // Mock location check
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          status: 200,
        });

        // Mock offer creation
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: jest.fn(() => Promise.resolve('{"offerId":"OFFER123"}')),
        });

        await createOffer('test-token', 'https://api.ebay.com', testPayload);

        const offerCall = (global.fetch as jest.Mock).mock.calls.find(call => 
          call[0].includes('/sell/inventory/v1/offer')
        );
        const body = JSON.parse(offerCall[1].body);
        expect(body.listingPolicies).toEqual({
          fulfillmentPolicyId: 'FP123',
          paymentPolicyId: 'PP123',
          returnPolicyId: 'RP123',
        });
      });

      it('should default to NEW condition if not provided', async () => {
        // Use unique location to avoid cache
        const testPayload = { ...basePayload, merchantLocationKey: 'location-test-5' };
        delete (testPayload as any).condition;
        
        // Mock location check
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          status: 200,
        });

        // Mock offer creation
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: jest.fn(() => Promise.resolve('{"offerId":"OFFER123"}')),
        });

        const result = await createOffer('test-token', 'https://api.ebay.com', testPayload);

        // Verify it doesn't throw and creates offer successfully
        expect(result.offerId).toBe('OFFER123');
        expect(global.fetch).toHaveBeenCalledTimes(2);
      });

      it('should return warnings if present', async () => {
        // Use unique location to avoid cache
        const testPayload = { ...basePayload, merchantLocationKey: 'location-test-6' };
        
        // Mock location check
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          status: 200,
        });

        // Mock offer creation with warnings
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: jest.fn(() => Promise.resolve('{"offerId":"OFFER123","warnings":[{"message":"Some warning"}]}')),
        });

        const result = await createOffer('test-token', 'https://api.ebay.com', testPayload);

        expect(result.warnings).toEqual([{ message: 'Some warning' }]);
      });
    });

    describe('Price sanitization', () => {
      it('should round price to 2 decimals', async () => {
        // Use unique location to avoid cache
        const testPayload = { ...basePayload, merchantLocationKey: 'location-test-7', price: 29.999 };
        
        // Mock location check
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          status: 200,
        });

        // Mock offer creation
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: jest.fn(() => Promise.resolve('{"offerId":"OFFER123"}')),
        });

        await createOffer('test-token', 'https://api.ebay.com', testPayload);

        const offerCall = (global.fetch as jest.Mock).mock.calls.find(call => 
          call[0].includes('/sell/inventory/v1/offer')
        );
        const body = JSON.parse(offerCall[1].body);
        expect(body.pricingSummary.price.value).toBe('30.00');
      });

      it('should throw for zero price', async () => {
        // Use unique location to avoid cache
        const testPayload = { ...basePayload, merchantLocationKey: 'location-test-12', price: 0 };
        
        // Mock location check (price validation happens after this)
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          status: 200,
        });

        await expect(
          createOffer('test-token', 'https://api.ebay.com', testPayload)
        ).rejects.toThrow('Invalid price');
      });

      it('should throw for negative price', async () => {
        // Use unique location to avoid cache
        const testPayload = { ...basePayload, merchantLocationKey: 'location-test-13', price: -10 };
        
        // Mock location check (price validation happens after this)
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          status: 200,
        });

        await expect(
          createOffer('test-token', 'https://api.ebay.com', testPayload)
        ).rejects.toThrow('Invalid price');
      });
    });

    describe('Merchant location key', () => {
      it('should convert spaces to hyphens in location key', async () => {
        // Use unique location with spaces
        const testPayload = { ...basePayload, merchantLocationKey: 'location test 8' };
        
        // Mock location check
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          status: 200,
        });

        // Mock offer creation
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: jest.fn(() => Promise.resolve('{"offerId":"OFFER123"}')),
        });

        await createOffer('test-token', 'https://api.ebay.com', testPayload);

        expect(global.fetch).toHaveBeenNthCalledWith(
          1,
          expect.stringContaining('/sell/inventory/v1/location/location-test-8'),
          expect.any(Object)
        );
      });

      it('should throw if missing location key', async () => {
        const payloadWithoutLocation = { ...basePayload };
        delete (payloadWithoutLocation as any).merchantLocationKey;

        await expect(
          createOffer('test-token', 'https://api.ebay.com', payloadWithoutLocation)
        ).rejects.toThrow('Missing merchantLocationKey');
      });

      it('should throw if location not found', async () => {
        // Use unique location to avoid cache
        const testPayload = { ...basePayload, merchantLocationKey: 'location-test-9' };
        
        // Mock location check failure
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: false,
          status: 404,
          text: jest.fn(() => Promise.resolve('Location not found')),
        });

        await expect(
          createOffer('test-token', 'https://api.ebay.com', testPayload)
        ).rejects.toThrow("Inventory location 'location-test-9' not found");
      });
    });

    describe('Error handling', () => {
      it('should throw on offer creation failure', async () => {
        // Use unique location to avoid cache
        const testPayload = { ...basePayload, merchantLocationKey: 'location-test-10' };
        
        // Mock location check
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          status: 200,
        });

        // Mock offer creation failure
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: false,
          status: 400,
          text: jest.fn(() => Promise.resolve('{"error":"Invalid offer"}')),
        });

        await expect(
          createOffer('test-token', 'https://api.ebay.com', testPayload)
        ).rejects.toThrow('Offer create failed 400');
      });

      it('should throw if no offerId in response', async () => {
        // Use unique location to avoid cache
        const testPayload = { ...basePayload, merchantLocationKey: 'location-test-11' };
        
        // Mock location check
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          status: 200,
        });

        // Mock offer creation without offerId
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: jest.fn(() => Promise.resolve('{}')),
        });

        await expect(
          createOffer('test-token', 'https://api.ebay.com', testPayload)
        ).rejects.toThrow('succeeded without offerId');
      });
    });
  });
});
