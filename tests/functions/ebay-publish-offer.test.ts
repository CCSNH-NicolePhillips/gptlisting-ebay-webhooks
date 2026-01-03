/**
 * Unit tests for ebay-publish-offer.ts
 * Tests the auto-promotion logic that reads from policy-defaults
 */

import { jest } from '@jest/globals';

// Mock all dependencies BEFORE importing
jest.mock('@netlify/functions');
jest.mock('../../src/lib/_common.js', () => ({
  accessTokenFromRefresh: jest.fn(async () => ({ access_token: 'mock-access-token' })),
  tokenHosts: jest.fn(() => ({
    apiHost: 'https://api.sandbox.ebay.com',
    authHost: 'https://auth.sandbox.ebay.com',
  })),
}));

jest.mock('../../src/lib/_blobs.js', () => {
  const mockStore = {
    get: jest.fn(),
    set: jest.fn(),
  };
  return {
    tokensStore: jest.fn(() => mockStore),
  };
});

jest.mock('../../src/lib/_auth.js', () => ({
  getBearerToken: jest.fn(() => 'mock-bearer-token'),
  getJwtSubUnverified: jest.fn(() => 'user123'),
  requireAuthVerified: jest.fn(async () => ({ sub: 'user123' })),
  userScopedKey: jest.fn((sub: string, key: string) => `${sub}:${key}`),
}));

jest.mock('../../src/lib/promotion-queue.js', () => ({
  queuePromotionJob: jest.fn(async () => 'job-123'),
}));

jest.mock('../../src/lib/price-store.js', () => ({
  bindListing: jest.fn(async () => ({ ok: true })),
  getBindings: jest.fn(async () => []),
  removeBinding: jest.fn(async () => ({ ok: true })),
}));

// Mock global fetch
const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
global.fetch = mockFetch as any;

// Import mocked modules
import { tokensStore } from '../../src/lib/_blobs.js';
import { queuePromotionJob } from '../../src/lib/promotion-queue.js';

// Get mock store instance
const getMockStore = () => (tokensStore as jest.MockedFunction<typeof tokensStore>)() as any;

