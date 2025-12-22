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
          text: async () => JSON.stringify({ sku: 'TEST-SKU-001', listing: { listingId: '12345' } }),
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
          text: async () => JSON.stringify({ sku: 'SKU-123' }),
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
          text: async () => JSON.stringify({ sku: 'SKU-789' }),
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
          text: async () => JSON.stringify({ sku: 'SKU-001' }),
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
          text: async () => JSON.stringify({ sku: 'SKU-001' }),
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
          text: async () => JSON.stringify({ sku: 'SKU-001' }),
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