describe('ebay-publish-offer auto-promotion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
  });

  describe('policy-defaults integration', () => {
    it('should read autoPromote from policy-defaults.json', async () => {
      const mockStore = getMockStore();
      
      // Setup: User has auto-promote enabled in policy defaults
      mockStore.get.mockImplementation(async (key: string) => {
        if (key === 'user123:ebay.json') {
          return { refresh_token: 'mock-refresh-token' };
        }
        if (key === 'user123:policy-defaults.json') {
          return { autoPromote: true, defaultAdRate: 5 };
        }
        return null;
      });

      // Mock successful publish
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ listingId: '12345' }),
        } as Response)
        // Mock get offer
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ 
            sku: 'TEST-SKU-001', 
            listing: { listingId: '12345' },
            pricingSummary: { price: { value: '19.99', currency: 'USD' } }
          }),
        } as Response);

      // Import and call handler
      const { handler } = await import('../../netlify/functions/ebay-publish-offer.js');
      
      const event = {
        body: JSON.stringify({ offerId: 'offer-123' }),
        queryStringParameters: {},
        headers: { authorization: 'Bearer mock-token' },
      } as any;

      const result = await handler(event, {} as any);
      const body = JSON.parse(result?.body || '{}');

      // Should have queued promotion
      expect(queuePromotionJob).toHaveBeenCalledWith(
        'user123',
        '12345',
        5,
        expect.objectContaining({ sku: 'TEST-SKU-001' })
      );
      expect(body.promotion?.queued).toBe(true);
    });

    it('should use defaultAdRate from policy-defaults', async () => {
      const mockStore = getMockStore();
      
      mockStore.get.mockImplementation(async (key: string) => {
        if (key === 'user123:ebay.json') {
          return { refresh_token: 'mock-refresh-token' };
        }
        if (key === 'user123:policy-defaults.json') {
          return { autoPromote: true, defaultAdRate: 7.5 }; // Custom rate
        }
        return null;
      });

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ listingId: '12345' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ 
            sku: 'SKU-123',
            pricingSummary: { price: { value: '19.99', currency: 'USD' } }
          }),
        } as Response);

      const { handler } = await import('../../netlify/functions/ebay-publish-offer.js');
      
      const event = {
        body: JSON.stringify({ offerId: 'offer-456' }),
        queryStringParameters: {},
        headers: { authorization: 'Bearer mock-token' },
      } as any;

      await handler(event, {} as any);

      // Should use custom ad rate of 7.5
      expect(queuePromotionJob).toHaveBeenCalledWith(
        'user123',
        expect.any(String),
        7.5, // Custom rate from policy defaults
        expect.any(Object)
      );
    });

    it('should default to 5% ad rate if not specified in policy-defaults', async () => {
      const mockStore = getMockStore();
      
      mockStore.get.mockImplementation(async (key: string) => {
        if (key === 'user123:ebay.json') {
          return { refresh_token: 'mock-refresh-token' };
        }
        if (key === 'user123:policy-defaults.json') {
          return { autoPromote: true }; // No defaultAdRate specified
        }
        return null;
      });

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ listingId: '12345' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ 
            sku: 'SKU-789',
            pricingSummary: { price: { value: '19.99', currency: 'USD' } }
          }),
        } as Response);

      const { handler } = await import('../../netlify/functions/ebay-publish-offer.js');
      
      const event = {
        body: JSON.stringify({ offerId: 'offer-789' }),
        queryStringParameters: {},
        headers: { authorization: 'Bearer mock-token' },
      } as any;

      await handler(event, {} as any);

      // Should default to 5%
      expect(queuePromotionJob).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        5, // Default rate
        expect.any(Object)
      );
    });

    it('should NOT queue promotion if autoPromote is false', async () => {
      const mockStore = getMockStore();
      
      mockStore.get.mockImplementation(async (key: string) => {
        if (key === 'user123:ebay.json') {
          return { refresh_token: 'mock-refresh-token' };
        }
        if (key === 'user123:policy-defaults.json') {
          return { autoPromote: false, defaultAdRate: 10 };
        }
        return null;
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ listingId: '12345' }),
      } as Response);

      const { handler } = await import('../../netlify/functions/ebay-publish-offer.js');
      
      const event = {
        body: JSON.stringify({ offerId: 'offer-no-promo' }),
        queryStringParameters: {},
        headers: { authorization: 'Bearer mock-token' },
      } as any;

      const result = await handler(event, {} as any);
      const body = JSON.parse(result?.body || '{}');

      // Should NOT queue promotion
      expect(queuePromotionJob).not.toHaveBeenCalled();
      // promotion may be null or undefined when not queued
      expect(body.promotion == null || body.promotion?.queued === false).toBe(true);
    });

    it('should NOT queue promotion if policy-defaults.json is missing', async () => {
      const mockStore = getMockStore();
      
      mockStore.get.mockImplementation(async (key: string) => {
        if (key === 'user123:ebay.json') {
          return { refresh_token: 'mock-refresh-token' };
        }
        if (key === 'user123:policy-defaults.json') {
          return null; // No policy defaults saved
        }
        return null;
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ listingId: '12345' }),
      } as Response);

      const { handler } = await import('../../netlify/functions/ebay-publish-offer.js');
      
      const event = {
        body: JSON.stringify({ offerId: 'offer-no-defaults' }),
        queryStringParameters: {},
        headers: { authorization: 'Bearer mock-token' },
      } as any;

      await handler(event, {} as any);

      // Should NOT queue promotion
      expect(queuePromotionJob).not.toHaveBeenCalled();
    });

    it('should handle policy-defaults.json read error gracefully', async () => {
      const mockStore = getMockStore();
      
      mockStore.get.mockImplementation(async (key: string) => {
        if (key === 'user123:ebay.json') {
          return { refresh_token: 'mock-refresh-token' };
        }
        if (key === 'user123:policy-defaults.json') {
          throw new Error('Redis connection failed');
        }
        return null;
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ listingId: '12345' }),
      } as Response);

      const { handler } = await import('../../netlify/functions/ebay-publish-offer.js');
      
      const event = {
        body: JSON.stringify({ offerId: 'offer-error' }),
        queryStringParameters: {},
        headers: { authorization: 'Bearer mock-token' },
      } as any;

      const result = await handler(event, {} as any);
      const body = JSON.parse(result?.body || '{}');

      // Should still succeed (publish worked)
      expect(result?.statusCode).toBe(200);
      expect(body.ok).toBe(true);
      // Should NOT queue promotion
      expect(queuePromotionJob).not.toHaveBeenCalled();
    });
  });

  describe('promotion queueing', () => {
    it('should include listingId in promotion result', async () => {
      const mockStore = getMockStore();
      
      mockStore.get.mockImplementation(async (key: string) => {
        if (key === 'user123:ebay.json') {
          return { refresh_token: 'mock-refresh-token' };
        }
        if (key === 'user123:policy-defaults.json') {
          return { autoPromote: true, defaultAdRate: 5 };
        }
        return null;
      });

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ listingId: 'LISTING-ABC' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ 
            sku: 'SKU-001',
            pricingSummary: { price: { value: '19.99', currency: 'USD' } }
          }),
        } as Response);

      const { handler } = await import('../../netlify/functions/ebay-publish-offer.js');
      
      const event = {
        body: JSON.stringify({ offerId: 'offer-with-listing' }),
        queryStringParameters: {},
        headers: { authorization: 'Bearer mock-token' },
      } as any;

      const result = await handler(event, {} as any);
      const body = JSON.parse(result?.body || '{}');

      expect(body.promotion).toMatchObject({
        queued: true,
        listingId: 'LISTING-ABC',
        jobId: 'job-123',
        adRate: 5,
      });
    });

    it('should handle promotion queue failure gracefully', async () => {
      const mockStore = getMockStore();
      const mockQueuePromotion = queuePromotionJob as jest.MockedFunction<typeof queuePromotionJob>;
      mockQueuePromotion.mockRejectedValueOnce(new Error('Queue service unavailable'));
      
      mockStore.get.mockImplementation(async (key: string) => {
        if (key === 'user123:ebay.json') {
          return { refresh_token: 'mock-refresh-token' };
        }
        if (key === 'user123:policy-defaults.json') {
          return { autoPromote: true, defaultAdRate: 5 };
        }
        return null;
      });

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ listingId: '12345' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ 
            sku: 'SKU-001',
            pricingSummary: { price: { value: '19.99', currency: 'USD' } }
          }),
        } as Response);

      const { handler } = await import('../../netlify/functions/ebay-publish-offer.js');
      
      const event = {
        body: JSON.stringify({ offerId: 'offer-queue-fail' }),
        queryStringParameters: {},
        headers: { authorization: 'Bearer mock-token' },
      } as any;

      const result = await handler(event, {} as any);
      const body = JSON.parse(result?.body || '{}');

      // Publish should still succeed
      expect(result?.statusCode).toBe(200);
      expect(body.ok).toBe(true);
      // Promotion should show failure
      expect(body.promotion).toMatchObject({
        queued: false,
        error: 'Queue service unavailable',
      });
    });
  });

  describe('edge cases', () => {
    it('should handle missing listingId in publish response', async () => {
      const mockStore = getMockStore();
      
      mockStore.get.mockImplementation(async (key: string) => {
        if (key === 'user123:ebay.json') {
          return { refresh_token: 'mock-refresh-token' };
        }
        if (key === 'user123:policy-defaults.json') {
          return { autoPromote: true, defaultAdRate: 5 };
        }
        return null;
      });

      // Publish response missing listingId
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ success: true }),
        } as Response)
        // Get offer also missing listingId
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ 
            sku: 'SKU-001',
            pricingSummary: { price: { value: '19.99', currency: 'USD' } }
          }),
        } as Response);

      const { handler } = await import('../../netlify/functions/ebay-publish-offer.js');
      
      const event = {
        body: JSON.stringify({ offerId: 'offer-no-listing-id' }),
        queryStringParameters: {},
        headers: { authorization: 'Bearer mock-token' },
      } as any;

      const result = await handler(event, {} as any);
      const body = JSON.parse(result?.body || '{}');

      // Should still succeed but not queue promotion
      expect(result?.statusCode).toBe(200);
      expect(body.promotion).toMatchObject({
        queued: false,
        error: 'listingId not available',
      });
    });

    it('should handle get offer API failure when promotion enabled', async () => {
      const mockStore = getMockStore();
      
      mockStore.get.mockImplementation(async (key: string) => {
        if (key === 'user123:ebay.json') {
          return { refresh_token: 'mock-refresh-token' };
        }
        if (key === 'user123:policy-defaults.json') {
          return { autoPromote: true, defaultAdRate: 5 };
        }
        return null;
      });

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ listingId: '12345' }),
        } as Response)
        // Get offer fails
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: async () => 'Internal Server Error',
        } as Response);

      const { handler } = await import('../../netlify/functions/ebay-publish-offer.js');
      
      const event = {
        body: JSON.stringify({ offerId: 'offer-get-fail' }),
        queryStringParameters: {},
        headers: { authorization: 'Bearer mock-token' },
      } as any;

      const result = await handler(event, {} as any);
      const body = JSON.parse(result?.body || '{}');

      // Publish should still succeed
      expect(result?.statusCode).toBe(200);
      expect(body.ok).toBe(true);
      // But no promotion result since we couldn't get offer details
      expect(queuePromotionJob).not.toHaveBeenCalled();
    });
  });
});

// Import bindListing for auto-price tests
import { bindListing } from '../../src/lib/price-store.js';

describe('ebay-publish-offer auto-price reduction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
  });

  describe('minPriceType=fixed', () => {
    it('should create binding with fixed minPrice in dollars', async () => {
      const mockStore = getMockStore();
      const mockBindListing = bindListing as jest.MockedFunction<typeof bindListing>;
      
      mockStore.get.mockImplementation(async (key: string) => {
        if (key === 'user123:ebay.json') {
          return { refresh_token: 'mock-refresh-token' };
        }
        if (key === 'user123:settings.json') {
          return {
            autoPrice: {
              enabled: true,
              reduceBy: 100, // cents
              everyDays: 7,
              minPriceType: 'fixed',
              minPrice: 499, // $4.99 in cents
            }
          };
        }
        if (key === 'user123:policy-defaults.json') {
          return { autoPromote: false }; // Disable promotion to simplify test
        }
        return null;
      });

      // 1. Publish offer response
      // 2. Get offer for auto-promote check (even if autoPromote=false, it fetches)
      // 3. Get offer for auto-price
      const offerData = { 
        sku: 'SKU-001', 
        pricingSummary: { price: { value: '19.99' } },
        listing: { listingId: '12345' }
      };
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ listingId: '12345' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify(offerData),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify(offerData),
        } as Response);

      const { handler } = await import('../../netlify/functions/ebay-publish-offer.js');
      
      const event = {
        body: JSON.stringify({ offerId: 'offer-fixed-price' }),
        queryStringParameters: {},
        headers: { authorization: 'Bearer mock-token' },
      } as any;

      const result = await handler(event, {} as any);
      const body = JSON.parse(result?.body || '{}');

      // Should create binding with fixed $4.99 minPrice
      expect(mockBindListing).toHaveBeenCalledWith(
        expect.objectContaining({
          offerId: 'offer-fixed-price',
          currentPrice: 19.99,
          auto: expect.objectContaining({
            reduceBy: 1, // $1.00
            everyDays: 7,
            minPrice: 4.99, // Fixed $4.99
          }),
        })
      );
      
      expect(body.autoPrice).toMatchObject({
        enabled: true,
        currentPrice: 19.99,
        minPrice: 4.99,
        minPriceType: 'fixed',
      });
    });
  });

  describe('minPriceType=percent', () => {
    it('should calculate minPrice as percentage of listing price', async () => {
      const mockStore = getMockStore();
      const mockBindListing = bindListing as jest.MockedFunction<typeof bindListing>;
      
      mockStore.get.mockImplementation(async (key: string) => {
        if (key === 'user123:ebay.json') {
          return { refresh_token: 'mock-refresh-token' };
        }
        if (key === 'user123:settings.json') {
          return {
            autoPrice: {
              enabled: true,
              reduceBy: 100, // cents
              everyDays: 7,
              minPriceType: 'percent',
              minPercent: 50, // 50% of listing price
            }
          };
        }
        if (key === 'user123:policy-defaults.json') {
          return { autoPromote: false }; // Disable promotion to simplify test
        }
        return null;
      });

      const offerData24 = { 
        sku: 'SKU-002', 
        pricingSummary: { price: { value: '24.00' } },
        listing: { listingId: '12345' }
      };
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ listingId: '12345' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify(offerData24),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify(offerData24),
        } as Response);

      const { handler } = await import('../../netlify/functions/ebay-publish-offer.js');
      
      const event = {
        body: JSON.stringify({ offerId: 'offer-percent-price' }),
        queryStringParameters: {},
        headers: { authorization: 'Bearer mock-token' },
      } as any;

      const result = await handler(event, {} as any);
      const body = JSON.parse(result?.body || '{}');

      // 50% of $24.00 = $12.00
      expect(mockBindListing).toHaveBeenCalledWith(
        expect.objectContaining({
          offerId: 'offer-percent-price',
          currentPrice: 24.00,
          auto: expect.objectContaining({
            minPrice: 12.00, // 50% of $24.00
          }),
        })
      );
      
      expect(body.autoPrice).toMatchObject({
        enabled: true,
        currentPrice: 24.00,
        minPrice: 12.00,
        minPriceType: 'percent',
      });
    });

    it('should enforce $0.99 minimum floor when percentage is too low', async () => {
      const mockStore = getMockStore();
      const mockBindListing = bindListing as jest.MockedFunction<typeof bindListing>;
      
      mockStore.get.mockImplementation(async (key: string) => {
        if (key === 'user123:ebay.json') {
          return { refresh_token: 'mock-refresh-token' };
        }
        if (key === 'user123:settings.json') {
          return {
            autoPrice: {
              enabled: true,
              reduceBy: 50,
              everyDays: 3,
              minPriceType: 'percent',
              minPercent: 10, // 10% of $1.50 = $0.15 (too low!)
            }
          };
        }
        if (key === 'user123:policy-defaults.json') {
          return { autoPromote: false };
        }
        return null;
      });

      const offerDataLow = { 
        sku: 'SKU-LOW', 
        pricingSummary: { price: { value: '1.50' } },
        listing: { listingId: '12345' }
      };
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ listingId: '12345' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify(offerDataLow),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify(offerDataLow),
        } as Response);

      const { handler } = await import('../../netlify/functions/ebay-publish-offer.js');
      
      const event = {
        body: JSON.stringify({ offerId: 'offer-low-percent' }),
        queryStringParameters: {},
        headers: { authorization: 'Bearer mock-token' },
      } as any;

      const result = await handler(event, {} as any);
      const body = JSON.parse(result?.body || '{}');

      // 10% of $1.50 = $0.15, but min floor is $0.99
      expect(mockBindListing).toHaveBeenCalledWith(
        expect.objectContaining({
          auto: expect.objectContaining({
            minPrice: 0.99, // Enforced minimum
          }),
        })
      );
      
      expect(body.autoPrice?.minPrice).toBe(0.99);
    });

    it('should use default 50% if minPercent is not specified', async () => {
      const mockStore = getMockStore();
      const mockBindListing = bindListing as jest.MockedFunction<typeof bindListing>;
      
      mockStore.get.mockImplementation(async (key: string) => {
        if (key === 'user123:ebay.json') {
          return { refresh_token: 'mock-refresh-token' };
        }
        if (key === 'user123:settings.json') {
          return {
            autoPrice: {
              enabled: true,
              reduceBy: 100,
              everyDays: 7,
              minPriceType: 'percent',
              // minPercent not specified - should default to 50
            }
          };
        }
        if (key === 'user123:policy-defaults.json') {
          return { autoPromote: false };
        }
        return null;
      });

      const offerDataDefault = { 
        sku: 'SKU-DEFAULT', 
        pricingSummary: { price: { value: '30.00' } },
        listing: { listingId: '12345' }
      };
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ listingId: '12345' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify(offerDataDefault),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify(offerDataDefault),
        } as Response);

      const { handler } = await import('../../netlify/functions/ebay-publish-offer.js');
      
      const event = {
        body: JSON.stringify({ offerId: 'offer-default-percent' }),
        queryStringParameters: {},
        headers: { authorization: 'Bearer mock-token' },
      } as any;

      await handler(event, {} as any);

      // Default 50% of $30.00 = $15.00
      expect(mockBindListing).toHaveBeenCalledWith(
        expect.objectContaining({
          auto: expect.objectContaining({
            minPrice: 15.00,
          }),
        })
      );
    });
  });

  describe('default behavior', () => {
    it('should default to fixed minPrice when minPriceType not specified', async () => {
      const mockStore = getMockStore();
      const mockBindListing = bindListing as jest.MockedFunction<typeof bindListing>;
      
      mockStore.get.mockImplementation(async (key: string) => {
        if (key === 'user123:ebay.json') {
          return { refresh_token: 'mock-refresh-token' };
        }
        if (key === 'user123:settings.json') {
          return {
            autoPrice: {
              enabled: true,
              reduceBy: 100,
              everyDays: 7,
              minPrice: 299, // $2.99 in cents
              // minPriceType not specified - should default to 'fixed'
            }
          };
        }
        if (key === 'user123:policy-defaults.json') {
          return { autoPromote: false };
        }
        return null;
      });

      const offerDataLegacy = { 
        sku: 'SKU-LEGACY', 
        pricingSummary: { price: { value: '15.00' } },
        listing: { listingId: '12345' }
      };
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ listingId: '12345' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify(offerDataLegacy),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify(offerDataLegacy),
        } as Response);

      const { handler } = await import('../../netlify/functions/ebay-publish-offer.js');
      
      const event = {
        body: JSON.stringify({ offerId: 'offer-legacy' }),
        queryStringParameters: {},
        headers: { authorization: 'Bearer mock-token' },
      } as any;

      const result = await handler(event, {} as any);
      const body = JSON.parse(result?.body || '{}');

      // Should use fixed $2.99 (legacy behavior)
      expect(mockBindListing).toHaveBeenCalledWith(
        expect.objectContaining({
          auto: expect.objectContaining({
            minPrice: 2.99,
          }),
        })
      );
      
      expect(body.autoPrice?.minPriceType).toBe('fixed');
    });

    it('should NOT create binding when autoPrice is disabled', async () => {
      const mockStore = getMockStore();
      const mockBindListing = bindListing as jest.MockedFunction<typeof bindListing>;
      
      mockStore.get.mockImplementation(async (key: string) => {
        if (key === 'user123:ebay.json') {
          return { refresh_token: 'mock-refresh-token' };
        }
        if (key === 'user123:settings.json') {
          return {
            autoPrice: {
              enabled: false,
            }
          };
        }
        return null;
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ listingId: '12345' }),
      } as Response);

      const { handler } = await import('../../netlify/functions/ebay-publish-offer.js');
      
      const event = {
        body: JSON.stringify({ offerId: 'offer-disabled' }),
        queryStringParameters: {},
        headers: { authorization: 'Bearer mock-token' },
      } as any;

      const result = await handler(event, {} as any);
      const body = JSON.parse(result?.body || '{}');

      // Should NOT create binding
      expect(mockBindListing).not.toHaveBeenCalled();
      expect(body.autoPrice).toBeNull();
    });
  });
});
